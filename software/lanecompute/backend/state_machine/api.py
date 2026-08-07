"""REST + WebSocket API for the compute node.

Exposes lanelink mesh functionality (pinsetter commands) and this node's
authoritative game state to the React UI *and* any external programmatic
automation. REST is the single command interface for both -- there is never
a second way to issue the same action over WebSocket, which is deliberately
read-only: a live broadcast of lane state/events to /ws/display/{lane}
(overhead monitors) and /ws/control/{lane} (bowler tablets). Both routes get
an identical feed; tablets are just additionally allowed to hit the REST
command surface, which any other client (a script, a third-party
integration) can hit exactly the same way.

See PROTOCOL.md for the mesh command set this passes through to the
gateway, and game_state.py for the scoring engine this is a thin HTTP
wrapper around. main.py wires app.state.bridge to a live BridgeClient (an
HTTP/WebSocket client of the standalone ../uart_bridge service, see its
README.md) at startup; without it, mesh-facing endpoints 503.
"""

import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import assistance
import game_state
import game_types
import state_machine

log = logging.getLogger(__name__)

# The two lanes this compute node covers -- must match the paired gateway's
# lane-pair scope (see firmware/HANDOFF.md's lane-preset design principle).
VALID_LANES = (7, 8)

app = FastAPI(title="openlanelink compute node API", version="0.1.0")

# Wide open, no credentials: kiosk tablets/overhead monitors hit this from
# whatever host/port they're served on (dev Vite server, a future
# nginx-fronted kiosk build, ...) and there's no session/cookie auth to leak
# -- this service already treats "anyone on the lane's network" as trusted,
# same as any script hitting the REST surface directly (see module
# docstring). allow_credentials stays False; combining it with a wildcard
# origin isn't even legal per the CORS spec.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _require_valid_lane(lane: int) -> None:
    if lane not in VALID_LANES:
        raise HTTPException(status_code=404, detail=f"lane {lane} not served by this compute node")


def _bridge():
    bridge = getattr(app.state, "bridge", None)
    if bridge is None:
        raise HTTPException(status_code=503, detail="UART bridge not configured")
    if not bridge.connected:
        raise HTTPException(status_code=503, detail="UART bridge not connected to gateway")
    return bridge


def _bridge_object():
    """Unlike _bridge(), doesn't require a live connection -- game-state
    mutations (starting a game, recording a ball) work without hardware
    attached; only the mesh command a ball's turnOver triggers actually
    needs one, and BridgeClient.send_cycle/send_rerack already no-op
    safely (log + drop) when disconnected."""
    return getattr(app.state, "bridge", None)


def _lane_snapshot(lane: int) -> dict:
    data = game_state.get_lane(lane).snapshot()
    data.update(state_machine.get_machine(lane, _bridge_object()).snapshot())
    return data


# ---- WebSocket broadcast ----
class ConnectionManager:
    def __init__(self):
        self._connections: dict[int, set[WebSocket]] = {}

    async def connect(self, lane: int, ws: WebSocket) -> None:
        await ws.accept()
        self._connections.setdefault(lane, set()).add(ws)

    def disconnect(self, lane: int, ws: WebSocket) -> None:
        self._connections.get(lane, set()).discard(ws)

    async def broadcast(self, lane: int, message: dict) -> None:
        dead = []
        for ws in self._connections.get(lane, set()):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(lane, ws)


manager = ConnectionManager()


# Both broadcast_state and broadcast_event are public (no leading
# underscore) -- main.py calls them directly for mesh-originated events
# (fouls, beam pairing, pinsetter status, ball speed) that drive
# state_machine.py and mutate game_state outside of a REST handler, not just
# this module's own routes below.
async def broadcast_state(lane: int) -> None:
    await manager.broadcast(lane, {"type": "state", "lane": lane, "data": _lane_snapshot(lane)})


async def broadcast_event(lane: int, event: str, data: dict) -> None:
    await manager.broadcast(lane, {"type": "event", "lane": lane, "event": event, "data": data})


async def _serve_broadcast_socket(websocket: WebSocket, lane: int) -> None:
    if lane not in VALID_LANES:
        await websocket.close(code=4404)
        return
    await manager.connect(lane, websocket)
    # Send current state immediately so a new client isn't waiting on the
    # next mutation to see anything.
    await websocket.send_json({"type": "state", "lane": lane, "data": _lane_snapshot(lane)})
    try:
        while True:
            # Read-only: nothing the client sends is acted on. Commands go
            # through REST. We just keep the connection open and notice when
            # it drops.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(lane, websocket)


@app.websocket("/ws/display/{lane}")
async def ws_display(websocket: WebSocket, lane: int):
    await _serve_broadcast_socket(websocket, lane)


