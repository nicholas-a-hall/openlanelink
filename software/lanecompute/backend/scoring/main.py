"""Entry point for the openlanelink scoring/compute node.

Runs the FastAPI/uvicorn ASGI server (api.py) as the process's main event
loop, and starts the UartBridge (uart_bridge.py) as a background thread
alongside it. The bridge's callbacks fire on that background thread --
pyserial's blocking reads don't have a clean async story here -- so pushing
a WebSocket broadcast from them needs a thread-safe handoff onto the asyncio
loop uvicorn owns: asyncio.run_coroutine_threadsafe() is that handoff, see
_schedule_broadcast() below.

Nodes are dumb: they emit raw sensor events and accept commands relevant to
their own function, nothing more -- they know nothing about each other beyond
the gateway. Event timing/scheduling (e.g. pairing a speed node's
upstream/downstream beam breaks into a ball speed) is this Pi bridge's job,
not firmware's -- see on_beam_event() below. See firmware/HANDOFF.md.
"""

import asyncio
import logging
import time
from contextlib import asynccontextmanager

import api
import protocol
import speed
from uart_bridge import UartBridge

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("scoring")

PI_UART_PORT = "/dev/serial0"  # TODO: confirm against the actual Pi wiring
PI_UART_BAUD = 115200
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

# Set once uvicorn's event loop is running (see _startup). The UartBridge's
# background thread reads this to schedule broadcasts.
_loop: asyncio.AbstractEventLoop | None = None


def _schedule_broadcast(coro) -> None:
    """Thread-safe handoff from the UartBridge's background thread onto the
    asyncio event loop uvicorn owns. No-op (with a warning) if called before
    the server has started -- shouldn't happen since the bridge only starts
    inside _startup(), after _loop is set."""
    if _loop is None:
        log.warning("event loop not ready yet, dropping broadcast")
        return
    asyncio.run_coroutine_threadsafe(coro, _loop)


def on_lane_event(ev):
    log.info("LaneEvent: %s", ev)
    # TODO: feed fouls into game state.


def on_beam_event(ev):
    log.info("BeamEvent: %s", ev)
    if ev.event_type != protocol.EVENT_BEAM_BROKEN:
        return  # only the BROKEN edge matters for timing; CLEAR is informational

    if ev.beam_role == protocol.ROLE_UPSTREAM:
        _pending_upstream[ev.lane_number] = (ev.timestamp_ms, time.monotonic())
        return

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
    _schedule_broadcast(
        api.broadcast_event(ev.lane_number, "ball_speed", {"mph": round(mph, 1), "intervalMs": interval_ms})
    )
    # TODO: PHOTO_COOLDOWN_S after this, trigger a capture on the vision/
    # daemon for ev.lane_number -- that's a SEPARATE, un-Dockerized process
    # with direct camera access (see vision/README.md), not something this
    # process calls into directly. Integration mechanism not decided yet.
    # Once a pinfall result comes back (however that ends up happening),
    # this is the place to score it and:
    #   bridge.send_score_event(ev.lane_number, ball_number, pinfall_mask, timestamp_ms)
    #   bridge.send_cycle(ev.lane_number)


bridge = UartBridge(
    PI_UART_PORT,
    PI_UART_BAUD,
    on_lane_event=on_lane_event,
    on_beam_event=on_beam_event,
)


@asynccontextmanager
async def _lifespan(_app):
    global _loop
    _loop = asyncio.get_running_loop()
    api.app.state.bridge = bridge
    bridge.start()
    log.info("Scoring node running, UART bridge up on %s @ %d baud", PI_UART_PORT, PI_UART_BAUD)
    yield
    bridge.stop()


# Assigned post-construction rather than passed to FastAPI(lifespan=...) in
# api.py, since main.py (not api.py) owns bridge start/stop -- api.py stays
# importable/testable on its own without a live UartBridge.
api.app.router.lifespan_context = _lifespan


def main():
    import uvicorn

    uvicorn.run(api.app, host=API_HOST, port=API_PORT)


if __name__ == "__main__":
    main()
