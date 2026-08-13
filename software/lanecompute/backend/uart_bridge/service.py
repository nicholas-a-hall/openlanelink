"""REST + WebSocket surface for the standalone UART bridge service.

Wraps serial_link.SerialLink -- the only thing in this process that talks
to the gateway ESP32 -- so it can run as its own systemd-managed OS
process, decoupled from the game state machine (see ../state_machine and
README.md). GET /health is the contract other processes use to verify this
service is reachable and whether it's actually hearing from the gateway,
not just alive.

`link` is set by main.py after construction (mirroring
../state_machine/api.py's app.state.bridge pattern) rather than built at
import time, so this module stays importable/testable without a real
serial port.
"""

import asyncio
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

import lane_map
import protocol as p

log = logging.getLogger(__name__)

# No frame heard within this long while the port is open is treated as
# "stale" even though uartConnected is still true -- the pinsetter's own
# heartbeat status repeats roughly every 5s (see firmware/ESPNOW.md), so a
# couple of missed beats past that means the gateway or the mesh has gone
# quiet, not just an idle lane between balls.
STALE_AFTER_S = 15.0

_start_time = time.monotonic()
_loop: asyncio.AbstractEventLoop | None = None
_ws_clients: set[WebSocket] = set()

link = None  # SerialLink, set via set_link() by main.py before the app starts


def set_link(serial_link) -> None:
    global link
    link = serial_link


@asynccontextmanager
async def _lifespan(_app):
    global _loop
    _loop = asyncio.get_running_loop()
    if link is not None:
        link.start()
    yield
    if link is not None:
        link.stop()


app = FastAPI(title="openlanelink UART bridge", version="0.1.0", lifespan=_lifespan)


def _broadcast(message: dict) -> None:
    if _loop is None:
        log.warning("event loop not ready yet, dropping broadcast")
        return
    asyncio.run_coroutine_threadsafe(_broadcast_async(message), _loop)


async def _broadcast_async(message: dict) -> None:
    dead = []
    for ws in _ws_clients:
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _ws_clients.discard(ws)


# ---- SerialLink callbacks (fire on its background read thread; main.py
# wires these into the SerialLink constructor) ----
#
# THIS IS WHERE SIDES BECOME LANE NUMBERS. Frames arrive off the mesh tagged
# with a lane SIDE (the mesh has no lane numbers at all -- see lane_map.py);
# everything downstream of this service, from state_machine to vision to the
# UI, speaks real lane numbers. Translating here rather than there is what
# let the mesh drop lane numbers without a single change to any consumer:
# the /events payloads below are byte-for-byte the same shape they were.


def on_lane_event(ev) -> None:
    lane = lane_map.lane_for_side(ev.lane_side)
    if lane is None:
        # A foul-line edge that names no side is meaningless -- there's no
        # sensible lane to attribute it to, so publishing it would invent
        # one. Drop it loudly instead.
        log.warning("dropping LaneEvent with unmapped side %s: %s", ev.lane_side, ev)
        return
    _broadcast({"type": "laneEvent", "eventType": ev.event_type, "laneNumber": lane, "timestampMs": ev.timestamp_ms})


def on_beam_event(ev) -> None:
    lane = lane_map.lane_for_side(ev.lane_side)
    if lane is None:
        log.warning("dropping BeamEvent with unmapped side %s: %s", ev.lane_side, ev)
        return
    _broadcast({"type": "beamEvent", "eventType": ev.event_type, "laneNumber": lane, "beamRole": ev.beam_role, "timestampMs": ev.timestamp_ms})


def on_status_event(ev) -> None:
    # Unlike sensor edges, a status event with NO side is completely normal:
    # STATUS_HEARTBEAT, STATUS_RELAY_FAULT, STATUS_ALL_ACK,
    # STATUS_MACHINE_STATUS, and STATUS_DI_CHANGE all describe the pinsetter
    # BOARD rather than one of its machines (see firmware/PROTOCOL.md). Those
    # keep crossing as laneNumber 0, which is exactly the sentinel
    # ../state_machine/main.py's on_status_event() already checks for before
    # it would otherwise conjure a phantom "lane 0" machine.
    lane = lane_map.lane_for_side(ev.lane_side)
    _broadcast({"type": "statusEvent", "statusCode": ev.status_code, "laneNumber": lane or 0, "ballNumber": ev.ball_number, "timestampMs": ev.timestamp_ms})