@app.websocket("/ws/control/{lane}")
async def ws_control(websocket: WebSocket, lane: int):
    await _serve_broadcast_socket(websocket, lane)


# ---- Mesh-facing commands ----
@app.post("/api/lanes/{lane}/pinsetter/cycle")
async def cycle_pinsetter(lane: int):
    _require_valid_lane(lane)
    _bridge().send_cycle(lane)
    await broadcast_event(lane, "pinsetter_cycle_requested", {})
    return {"ok": True}


@app.post("/api/lanes/{lane}/pinsetter/rerack")
async def rerack_pinsetter(lane: int):
    _require_valid_lane(lane)
    _bridge().send_rerack(lane)
    await broadcast_event(lane, "pinsetter_rerack_requested", {})
    return {"ok": True}


# ---- Game-state commands ----
class BowlerCreate(BaseModel):
    name: str


class BowlerUpdate(BaseModel):
    name: str


class ScoreEdit(BaseModel):
    frame_number: int
    ball_in_frame: int
    pinfall: int


@app.get("/api/lanes/{lane}")
async def get_lane_snapshot(lane: int):
    _require_valid_lane(lane)
    return _lane_snapshot(lane)


@app.post("/api/lanes/{lane}/bowlers")
async def add_bowler(lane: int, body: BowlerCreate):
    _require_valid_lane(lane)
    bowler = game_state.get_lane(lane).add_bowler(body.name)
    await broadcast_state(lane)
    return {"id": bowler.id, "name": bowler.name}


@app.put("/api/lanes/{lane}/bowlers/{bowler_id}")
async def edit_bowler(lane: int, bowler_id: str, body: BowlerUpdate):
    _require_valid_lane(lane)
    try:
        bowler = game_state.get_lane(lane).edit_bowler(bowler_id, body.name)
    except game_state.UnknownBowlerError:
        raise HTTPException(status_code=404, detail=f"no bowler {bowler_id} on lane {lane}")
    await broadcast_state(lane)
    return {"id": bowler.id, "name": bowler.name}


@app.delete("/api/lanes/{lane}/bowlers/{bowler_id}")
async def remove_bowler(lane: int, bowler_id: str):
    _require_valid_lane(lane)
    try:
        game_state.get_lane(lane).remove_bowler(bowler_id)
    except game_state.UnknownBowlerError:
        raise HTTPException(status_code=404, detail=f"no bowler {bowler_id} on lane {lane}")
    await broadcast_state(lane)
    return {"ok": True}


class GameCreate(BaseModel):
    game_type: str = "ten_pin"


