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
wrapper around. main.py wires app.state.bridge to a live UartBridge at
startup; without it, mesh-facing endpoints 503.
"""

import logging
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

import assistance
import game_state

log = logging.getLogger(__name__)

# The two lanes this compute node covers -- must match the paired gateway's
# lane-pair scope (see firmware/HANDOFF.md's lane-preset design principle).
VALID_LANES = (7, 8)

app = FastAPI(title="openlanelink compute node API", version="0.1.0")


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


async def _broadcast_state(lane: int) -> None:
    await manager.broadcast(lane, {"type": "state", "lane": lane, "data": game_state.get_lane(lane).snapshot()})


# Public (no leading underscore) -- main.py also calls this directly for
# mesh-originated events (e.g. ball speed) that don't come through a REST
# mutation. _broadcast_state above stays internal to this module's own
# route handlers, which are the only things that mutate game_state.
async def broadcast_event(lane: int, event: str, data: dict) -> None:
    await manager.broadcast(lane, {"type": "event", "lane": lane, "event": event, "data": data})


async def _serve_broadcast_socket(websocket: WebSocket, lane: int) -> None:
    if lane not in VALID_LANES:
        await websocket.close(code=4404)
        return
    await manager.connect(lane, websocket)
    # Send current state immediately so a new client isn't waiting on the
    # next mutation to see anything.
    await websocket.send_json({"type": "state", "lane": lane, "data": game_state.get_lane(lane).snapshot()})
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
    ball_index: int
    pinfall: int


@app.get("/api/lanes/{lane}")
async def get_lane_snapshot(lane: int):
    _require_valid_lane(lane)
    return game_state.get_lane(lane).snapshot()


@app.post("/api/lanes/{lane}/bowlers")
async def add_bowler(lane: int, body: BowlerCreate):
    _require_valid_lane(lane)
    bowler = game_state.get_lane(lane).add_bowler(body.name)
    await _broadcast_state(lane)
    return {"id": bowler.id, "name": bowler.name}


@app.put("/api/lanes/{lane}/bowlers/{bowler_id}")
async def edit_bowler(lane: int, bowler_id: str, body: BowlerUpdate):
    _require_valid_lane(lane)
    try:
        bowler = game_state.get_lane(lane).edit_bowler(bowler_id, body.name)
    except game_state.UnknownBowlerError:
        raise HTTPException(status_code=404, detail=f"no bowler {bowler_id} on lane {lane}")
    await _broadcast_state(lane)
    return {"id": bowler.id, "name": bowler.name}


@app.delete("/api/lanes/{lane}/bowlers/{bowler_id}")
async def remove_bowler(lane: int, bowler_id: str):
    _require_valid_lane(lane)
    try:
        game_state.get_lane(lane).remove_bowler(bowler_id)
    except game_state.UnknownBowlerError:
        raise HTTPException(status_code=404, detail=f"no bowler {bowler_id} on lane {lane}")
    await _broadcast_state(lane)
    return {"ok": True}


@app.post("/api/lanes/{lane}/games")
async def add_game(lane: int):
    _require_valid_lane(lane)
    game = game_state.get_lane(lane).add_game()
    await _broadcast_state(lane)
    return {"id": game.id, "startedAtMs": game.started_at_ms}


@app.put("/api/lanes/{lane}/bowlers/{bowler_id}/score")
async def edit_score(lane: int, bowler_id: str, body: ScoreEdit):
    _require_valid_lane(lane)
    try:
        game_state.get_lane(lane).edit_score(bowler_id, body.ball_index, body.pinfall)
    except game_state.UnknownBowlerError:
        raise HTTPException(status_code=404, detail=f"no bowler {bowler_id} on lane {lane}")
    except (ValueError, IndexError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    await _broadcast_state(lane)
    return game_state.get_lane(lane).frames(bowler_id)


# ---- Isolated: request assistance (separate from game state -- see assistance.py) ----
class AssistanceRequestBody(BaseModel):
    reason: Optional[str] = None


@app.post("/api/lanes/{lane}/assistance")
async def create_assistance_request(lane: int, body: AssistanceRequestBody):
    _require_valid_lane(lane)
    req = assistance.request_assistance(lane, body.reason)
    await broadcast_event(lane, "assistance_requested", {"reason": req.reason})
    return {"id": req.id, "requestedAtMs": req.requested_at_ms}
