"""Entry point for the openlanelink game state machine / compute-node API.

Runs the FastAPI/uvicorn ASGI server (api.py) as the process's main event
loop. Mesh connectivity is no longer owned by this process directly --
that's ../uart_bridge's job now, running as its own systemd-managed
process. This process is instead an HTTP/WebSocket client of it
(bridge_client.py): outbound commands (cycle/rerack/score) are synchronous
POSTs, and inbound sensor events are consumed off the bridge's WS /events
feed on a background asyncio task started in _lifespan() below. Because
that task runs on the same event loop uvicorn owns (unlike the old
in-process UartBridge, which read serial on its own thread), the callbacks
below can await api.broadcast_state()/broadcast_event() directly -- no
thread-safe handoff needed anymore.

Nodes are dumb: they emit raw sensor events and accept commands relevant to
their own function, nothing more -- they know nothing about each other beyond
the gateway. Event timing/scheduling (e.g. pairing a speed node's
upstream/downstream beam breaks into a ball speed) is this Pi bridge's job,
not firmware's -- see on_beam_event() below. See firmware/HANDOFF.md.
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager

import api
import protocol
import speed
import state_machine
from bridge_client import BridgeClient

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("scoring")

# Base URL of the standalone UART bridge service (../uart_bridge). Same
# host by default -- both processes are meant to run on the same Pi.
UART_BRIDGE_URL = os.environ.get("UART_BRIDGE_URL", "http://localhost:8100")
API_HOST = "0.0.0.0"
API_PORT = 8000

# After the downstream speed beam, wait this long before assuming the ball
# has reached the pins and settled, then snap a photo. TUNE ON REAL HARDWARE.
PHOTO_COOLDOWN_S = 2.5

# If the downstream beam doesn't break within this long after the upstream
# beam, abandon the pairing (debris, hand-wave, false trigger) rather than
# reporting a bogus multi-second "speed". Was firmware state on the speed
# node; now lives here since timing/scheduling is the Pi bridge's job.
SPEED_TIMEOUT_S = 3.0

# lane_number -> (upstream event's timestamp_ms, Pi-local time.monotonic() it arrived)
_pending_upstream: dict[int, tuple[int, float]] = {}

bridge = BridgeClient(UART_BRIDGE_URL)


async def on_lane_event(ev):
    log.info("LaneEvent: %s", ev)
    if ev.event_type != protocol.EVENT_FOUL:
        return  # CLEAR is informational only, nothing to act on

    machine = state_machine.get_machine(ev.lane_number, bridge)
    try:
        machine.on_foul()
    except state_machine.InvalidTransitionError as e:
        log.warning("Lane %s: %s", ev.lane_number, e)
        return
    await api.broadcast_state(ev.lane_number)


async def on_beam_event(ev):
    log.info("BeamEvent: %s", ev)
    if ev.event_type != protocol.EVENT_BEAM_BROKEN:
        return  # only the BROKEN edge matters for timing; CLEAR is informational

    machine = state_machine.get_machine(ev.lane_number, bridge)

    if ev.beam_role == protocol.ROLE_BALL_DETECT:
        # A ball_detect_node's near-pins beam. Same "ball reached the pins"
        # meaning as the downstream case below, but handled first and
        # returned early on purpose: it has no pairing partner, so it must
        # NOT touch _pending_upstream. Falling through would pop a speed
        # node's pending upstream reading and turn it into a fabricated mph
        # figure measured over the wrong beam spacing entirely. See
        # protocol.py's ROLE_BALL_DETECT.
        machine.on_ball_detected()
        await api.broadcast_state(ev.lane_number)
        return

    if ev.beam_role == protocol.ROLE_UPSTREAM:
        _pending_upstream[ev.lane_number] = (ev.timestamp_ms, time.monotonic())
        machine.on_upstream_beam()
        await api.broadcast_state(ev.lane_number)
        return

    # The ball reached the pins regardless of whether a speed can also be
    # computed for it below, so drive the state machine first -- the speed
    # pairing that follows can still bail out early on a missing/expired
    # upstream reading without that affecting AWAITING_PINFALL.
    machine.on_downstream_beam()
    await api.broadcast_state(ev.lane_number)

    pending = _pending_upstream.pop(ev.lane_number, None)
    if pending is None:
        log.warning("Lane %s: downstream beam broke with no pending upstream, ignored", ev.lane_number)
        return

    upstream_ts_ms, received_at = pending
    if time.monotonic() - received_at > SPEED_TIMEOUT_S:
        log.warning("Lane %s: speed timing timed out, discarding", ev.lane_number)
        return

    interval_ms = ev.timestamp_ms - upstream_ts_ms
    mph = speed.interval_to_mph(interval_ms)
    log.info("Lane %s ball speed: interval=%dms (%.1f mph)", ev.lane_number, interval_ms, mph)
    await api.broadcast_event(ev.lane_number, "ball_speed", {"mph": round(mph, 1), "intervalMs": interval_ms})
    # Vision is a fully standalone process from this one's point of view --
    # it decides for itself when to capture (see vision/README.md) and its
    # only relationship to this process is reporting a resulting pinfall
    # count via POST /api/lanes/{lane}/pinfall (api.py), the same call that
    # already handles recording the ball and sending cycle/rerack. This
    # process does not trigger or otherwise know about vision at all.


async def on_status_event(ev):
    log.info("StatusEvent: %s", ev)
    if ev.lane_number == 0:
        # Node-level status (STATUS_HEARTBEAT, STATUS_RELAY_FAULT,
        # STATUS_ALL_ACK, STATUS_MACHINE_STATUS, STATUS_DI_CHANGE -- see
        # firmware/PROTOCOL.md's laneNumber note) isn't about any one lane,
        # so it must never reach get_machine()/get_lane() -- doing so would
        # silently create a phantom "lane 0" machine, exactly the kind of
        # cross-lane bleed the state machine is supposed to prevent.
        return

    machine = state_machine.get_machine(ev.lane_number, bridge)
    # Always None today -- see protocol.py's StatusEvent docstring for why
    # -- but cross-checking costs nothing and needs no changes here once
    # uart_bridge starts actually sending it.
    if ev.ball_number is not None:
        machine.reconcile_ball_number(ev.ball_number)
    if ev.status_code != protocol.STATUS_CYCLE_COMPLETE:
        return  # other per-lane status codes (relay ack, pulse ack, ...) not acted on yet
    machine.on_cycle_complete()
    await api.broadcast_state(ev.lane_number)


_bridge_task: asyncio.Task | None = None


@asynccontextmanager
async def _lifespan(_app):
    global _bridge_task
    api.app.state.bridge = bridge
    _bridge_task = asyncio.create_task(
        bridge.run(on_lane_event=on_lane_event, on_beam_event=on_beam_event, on_status_event=on_status_event)
    )
    log.info("Scoring node running, UART bridge client targeting %s", UART_BRIDGE_URL)
    yield
    _bridge_task.cancel()
    bridge.close()


# Assigned post-construction rather than passed to FastAPI(lifespan=...) in
# api.py, since main.py (not api.py) owns bridge start/stop -- api.py stays
# importable/testable on its own without a live BridgeClient.
api.app.router.lifespan_context = _lifespan


def main():
    import uvicorn

    uvicorn.run(api.app, host=API_HOST, port=API_PORT)


if __name__ == "__main__":
    main()
