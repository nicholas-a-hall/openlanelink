# openlanelink scoring / compute node

Runs on a Raspberry Pi, alongside (not inside) `../uart_bridge` — the
standalone service that owns the actual UART link to a gateway ESP32. See
`../firmware/HANDOFF.md`'s "Gateway <-> Pi UART bridge" section for the
full mesh architecture and wire protocol, and `../uart_bridge/README.md`
for that service and its health-check contract. This service is the
REST/WebSocket API layer that exposes game state and mesh commands to the
React UI and any other programmatic client — it talks to `../uart_bridge`
over HTTP/WebSocket rather than owning pyserial itself (see
`bridge_client.py`). See `../DEVELOPING.md` for the platform-wide picture,
including why the camera/OpenCV pipeline (`../vision/`) is a *separate*
daemon and not part of this service either.

## Layout
- `protocol.py` — message (de)serialization matching the firmware structs byte-for-byte (including padding). Intentionally duplicated in `../uart_bridge/protocol.py` now that the two are separate processes — see that copy's docstring.
- `bridge_client.py` — HTTP/WebSocket client of `../uart_bridge`: synchronous `send_cycle`/`send_rerack`/etc. POSTs (same call shape the old in-process `UartBridge` had) plus a background asyncio task that subscribes to the bridge's `WS /events` feed and polls `GET /health`. Resilient to the bridge service being unreachable (retries on an interval; mesh-facing API calls 503 until connected) rather than crashing the process.
- `game_state.py` — authoritative bowler rosters, frames, and scoring math. Single source of truth; the UI is a thin client. `score_game()` is a generic frame-walking algorithm parametrized by a `game_types.GameType`, not ten-pin-specific.
- `game_types.py` / `game_types.json` — per-game-type scoring parameters (ten-pin, no-tap, duckpin today), data only. Covers games that share ten-pin's shape; a genuinely different scoring paradigm (some 9-pin/kegel variants) would need its own scoring function, not just a new JSON entry.
- `state_machine.py` — per-lane FSM sitting above `game_state.py`: owns whose turn it is and the cycle-vs-rerack decision, and is the one place every ball-by-ball input (fouls, beam pairing, pinsetter status, pinfall counts) lands. See its module docstring.
- `session.py` — how long a lane is sold for: an idle lane is one with no live session, activating it puts it in play (and auto-starts the first game), deactivating hands it back. Owns the countdown the bowler terminal shows, including holding it while a problem is open. Separate from game state — a session spans many games.
- `assistance.py` — isolated staff/maintenance summon requests, deliberately separate from game state. Two kinds: a *problem* (holds the lane's session clock until resolved) and a *server* call (doesn't). Publishes to openlanescheduler's existing MQTT service-call topic; resolution is local, so a lane's clock never depends on that service being reachable.
- `api.py` — FastAPI app: REST commands (mesh-facing, game-state, assistance) + read-only WebSocket broadcast (`/ws/display/{lane}`, `/ws/control/{lane}`).
- `main.py` — entry point; runs uvicorn and starts `bridge_client.BridgeClient.run()` as a background asyncio task on the same event loop, so its callbacks (`on_lane_event`/`on_beam_event`/`on_status_event`) can `await` broadcasts directly — no thread-safe handoff needed now that nothing here reads serial on its own thread. Also where per-lane event *timing/scheduling* lives (e.g. pairing a speed node's raw upstream/downstream `BeamEvent`s into an interval, with a timeout) — nodes only emit raw events and accept commands, they never correlate multiple readings themselves. See `on_beam_event()`.
- `speed.py` — interval (ms) -> ball speed (mph), using a calibratable beam-spacing constant.

## Status (2026-08-13)
The bowler kiosk moved here from openlanescheduler. This service now owns
lane sessions (`session.py`) and the full assistance lifecycle
(`assistance.py`), and serves the terminal at the UI's `/kiosk/{lane}`
route. openlanescheduler is no longer the source of truth for how much time
a lane has left; the only thing the two systems still share is the outgoing
service-call MQTT topic. openlanescheduler's own `kiosk/` app is untouched
and still runs — decommissioning it is a separate change.

## Status (2026-08-07)
The speed-pairing/timeout logic, the scoring engine (verified against
known games: perfect 300, all-gutter 0, all-5-pin-spares 150, in-progress
games), the full REST/WebSocket API layer, and the per-lane game/mesh
state machine (`state_machine.py`) are done. The gateway now forwards
pinsetter `MSG_STATUS` to the Pi (`UART_PINSETTER_STATUS`, see
`firmware/PROTOCOL.md`), so `PINSETTER_BUSY` waits on a real
`STATUS_CYCLE_COMPLETE` rather than a timeout -- except when vision is
driving the game (see below), which never needs it at all. The UART
bridge itself was extracted into `../uart_bridge` as its own
systemd-managed process (this service is now a client of it, see
`bridge_client.py`).

Camera capture and pinfall detection (`../vision/`) are implemented and
wired in — `POST /api/lanes/{lane}/pinfall` accepts either a manual
`{pinfall}` count (bowler tablet/staff UI) or vision's raw `{standing_mask}`
observation; this service derives the actual per-ball count/mask itself
in the latter case (`game_state.LaneState.standing_mask_before_next_ball()`),
since vision intentionally has no memory of its own across captures (see
`../vision/README.md`'s "Relationship to state_machine"). This also means
`/pinfall` is no longer gated on the lane being `AWAITING_PINFALL` —
beam events are an optional timing signal now, not a prerequisite for
scoring; a pinfall report alone infers the ball happened, records it, and
(via the completion check in `_record_ball`) even infers the whole game
finishing without ever needing an explicit `/cycle-complete` call.

## API surface
Once running, interactive docs are at `/docs` (FastAPI auto-generates an
OpenAPI schema). Summary:

| Method | Path | Bucket | Notes |
|---|---|---|---|
| `GET` | `/api/lanes/{lane}` | — | full lane snapshot (bowlers, frames, running scores, session, open assistance) |
| `POST` | `/api/lanes/{lane}/activate` | session | `{mode?, minutes?, games?, bowlers?, game_type?, source?}` — puts an idle lane in play. Starts the first game too **iff `bowlers` is given**; without it the lane sits active with no scoresheet, waiting for a roster. 409 if already active. |
| `POST` | `/api/lanes/{lane}/deactivate` | session | ends the session, clears roster/scoresheet/open calls, lane back to idle. Succeeds on an already-idle lane. |
| `POST` | `/api/lanes/{lane}/session/extend` | session | `{minutes?}` (timed) or `{games?}` (per-game) — "extend time" / "play another game", which one is decided by the session's mode |
| `POST` | `/api/lanes/{lane}/pinsetter/cycle` | mesh | 503 if not connected to the gateway |
| `POST` | `/api/lanes/{lane}/pinsetter/rerack` | mesh | 503 if not connected to the gateway |
| `POST` | `/api/lanes/{lane}/bowlers` | game state | `{name, handicap?}` — handicap is part of creation, not a follow-up call. 409 once the lane holds `MAX_BOWLERS_PER_LANE`; a bad handicap 400s and rolls the add back |
| `PUT` | `/api/lanes/{lane}/bowlers/{id}` | game state | `{name}` |
| `PUT` | `/api/lanes/{lane}/bowlers/{id}/handicap` | game state | `{handicap}` — pins added to the scratch score at snapshot time; never enters scoring math |
| `DELETE` | `/api/lanes/{lane}/bowlers/{id}` | game state | |
| `POST` | `/api/lanes/{lane}/games` | game state | `{game_type?}` (default `ten_pin`; see `game_types.json` for available types), fresh scoresheet for the current roster. The *next* game — the first one comes from `/activate`. |
| `POST` | `/api/lanes/{lane}/games/end` | game state | closes the current scoresheet, keeping roster, final scores and session. 409 if no game is in progress. |
| `PUT` | `/api/lanes/{lane}/turn` | state machine | `{bowler_id}` — hand the turn to a specific bowler. 409 if no game is in progress, they aren't in this game's rotation, or they've already finished |
| `POST` | `/api/lanes/{lane}/reset` | game state | wipes roster + scoresheet but **keeps** the session — a party swapping bowlers mid-hour keeps the hour |
| `PUT` | `/api/lanes/{lane}/bowlers/{id}/score` | game state | `{frame_number, ball_in_frame, pinfall, pin_mask?}`, manual correction addressed the way a scoresheet reads — overwrites a recorded ball **or records the next one in a frame**. See "Score corrections" below |
| `POST` | `/api/lanes/{lane}/pinfall` | state machine | `{pinfall}`, records the *next* ball for whoever's turn it is — 409 unless the lane is AWAITING_PINFALL. Manual stand-in for vision. |
| `POST` | `/api/lanes/{lane}/assistance` | isolated | `{kind?, reason?}` — `kind` is `problem` (default; holds the session clock) or `service` (doesn't) |
| `POST` | `/api/lanes/{lane}/assistance/{id}/resolve` | isolated | staff dealt with it; releases the clock once nothing else on the lane is still open |
| `WS` | `/ws/display/{lane}` | — | read-only broadcast (overhead monitor) |
| `WS` | `/ws/control/{lane}` | — | same broadcast (bowler tablet/terminal); commands go through REST above, not this socket |

### Lane lifecycle
An **idle** lane (`laneActive: false`) is waiting to be put in play. Two
things activate one, and they must land in identical state, so both go
through `api.activate_lane()`:

1. the bowler terminal (`/kiosk/{lane}` in the UI), and
2. the siteserver message bus — **not built yet**. When it is, its consumer
   imports and calls `activate_lane()`; it does not get its own copy of the
   activate → `add_game` → `begin_game` sequence.

Whether the first game starts with the activation depends on one thing:
whether anyone is on the roster yet.

- **Terminal**: the party picks hours-or-games and taps *Start session* →
  `POST /activate` with **no** `bowlers`. The session opens and the clock
  starts, but `game` stays null and `machineState` stays `IDLE` — the
  terminal shows a "who's playing" step. Names go in via
  `POST .../bowlers`, then *Start game* → `POST /games` builds the
  scoresheet around whoever's on the roster.
- **Bus** (and any client that already knows the party): `POST /activate`
  **with** `bowlers` does both at once — session, roster, and a game whose
  turn rotation is exactly that list, in that order.

A game is never started against an empty lane either way: an empty
scoresheet isn't a game, just something that would have to be reset before
anyone could use it.

From there the party runs their own games (`/games`, `/games/end`,
`/session/extend`) until somebody deactivates the lane — front-of-house
turning it over, or the terminal's own "End session" button, which is the
same endpoint.

### Score corrections
`PUT .../bowlers/{id}/score` both **overwrites a recorded ball and records
one that isn't there yet**. The append case is the point: the most common
misread is the machine catching ball 1 and missing ball 2, and an
overwrite-only endpoint couldn't express it at all.

What it still refuses, and why:

| Case | Result |
|---|---|
| Overwrite an existing ball | 200 |
| With `pin_mask` (which pins fell, bit N−1 = pin N) | 200 — stored, so a later ball in the frame can be checked and rendered against it |
| `pin_mask` whose bit count ≠ `pinfall` | 400 |
| `pin_mask` reusing a pin an earlier ball this frame already took down | 400 |
| Ball 2 of a frame holding only ball 1 | 200 — appended |
| Ball 1 of the frame the bowler is currently on | 200 — appended |
| Any ball of a frame not yet reached | 400 — a flat ball list has nowhere to put the gap |
| A frame whose balls exceed the pins standing (e.g. 4 then 9) | 400 |

The last two are both checked by re-deriving the frames from a candidate
ball list rather than trusting index arithmetic. That matters more than it
sounds: `ball_index` is computed by summing the balls in *earlier* frames,
so an address pointing past the current frame produces an index that
happens to be the end of the list and would silently append to whichever
frame is genuinely in progress — scoring a ball the bowler never threw, in
a frame they aren't on.

Frame-sum validation applies to both paths. `record_ball` enforces the same
"only knock down pins that are standing" rule going forward, but only a
correction can rewrite a ball that already has later balls behind it, which
is why the whole frame is re-checked rather than just the one ball.

Whose turn it is is corrected separately, via `PUT .../turn`. The rotation
otherwise only ever moves when balls are actually thrown
(`_advance_to_next_active_bowler`), which is right up until the lane's idea
of the order stops matching the people standing on it — somebody bowls out
of turn, a ball lands on the wrong bowler and is corrected after the turn
has already moved on. Setting the turn records nothing and deliberately
leaves `machineState` alone: a lane that's `PINSETTER_BUSY` is still busy
afterwards, and forcing it `READY` would allow a ball to be recorded while
the rack is still moving.

While a `problem` assistance request is open the session clock is **held**,
not extended: `remainingMs` freezes and `endsAtMs` slides later by exactly
the time waited. (openlanescheduler did the equivalent by accumulating
`serviceCallMs` onto a walk-in's end time; this compute node holds the clock
instead, and owns it outright.) A `service` call — someone wants a server —
summons staff the same way but leaves the clock running.

`VALID_LANES` in `api.py` must match whatever lane numbers the
fouling/speed/pinsetter nodes on this mesh actually use -- the gateway
itself is lane-agnostic (a dumb relay; lane numbers are stamped in by the
leaf nodes, not declared on the gateway), so there's nothing to cross-check
this against automatically. Configured via `LANE_NUMBERS` (see "Running"
below), not a code edit.

## Running
Dependencies are managed with [uv](https://docs.astral.sh/uv/) (`pyproject.toml` + `uv.lock`), not pip/`requirements.txt`.
```
uv sync
uv run main.py
```
Config is via environment variables (all optional, defaults shown):
```
LANE_NUMBERS=7,8
UART_BRIDGE_URL=http://localhost:8100
SESSION_DEFAULT_MINUTES=60
SESSION_EXTEND_MINUTES=60
MAX_BOWLERS_PER_LANE=12
MQTT_BROKER_HOST=localhost
MQTT_BROKER_PORT=1883
```
`MAX_BOWLERS_PER_LANE` is reported in every lane snapshot (`maxBowlers`) so
no client hardcodes its own copy.
`SESSION_*` are the length of a timed session started without an explicit
one and the size of a single "extend time" tap — a house that sells
half-hours changes these, not code. `MQTT_*` point at openlanescheduler's
broker for outgoing service calls; unreachable is logged and shrugged off,
never fatal (see `assistance.py`).
`LANE_NUMBERS` is a comma-separated list of the lane numbers this compute
node instance covers -- must match whatever's actually flashed onto the
fouling/speed/pinsetter nodes on this mesh (see above). `../uart_bridge`
must be running and reachable for mesh commands to work -- start it first
(see its README.md); `UART_BRIDGE_URL` is correct as-is when both run on
the same Pi.
This service starts and serves its own API even without the bridge
reachable — mesh-facing endpoints just 503 until `bridge_client.BridgeClient`
reports both the bridge service and its UART connection are up (see
`GET /health` on the bridge for what that's based on).
