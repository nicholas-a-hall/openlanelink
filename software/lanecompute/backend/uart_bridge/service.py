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
import peer_registry
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
registry = peer_registry.PeerRegistry()


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


# ---- peer registry callbacks (also on the read thread) ----
def on_node_seen(ev) -> None:
    """A node tried to register with the gateway. Recorded whether it was
    accepted or refused -- the refusals are the point, since a node silently
    turned away is otherwise invisible from the lane."""
    changed = registry.record_sighting(ev.mac, ev.node_type, ev.status, ev.timestamp_ms)
    if changed:
        _broadcast({
            "type": "nodeSeen",
            "mac": ev.mac,
            "nodeType": ev.node_type,
            "nodeTypeName": peer_registry.NODE_TYPE_NAMES.get(ev.node_type, "unknown"),
            "status": ev.status,
            "statusName": peer_registry.STATUS_NAMES.get(ev.status, "unknown"),
            "timestampMs": ev.timestamp_ms,
        })


def on_peer_table_ack(ack) -> None:
    registry.record_gateway_ack(ack.generation, ack.count)


def push_peer_table(target=None) -> bool:
    """Send the allowlist to the gateway. Used both after an operator change
    and on every serial (re)connect, so a gateway that rebooted while we
    weren't attached converges without needing a handshake."""
    target = target or link
    if target is None or not target.connected:
        log.warning("cannot push peer table -- gateway link is down; it will be re-pushed on reconnect")
        return False
    target.send_peer_table(registry.generation, registry.allowed())
    return True


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
        "peers": {
            "allowed": len(registry.allowed()),
            "pending": len(registry.pending()),
            "generation": registry.generation,
            "gatewayGeneration": registry.gateway_generation,
            # False means an allowlist edit hasn't reached the gateway. The
            # symptom otherwise is a node still being refused after an
            # operator allowed it, with nothing to explain why.
            "inSync": registry.gateway_generation == registry.generation,
        },
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


# ---- peer registry: who is allowed on this gateway's mesh ----
# The Pi owns the allowlist; the gateway caches and enforces it. See
# peer_registry.py for why the authority sits here rather than on the gateway.


@app.get("/peers")
async def list_peers():
    """Every MAC this gateway has ever reported, allowed or not, plus whether
    our allowlist generation matches what the gateway says it applied."""
    return registry.snapshot()


@app.get("/peers/pending")
async def list_pending_peers():
    """Seen on the mesh but not allowed -- the operator's work queue.

    A MAC lands here for one of two reasons and they look identical from the
    Pi: it's a node of this pair that hasn't been provisioned yet, or it's a
    neighbouring pair's node that was flashed with this gateway's MAC. Nothing
    in software can tell those apart, which is exactly why allowing is a
    human decision rather than something auto-accepted on first sighting."""
    return {"pending": registry.pending()}


class PeerAllowBody(BaseModel):
    # Only needed for a MAC that has never been seen (pre-provisioning a node
    # before it is powered on). For anything in /peers/pending the type is
    # already known from its registration attempt.
    node_type: int | None = None


@app.post("/peers/{mac}/allow")
async def allow_peer(mac: str, body: PeerAllowBody = PeerAllowBody()):
    try:
        normalized = peer_registry.format_mac(peer_registry.parse_mac(mac))
        entry = registry.allow(normalized, body.node_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"{mac} has never been seen -- pass node_type to pre-provision it",
        )
    pushed = push_peer_table()
    return {"ok": True, "mac": normalized, "entry": entry,
            "generation": registry.generation, "pushed": pushed}


@app.post("/peers/{mac}/deny")
async def deny_peer(mac: str):
    """Revokes a MAC. The gateway drops it as an ESP-NOW peer AND starts
    ignoring its inbound frames, so this takes effect without waiting for the
    node to reboot."""
    try:
        normalized = peer_registry.format_mac(peer_registry.parse_mac(mac))
        entry = registry.deny(normalized)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no peer {mac}")
    pushed = push_peer_table()
    return {"ok": True, "mac": normalized, "entry": entry,
            "generation": registry.generation, "pushed": pushed}


@app.delete("/peers/{mac}")
async def forget_peer(mac: str):
    """Drops a MAC from the registry entirely. Only meaningful for a node
    that is gone for good -- one that's still powered on simply reappears on
    its next 10s re-announce."""
    try:
        normalized = peer_registry.format_mac(peer_registry.parse_mac(mac))
        registry.forget(normalized)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"no peer {mac}")
    pushed = push_peer_table()
    return {"ok": True, "generation": registry.generation, "pushed": pushed}


@app.post("/peers/push")
async def push_peers():
    """Force a re-push of the allowlist. Normally unnecessary -- it happens on
    every change and every reconnect -- but useful when /health reports
    inSync=false."""
    if not push_peer_table():
        raise HTTPException(status_code=503, detail="UART bridge not connected to gateway")
    return {"ok": True, "generation": registry.generation}


class DebugNodeSeenBody(BaseModel):
    mac: str
    node_type: int = 0
    status: int = peer_registry.NODE_UNGOVERNED


@app.post("/debug/node-seen")
async def debug_node_seen(body: DebugNodeSeenBody):
    """Bench/dev only: inject a synthetic registration sighting exactly as a
    real UART_NODE_SEEN frame would produce, with no hardware attached --
    mirrors /debug/beam-event. Touches nothing on the serial link."""
    try:
        normalized = peer_registry.format_mac(peer_registry.parse_mac(body.mac))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    ev = p.NodeSeenEvent(normalized, body.node_type, body.status, int(time.monotonic() * 1000) % (2 ** 32))
    log.info("injecting synthetic NodeSeenEvent: %s", ev)
    on_node_seen(ev)
    return {"ok": True, "injected": {"mac": ev.mac, "nodeType": ev.node_type, "status": ev.status}}