@app.post("/api/lanes/{lane}/games")
async def add_game(lane: int, body: GameCreate = GameCreate()):
    _require_valid_lane(lane)
    try:
        gt = game_types.get_game_type(body.game_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    game = game_state.get_lane(lane).add_game(gt)
    state_machine.get_machine(lane, _bridge_object()).begin_game()
    await broadcast_state(lane)
    return {"id": game.id, "startedAtMs": game.started_at_ms, "gameType": gt.name}


@app.post("/api/lanes/{lane}/reset")
async def reset_lane(lane: int):
    """Full wipe: clears the bowler roster AND the game, back to a blank
    IDLE lane -- for turning a lane over to a new party. NOT how a lane
    starts its next game with the people already checked in; that's
    POST .../games again, which keeps the roster on purpose (see
    game_state.LaneState.add_game()'s docstring) -- this endpoint exists
    specifically to override that persistence when a lane really is done
    with its current bowlers."""
    _require_valid_lane(lane)
    game_state.get_lane(lane).reset()
    state_machine.get_machine(lane, _bridge_object()).reset()
    await broadcast_state(lane)
    return _lane_snapshot(lane)


@app.put("/api/lanes/{lane}/bowlers/{bowler_id}/score")
async def edit_score(lane: int, bowler_id: str, body: ScoreEdit):
    _require_valid_lane(lane)
    try:
        game_state.get_lane(lane).edit_score(bowler_id, body.frame_number, body.ball_in_frame, body.pinfall)
    except game_state.UnknownBowlerError:
        raise HTTPException(status_code=404, detail=f"no bowler {bowler_id} on lane {lane}")
    except (ValueError, IndexError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    await broadcast_state(lane)
    return game_state.get_lane(lane).frames(bowler_id)


class PinfallObserved(BaseModel):
    # Exactly one of these two, not both -- see on_pinfall_observed()'s
    # docstring. pinfall: manual entry, a plain count, no per-pin detail.
    # standing_mask: vision's raw "which pins are standing right now" (bit
    # N-1 = pin N), no memory of any earlier capture -- this endpoint (via
    # state_machine) derives the count/fallen-mask itself by diffing
    # against whatever's already been recorded so far this frame.
    pinfall: int | None = None
    standing_mask: int | None = None


@app.post("/api/lanes/{lane}/pinfall")
async def report_pinfall(lane: int, body: PinfallObserved):
    """Pinfall entry -- both manual entry (a bowler tablet or staff UI)
    and ../vision/pinfall.py go through this same endpoint and the same
    state_machine.on_pinfall_observed() hook, just with different bodies
    (see PinfallObserved above). NOT gated on the lane already being
    AWAITING_PINFALL (i.e. beam events aren't a prerequisite) -- see
    on_pinfall_observed()'s docstring for why; this is trusted as ground
    truth that a ball was thrown regardless of whatever beam/cycle events
    did or didn't arrive first. Still not a free-form "add a ball"
    endpoint though: a 409 means there's no active game/bowler on this
    lane, and a 400 means this bowler's game is already complete, neither
    pinfall nor standing_mask was given, or (standing_mask path) an
    earlier ball this frame has no per-pin detail to diff against."""
    _require_valid_lane(lane)
    machine = state_machine.get_machine(lane, _bridge_object())
    try:
        machine.on_pinfall_observed(body.pinfall, body.standing_mask)
    except state_machine.InvalidTransitionError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await broadcast_state(lane)
    return _lane_snapshot(lane)


# ---- Mesh sensor events, exposed as real endpoints ----
# main.py's bridge_client.BridgeClient callbacks (on_lane_event/
# on_beam_event/on_status_event) call these same state_machine.py methods
# directly today, translating events consumed off the UART bridge service's
# WS /events feed. But the state machine itself only exposes these as
# Python methods, with no REST surface at all -- meaning anything that
# ISN'T the real UART bridge (a simulation script, a future alternate
# sensor integration) had no way to drive lane state through the one path
# everything else in this API already uses. These close that gap: the UART
# bridge is just one caller translating hardware events into state-machine
# calls; it shouldn't be the only one.

class BeamObserved(BaseModel):
    role: str  # "upstream" | "downstream"


@app.post("/api/lanes/{lane}/beam")
async def report_beam(lane: int, body: BeamObserved):
    """Beam-sensor edge -- stands in for a speed node's MSG_BEAM_EVENT once
    it's paired and forwarded here (main.py's on_beam_event does the same
    thing for the real hardware path, plus speed-pairing math this endpoint
    doesn't attempt). Drives READY -> BALL_IN_FLIGHT -> AWAITING_PINFALL."""
    _require_valid_lane(lane)
    machine = state_machine.get_machine(lane, _bridge_object())
    if body.role == "upstream":
        machine.on_upstream_beam()
    elif body.role == "downstream":
        machine.on_downstream_beam()
    else:
        raise HTTPException(status_code=400, detail=f"unknown beam role {body.role!r}, expected upstream/downstream")
    await broadcast_state(lane)
    return _lane_snapshot(lane)


@app.post("/api/lanes/{lane}/foul")
async def report_foul(lane: int):
    """Foul-line sensor edge -- stands in for a fouling node's
    MSG_LANE_EVENT{LANE_FOUL} (main.py's on_lane_event does the same for the
    real hardware path). Records a 0-pinfall ball without sending a
    pinsetter command -- the gateway already auto-reracks on every foul, see
    state_machine.py's on_foul."""
    _require_valid_lane(lane)
    machine = state_machine.get_machine(lane, _bridge_object())
    try:
        machine.on_foul()
    except state_machine.InvalidTransitionError as e:
        raise HTTPException(status_code=409, detail=str(e))
    await broadcast_state(lane)
    return _lane_snapshot(lane)


@app.post("/api/lanes/{lane}/cycle-complete")
async def report_cycle_complete(lane: int):
    """Pinsetter finished its cycle/rerack -- stands in for the gateway
    forwarding the pinsetter's MSG_STATUS{STATUS_CYCLE_COMPLETE}
    (main.py's on_status_event does the same for the real hardware path).
    Drives PINSETTER_BUSY -> READY (or GAME_COMPLETE)."""
    _require_valid_lane(lane)
    state_machine.get_machine(lane, _bridge_object()).on_cycle_complete()
    await broadcast_state(lane)
    return _lane_snapshot(lane)


# ---- Isolated: request assistance (separate from game state -- see assistance.py) ----
class AssistanceRequestBody(BaseModel):
    reason: Optional[str] = None


@app.post("/api/lanes/{lane}/assistance")
async def create_assistance_request(lane: int, body: AssistanceRequestBody):
    _require_valid_lane(lane)
    req = assistance.request_assistance(lane, body.reason)
    await broadcast_event(lane, "assistance_requested", {"reason": req.reason})
    return {"id": req.id, "requestedAtMs": req.requested_at_ms}
