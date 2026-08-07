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
- `assistance.py` — isolated staff/maintenance summon requests, deliberately separate from game state. Stubbed pending the existing lane-status dashboard's integration interface.
- `api.py` — FastAPI app: REST commands (mesh-facing, game-state, assistance) + read-only WebSocket broadcast (`/ws/display/{lane}`, `/ws/control/{lane}`).
- `main.py` — entry point; runs uvicorn and starts `bridge_client.BridgeClient.run()` as a background asyncio task on the same event loop, so its callbacks (`on_lane_event`/`on_beam_event`/`on_status_event`) can `await` broadcasts directly — no thread-safe handoff needed now that nothing here reads serial on its own thread. Also where per-lane event *timing/scheduling* lives (e.g. pairing a speed node's raw upstream/downstream `BeamEvent`s into an interval, with a timeout) — nodes only emit raw events and accept commands, they never correlate multiple readings themselves. See `on_beam_event()`.
- `speed.py` — interval (ms) -> ball speed (mph), using a calibratable beam-spacing constant.

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
| `GET` | `/api/lanes/{lane}` | — | full lane snapshot (bowlers, frames, running scores) |
| `POST` | `/api/lanes/{lane}/pinsetter/cycle` | mesh | 503 if not connected to the gateway |
| `POST` | `/api/lanes/{lane}/pinsetter/rerack` | mesh | 503 if not connected to the gateway |
| `POST` | `/api/lanes/{lane}/bowlers` | game state | `{name}` |
| `PUT` | `/api/lanes/{lane}/bowlers/{id}` | game state | `{name}` |
| `DELETE` | `/api/lanes/{lane}/bowlers/{id}` | game state | |
| `POST` | `/api/lanes/{lane}/games` | game state | `{game_type?}` (default `ten_pin`; see `game_types.json` for available types), fresh scoresheet for the current roster |
| `PUT` | `/api/lanes/{lane}/bowlers/{id}/score` | game state | `{frame_number, ball_in_frame, pinfall}`, manual correction of an already-recorded ball, addressed the way a scoresheet reads |
| `POST` | `/api/lanes/{lane}/pinfall` | state machine | `{pinfall}`, records the *next* ball for whoever's turn it is — 409 unless the lane is AWAITING_PINFALL. Manual stand-in for vision. |
| `POST` | `/api/lanes/{lane}/assistance` | isolated | `{reason?}`, summons staff — not game state |
| `WS` | `/ws/display/{lane}` | — | read-only broadcast (overhead monitor) |
| `WS` | `/ws/control/{lane}` | — | same broadcast (bowler tablet); commands go through REST above, not this socket |

`VALID_LANES` in `api.py` (currently `(7, 8)`) must match whatever this
compute node's paired gateway/pinsetter actually cover.

## Running
Dependencies are managed with [uv](https://docs.astral.sh/uv/) (`pyproject.toml` + `uv.lock`), not pip/`requirements.txt`.
```
uv sync
uv run main.py
```
`../uart_bridge` must be running and reachable for mesh commands to work —
start it first (see its README.md). Point this service at it via
`UART_BRIDGE_URL` (default `http://localhost:8100`, correct when both run
on the same Pi):
```
UART_BRIDGE_URL=http://localhost:8100
```
This service starts and serves its own API even without the bridge
reachable — mesh-facing endpoints just 503 until `bridge_client.BridgeClient`
reports both the bridge service and its UART connection are up (see
`GET /health` on the bridge for what that's based on).