# ---- health ----
@app.get("/health")
async def health():
    """Always returns 200 while this process is up -- that alone answers
    "can the state machine reach the bridge service." uartConnected/stale
    answer the separate question of whether the gateway link itself is
    good; a client should treat a 200 with uartConnected=false or
    stale=true as "bridge process fine, mesh link degraded", not as a
    process-level failure.

    laneSides reports which real lanes this bridge maps its pair's A and B
    sides to (see lane_map.py). It's here because that mapping exists
    nowhere else in the system -- the mesh doesn't carry lane numbers and
    the gateway doesn't know them -- so without exposing it, a bridge
    pointed at the wrong pair looks completely healthy while sending every
    command to the wrong lanes. It must agree with state_machine's
    LANE_NUMBERS; nothing cross-checks that automatically."""
    now = time.monotonic()
    last = link.last_frame_at if link else None
    connected = bool(link and link.connected)
    stale = connected and (last is None or now - last > STALE_AFTER_S)
    return {
        "status": "ok",
        "uartConnected": connected,
        "stale": stale,
        "laneSides": lane_map.describe(),
        "port": link.port if link else None,
        "baud": link.baud if link else None,
        "lastFrameAgoS": None if last is None else round(now - last, 1),
        "uptimeS": round(now - _start_time, 1),
    }


# ---- inbound mesh events, streamed to any subscriber ----
@app.websocket("/events")
async def events(websocket: WebSocket):
    await websocket.accept()
    _ws_clients.add(websocket)
    try:
        while True:
            # Read-only: nothing a client sends is acted on. Commands go
            # through the REST routes below. We just keep the connection
            # open and notice when it drops.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(websocket)


def _require_link() -> None:
    if link is None or not link.connected:
        raise HTTPException(status_code=503, detail="UART bridge not connected to gateway")


# ---- outbound mesh commands ----
class PinsetterCommandBody(BaseModel):
    command: int
    lane_number: int
    cycle_count: int = 1  # only meaningful for CMD_CYCLE/CMD_RERACK, see protocol.py


@app.post("/commands/pinsetter")
async def send_pinsetter_command(body: PinsetterCommandBody):
    _require_link()
    link.send_pinsetter_command(body.command, body.lane_number, body.cycle_count)
    return {"ok": True}


class LaneBody(BaseModel):
    lane_number: int
    cycle_count: int = 1


@app.post("/commands/cycle")
async def cycle(body: LaneBody):
    _require_link()
    link.send_cycle(body.lane_number, body.cycle_count)
    return {"ok": True}


class RerackBody(BaseModel):
    lane_number: int
    cycle_count: int = 2  # matches SerialLink.send_rerack()'s own safe default


@app.post("/commands/rerack")
async def rerack(body: RerackBody):
    _require_link()
    link.send_rerack(body.lane_number, body.cycle_count)
    return {"ok": True}


class ScoreEventBody(BaseModel):
    lane_number: int
    ball_number: int
    pinfall_mask: int
    timestamp_ms: int


@app.post("/commands/score-event")
async def score_event(body: ScoreEventBody):
    _require_link()
    link.send_score_event(body.lane_number, body.ball_number, body.pinfall_mask, body.timestamp_ms)
    return {"ok": True}


# ---- bench-only event injection ----
class DebugBeamEventBody(BaseModel):
    lane_number: int
    beam_role: int = p.ROLE_DOWNSTREAM
    event_type: int = p.EVENT_BEAM_BROKEN


@app.post("/debug/beam-event")
async def debug_beam_event(body: DebugBeamEventBody):
    """Bench/dev only: publish a synthetic BeamEvent on the /events feed
    exactly as a real decoded frame would, WITHOUT any hardware attached.
    Touches nothing on the serial link -- it only broadcasts, so the
    gateway/mesh never sees it and no pinsetter command results.

    Exists because a ball-at-the-pins beam break is the trigger every
    beam-driven consumer keys off (../vision's self-triggered capture, see
    its bridge_client.py; state_machine's BALL_IN_FLIGHT/AWAITING_PINFALL
    transitions), and until a real speed_node/ball_detect_node is wired up
    there is no way to exercise those paths end to end at all. Defaults
    match "a ball just reached the pins" (downstream beam, BROKEN edge),
    which is the case worth replaying most often -- pass
    beam_role=ROLE_BALL_DETECT (2) instead to replay a ball_detect_node's
    near-pins beam, which every consumer treats the same way except
    state_machine's speed pairing (see protocol.py's ROLE_BALL_DETECT).

    Takes a lane NUMBER for the caller's convenience but converts it to a
    side and builds a genuine side-tagged BeamEvent, so the injected event
    travels the same lane -> side -> lane path a real frame does rather than
    short-circuiting past lane_map. That makes this endpoint a usable check
    of the mapping itself: inject lane 7, and if the feed doesn't publish
    lane 7 back, the mapping is wrong."""
    side = lane_map.side_for_lane(body.lane_number)
    if side is None or side == p.SIDE_NONE:
        raise HTTPException(
            status_code=400,
            detail=f"lane {body.lane_number} is not on this pair -- this bridge covers {lane_map.describe()}",
        )
    ev = p.BeamEvent(body.event_type, side, body.beam_role, int(time.monotonic() * 1000) % (2 ** 32))
    log.info("injecting synthetic BeamEvent: %s (lane %s -> side %s)", ev, body.lane_number, side)
    on_beam_event(ev)
    return {"ok": True, "injected": {"eventType": ev.event_type, "laneNumber": body.lane_number, "laneSide": side, "beamRole": ev.beam_role, "timestampMs": ev.timestamp_ms}}
