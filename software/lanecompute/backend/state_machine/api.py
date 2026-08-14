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

The bowler terminal (the UI's /kiosk/{lane}) is just another REST client of
this surface -- activating an idle lane, starting/ending games, extending
the session, entering names and handicaps, summoning staff, and cycling the
pinsetter are all endpoints below, not a private channel of its own. That
matters because the siteserver bus will one day activate lanes too and has
to land in exactly the same state; see activate_lane().

See PROTOCOL.md for the mesh command set this passes through to the
gateway, game_state.py for the scoring engine this is a thin HTTP wrapper
around, and session.py for what makes a lane "active" at all. main.py wires
app.state.bridge to a live BridgeClient (an HTTP/WebSocket client of the
standalone ../uart_bridge service, see its README.md) at startup; without
it, mesh-facing endpoints 503.
"""

import logging
import os
from typing import Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import assistance
import game_state
import game_types
import session
import state_machine

log = logging.getLogger(__name__)

# The lanes this compute node instance covers -- must match whatever lane
# numbers the fouling/speed/pinsetter nodes on this mesh actually use. The
# gateway itself has no notion of "its" lanes (it's a dumb relay -- lane
# numbers are stamped in by the leaf nodes, see firmware/gateway_node.ino);
# this is purely this Pi process's own config, kept in sync by hand with
# whatever's flashed onto the leaf nodes it's paired with. Comma-separated
# via LANE_NUMBERS so a different lane pair/house size is a config change,
# not a code change -- e.g. LANE_NUMBERS=3,4.
VALID_LANES = tuple(int(n) for n in os.environ.get("LANE_NUMBERS", "7,8").split(","))

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
    data.update(session.get_lane_session(lane).snapshot())
    data.update(assistance.snapshot(lane))
    # An idle lane is one nobody has activated -- see session.py. Derived
    # here rather than left to each client to work out from `session` being
    # null vs ended, since the bowler terminal, the overhead display and any
    # script all need the same answer to "is this lane in play right now."
    data["laneActive"] = session.get_lane_session(lane).active() is not None
    return data


def _sync_session_pause(lane: int) -> None:
    """Hold or release this lane's session clock to match whether staff are
    still being waited on for a problem. Driven from the live request list
    every time it changes rather than from pause/resume edges, so a second
    problem raised while the first is open can't double-resume the clock
    when only one of them is cleared. Both session calls are idempotent."""
    ls = session.get_lane_session(lane)
    if assistance.has_open_problem(lane):
        ls.pause()
    else:
        ls.resume()


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


# ---- Lane activation / session ----
# An idle lane is one with no live session; activating it is what puts it in
# play. Two things activate a lane -- the bowler terminal, and the siteserver
# message bus once that exists -- and they must produce identical lane state,
# so both go through activate_lane() below rather than each assembling the
# steps themselves. A future bus consumer imports and calls it; it does not
# get its own copy of this sequence. See session.py.
#
# Whether the first game starts here or a moment later is decided by one
# thing: whether anyone is on the roster yet (see LaneActivate.bowlers). The
# terminal opens the session first and collects names second, so its
# activation carries no roster and the game follows from POST .../games; a
# bus activation that already knows the party gets both at once.
class BowlerSeed(BaseModel):
    name: str
    handicap: int = 0


class LaneActivate(BaseModel):
    mode: str = session.MODE_TIMED
    minutes: Optional[int] = None   # timed mode; defaults to SESSION_DEFAULT_MINUTES
    games: Optional[int] = None     # games mode; defaults to 1
    game_type: str = "ten_pin"
    source: str = session.SOURCE_API
    # Who's bowling, if that's known at activation time. This is what
    # decides whether a game starts here at all:
    #
    # - WITH bowlers (the siteserver bus, which will activate a lane the
    #   moment it's sold and may already know the party): the scoresheet is
    #   instantiated around exactly these players, in this order, in the
    #   same act. Nothing has to trickle in behind it.
    # - WITHOUT bowlers (the terminal): the session opens and the lane sits
    #   active with no game, waiting for names. The party enters them, then
    #   confirms, and POST .../games starts the scoresheet around whoever's
    #   on the roster by then.
    #
    # Either way a game is only ever started once there's somebody to bowl
    # it -- an empty scoresheet is not a game, just a lane that would have
    # to be reset before anyone could actually use it.
    bowlers: list[BowlerSeed] = []


class SessionExtend(BaseModel):
    # Which of these applies is decided by the session's own mode, not the
    # caller -- "extend time" and "play another game" are one button on the
    # terminal (see session.LaneSession.extend). Both default to the
    # configured extension size.
    minutes: Optional[int] = None
    games: int = 1


async def activate_lane(lane: int, body: LaneActivate) -> dict:
    """Shared activation path -- REST below and (eventually) the siteserver
    bus consumer. Raises HTTPException so the REST caller gets the right
    status directly; a bus consumer should catch it and log, since there's
    nobody to return a 409 to."""
    _require_valid_lane(lane)
    try:
        gt = game_types.get_game_type(body.game_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    lane_state = game_state.get_lane(lane)
    # Validated before the session is opened, not during the roster loop:
    # a rejected activation must leave the lane exactly as it was, and a
    # half-built roster sitting inside a session that then failed is worse
    # than either outcome on its own.
    if len(body.bowlers) > game_state.MAX_BOWLERS_PER_LANE:
        raise HTTPException(
            status_code=400,
            detail=f"{len(body.bowlers)} bowlers requested, lane {lane} takes at most {game_state.MAX_BOWLERS_PER_LANE}",
        )
    if any(not seed.name.strip() for seed in body.bowlers):
        raise HTTPException(status_code=400, detail="every bowler needs a name")
    if any(seed.handicap < 0 for seed in body.bowlers):
        raise HTTPException(status_code=400, detail="handicap must be 0 or more")

    ls = session.get_lane_session(lane)
    try:
        sess = ls.start(mode=body.mode, minutes=body.minutes, games=body.games, source=body.source)
    except session.SessionError as e:
        # Already active is a conflict, a bad mode/length is a bad request.
        status = 409 if ls.active() is not None else 400
        raise HTTPException(status_code=status, detail=str(e))

    # Roster before add_game: Game.bowler_ids is a snapshot taken at
    # add_game() time (see game_state.LaneState.add_game), so seeding first
    # is what puts everyone in the turn rotation from ball one rather than
    # relying on add_bowler's mid-game catch-up path.
    for seed in body.bowlers:
        try:
            bowler = lane_state.add_bowler(seed.name.strip())
        except game_state.LaneFullError as e:
            # Only reachable when the lane already had bowlers on it before
            # activation (a staff test game, an unmetered house game) -- the
            # payload's own count was checked above.
            raise HTTPException(status_code=409, detail=str(e))
        if seed.handicap:
            lane_state.set_handicap(bowler.id, seed.handicap)

    # A game only starts if somebody is actually on the lane to bowl it --
    # see LaneActivate.bowlers. An activation with no roster leaves the lane
    # active, clock running, machineState IDLE and `game` null: that's the
    # terminal's "session started, now tell me who's playing" state, and
    # POST .../games is what ends it.
    started_game = bool(lane_state.bowlers)
    if started_game:
        lane_state.add_game(gt)
        state_machine.get_machine(lane, _bridge_object()).begin_game()
        ls.note_game_started()

    await broadcast_event(lane, "lane_activated", {
        "sessionId": sess.id, "source": sess.source, "gameStarted": started_game,
    })
    await broadcast_state(lane)
    return _lane_snapshot(lane)


@app.post("/api/lanes/{lane}/activate")
async def activate(lane: int, body: LaneActivate = LaneActivate()):
    return await activate_lane(lane, body)


@app.post("/api/lanes/{lane}/deactivate")
async def deactivate(lane: int):
    """End the session and hand the lane back -- front-of-house turning a
    lane over, and the terminal's own "End session" button, are the same
    call so both leave the lane in the same place: idle, no roster, no
    scoresheet, nothing still waiting on staff. Deliberately succeeds on a
    lane with no active session (a lane already idle is the desired end
    state, not an error) so a stuck terminal can always clear itself."""
    _require_valid_lane(lane)
    ls = session.get_lane_session(lane)
    if ls.active() is not None:
        ls.end()
    # Clear open requests before the roster goes: a problem left open would
    # otherwise still be pausing the clock of whoever activates this lane
    # next (see assistance.resolve_all).
    assistance.resolve_all(lane)
    game_state.get_lane(lane).reset()
    state_machine.get_machine(lane, _bridge_object()).reset()
    await broadcast_event(lane, "lane_deactivated", {})
    await broadcast_state(lane)
    return _lane_snapshot(lane)


@app.post("/api/lanes/{lane}/session/extend")
async def extend_session(lane: int, body: SessionExtend = SessionExtend()):
    _require_valid_lane(lane)
    try:
        session.get_lane_session(lane).extend(minutes=body.minutes, games=body.games)
    except session.SessionError as e:
        raise HTTPException(status_code=409, detail=str(e))
    await broadcast_state(lane)
    return _lane_snapshot(lane)


# ---- Game-state commands ----
class BowlerCreate(BaseModel):
    name: str
    # Optional, and part of creation rather than a follow-up call: a bowler
    # and their handicap arrive together in real life, and splitting them
    # into add-then-patch leaves a window where the second call can fail and
    # a handicap bowler is silently on the board as scratch.
    handicap: int = 0


class BowlerUpdate(BaseModel):
    name: str


class BowlerHandicap(BaseModel):
    handicap: int


class ScoreEdit(BaseModel):
    frame_number: int
    ball_in_frame: int
    pinfall: int
    # Which pins fell, bit N-1 = pin N. Optional: a bare count is still a
    # valid correction. The pin pickers DO know (the bowler tapped them),
    # and sending it is what lets a later ball in the same frame grey out
    # pins that are already down. Must agree with `pinfall`.
    pin_mask: Optional[int] = None


@app.get("/api/lanes/{lane}")
async def get_lane_snapshot(lane: int):
    _require_valid_lane(lane)
    return _lane_snapshot(lane)


@app.post("/api/lanes/{lane}/bowlers")
async def add_bowler(lane: int, body: BowlerCreate):
    """Someone joining a lane that's already going. The roster for a lane's
    FIRST game arrives with the activation instead (see LaneActivate.
    bowlers) so the scoresheet is built around a known set of players."""
    _require_valid_lane(lane)
    ls = game_state.get_lane(lane)
    try:
        bowler = ls.add_bowler(body.name)
    except game_state.LaneFullError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if body.handicap:
        try:
            ls.set_handicap(bowler.id, body.handicap)
        except ValueError as e:
            # Undo the add rather than leaving a half-created bowler behind.
            ls.remove_bowler(bowler.id)
            raise HTTPException(status_code=400, detail=str(e))
    await broadcast_state(lane)
    return {"id": bowler.id, "name": bowler.name, "handicap": bowler.handicap}


@app.put("/api/lanes/{lane}/bowlers/{bowler_id}")
async def edit_bowler(lane: int, bowler_id: str, body: BowlerUpdate):
    _require_valid_lane(lane)
    try:
        bowler = game_state.get_lane(lane).edit_bowler(bowler_id, body.name)
    except game_state.UnknownBowlerError:
        raise HTTPException(status_code=404, detail=f"no bowler {bowler_id} on lane {lane}")
    await broadcast_state(lane)
    return {"id": bowler.id, "name": bowler.name}


@app.put("/api/lanes/{lane}/bowlers/{bowler_id}/handicap")
async def set_handicap(lane: int, bowler_id: str, body: BowlerHandicap):
    """Pins added to this bowler's scratch score, entered on the terminal.
    Doesn't touch frames or scoring math -- see game_state.Bowler.handicap
    for why it's applied at the end instead."""
    _require_valid_lane(lane)
    try:
        bowler = game_state.get_lane(lane).set_handicap(bowler_id, body.handicap)
    except game_state.UnknownBowlerError:
        raise HTTPException(status_code=404, detail=f"no bowler {bowler_id} on lane {lane}")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await broadcast_state(lane)
    return {"id": bowler.id, "name": bowler.name, "handicap": bowler.handicap}


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
    """The *next* scoresheet for a party already on the lane -- "play
    another game". The FIRST game of a session comes from .../activate
    instead, which does this plus opening the session itself. Deliberately
    not gated on there being a session: a lane can still be scored without
    one (a staff test, an unmetered house game), it just isn't metered
    against anything."""
    _require_valid_lane(lane)
    try:
        gt = game_types.get_game_type(body.game_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    game = game_state.get_lane(lane).add_game(gt)
    state_machine.get_machine(lane, _bridge_object()).begin_game()
    session.get_lane_session(lane).note_game_started()
    await broadcast_state(lane)
    return {"id": game.id, "startedAtMs": game.started_at_ms, "gameType": gt.name}


@app.post("/api/lanes/{lane}/games/end")
async def end_game(lane: int):
    """Close the current scoresheet, keeping the roster, the final scores,
    and the session -- the terminal's "End game". Handing the lane back
    entirely is .../deactivate; wiping it for a new party without ending
    the session is .../reset."""
    _require_valid_lane(lane)
    try:
        game = game_state.get_lane(lane).end_game()
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    state_machine.get_machine(lane, _bridge_object()).end_game()
    await broadcast_state(lane)
    return {"id": game.id, "endedAtMs": game.ended_at_ms}


class TurnUpdate(BaseModel):
    bowler_id: str


@app.put("/api/lanes/{lane}/turn")
async def set_turn(lane: int, body: TurnUpdate):
    """Hand the turn to a specific bowler -- for when the lane's rotation
    and the people actually standing on it have drifted apart (somebody
    bowled out of order, a ball was recorded against the wrong person). A
    correction, not a delivery: no ball is recorded or removed, and the
    pinsetter isn't touched. 409 if there's no game in progress, if that
    bowler isn't in this game's rotation, or if they've already finished."""
    _require_valid_lane(lane)
    if body.bowler_id not in game_state.get_lane(lane).bowlers:
        raise HTTPException(status_code=404, detail=f"no bowler {body.bowler_id} on lane {lane}")
    machine = state_machine.get_machine(lane, _bridge_object())
    try:
        machine.set_current_bowler(body.bowler_id)
    except state_machine.InvalidTransitionError as e:
        raise HTTPException(status_code=409, detail=str(e))
    # Announced as its own event, not just a state broadcast, because the
    # overhead display treats the two causes of a turn change differently
    # and can't tell them apart from state alone. A turn that moved because
    # a ball was thrown is held back a few seconds so the finished bowler's
    # score stays readable (DisplayLane's REORDER_DELAY_MS); a turn somebody
    # SET has no score to linger on and must take effect at once, or the
    # person who pressed the button watches the wrong bowler stay
    # highlighted and reasonably concludes it didn't work.
    await broadcast_event(lane, "turn_set", {"bowlerId": body.bowler_id})
    await broadcast_state(lane)
    return _lane_snapshot(lane)


@app.post("/api/lanes/{lane}/reset")
async def reset_lane(lane: int):
    """Full wipe: clears the bowler roster AND the game, back to a blank
    IDLE lane -- for turning a lane over to a new party. NOT how a lane
    starts its next game with the people already checked in; that's
    POST .../games again, which keeps the roster on purpose (see
    game_state.LaneState.add_game()'s docstring) -- this endpoint exists
    specifically to override that persistence when a lane really is done
    with its current bowlers.

    Leaves the session alone: this wipes what's ON the lane, it doesn't
    give the lane back. A party that swaps its whole roster mid-hour keeps
    the hour. Ending the session (and with it the lane's active status) is
    .../deactivate, which does this too."""
    _require_valid_lane(lane)
    game_state.get_lane(lane).reset()
    state_machine.get_machine(lane, _bridge_object()).reset()
    await broadcast_state(lane)
    return _lane_snapshot(lane)


@app.put("/api/lanes/{lane}/bowlers/{bowler_id}/score")
async def edit_score(lane: int, bowler_id: str, body: ScoreEdit):
    _require_valid_lane(lane)
    try:
        game_state.get_lane(lane).edit_score(
            bowler_id, body.frame_number, body.ball_in_frame, body.pinfall, body.pin_mask
        )
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
    real hardware path). Records a 0-pinfall ball and sends the pinsetter
    rerack itself -- see state_machine.py's on_foul (the gateway no longer
    auto-reracks on its own)."""
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
    # "problem" (something's broken, the party can't bowl) or "service"
    # (a server is wanted). Only the former holds the session clock -- see
    # assistance.py. Defaults to problem: that's the summon that costs the
    # house money to get wrong.
    kind: str = assistance.KIND_PROBLEM
    reason: Optional[str] = None


@app.post("/api/lanes/{lane}/assistance")
async def create_assistance_request(lane: int, body: AssistanceRequestBody):
    _require_valid_lane(lane)
    try:
        req = assistance.request_assistance(lane, body.kind, body.reason)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _sync_session_pause(lane)
    await broadcast_event(lane, "assistance_requested", {"id": req.id, "kind": req.kind, "reason": req.reason})
    await broadcast_state(lane)
    return {"id": req.id, "kind": req.kind, "requestedAtMs": req.requested_at_ms}


@app.post("/api/lanes/{lane}/assistance/{request_id}/resolve")
async def resolve_assistance_request(lane: int, request_id: str):
    """Staff have dealt with it. For a problem call this is what restarts
    the session clock (via _sync_session_pause) -- but only once nothing
    else on the lane is still open, so clearing one of two problems doesn't
    put the party back on the meter while they're still waiting."""
    _require_valid_lane(lane)
    try:
        req = assistance.resolve(lane, request_id)
    except assistance.UnknownRequestError:
        raise HTTPException(status_code=404, detail=f"no assistance request {request_id} on lane {lane}")
    _sync_session_pause(lane)
    await broadcast_event(lane, "assistance_resolved", {"id": req.id, "kind": req.kind})
    await broadcast_state(lane)
    return req.snapshot()
