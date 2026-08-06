# openlanelink scoring / compute node

Runs on a Raspberry Pi wired directly (UART) to a gateway ESP32, in Docker.
See `../firmware/HANDOFF.md`'s "Gateway <-> Pi UART bridge" section for the
full mesh architecture and wire protocol — this service is the Pi-side half
of it, plus the REST/WebSocket API layer that exposes game state and mesh
commands to the React UI and any other programmatic client. See
`../DEVELOPING.md` for the platform-wide picture, including why the
camera/OpenCV pipeline (`../vision/`) is a *separate*, un-Dockerized daemon
and not part of this service.

## Layout
- `protocol.py` — message (de)serialization matching the firmware structs byte-for-byte (including padding).
- `uart_bridge.py` — framed byte-protocol transport (pyserial) + a background read thread. Resilient to no hardware being attached (retries on an interval; mesh-facing API calls 503 until connected) rather than crashing the process.
- `game_state.py` — authoritative bowler rosters, frames, and scoring math. Single source of truth; the UI is a thin client. `score_game()` is a generic frame-walking algorithm parametrized by a `game_types.GameType`, not ten-pin-specific.
- `game_types.py` / `game_types.json` — per-game-type scoring parameters (ten-pin, no-tap, duckpin today), data only. Covers games that share ten-pin's shape; a genuinely different scoring paradigm (some 9-pin/kegel variants) would need its own scoring function, not just a new JSON entry.
- `state_machine.py` — per-lane FSM sitting above `game_state.py`: owns whose turn it is and the cycle-vs-rerack decision, and is the one place every ball-by-ball input (fouls, beam pairing, pinsetter status, pinfall counts) lands. See its module docstring.
- `assistance.py` — isolated staff/maintenance summon requests, deliberately separate from game state. Stubbed pending the existing lane-status dashboard's integration interface.
- `api.py` — FastAPI app: REST commands (mesh-facing, game-state, assistance) + read-only WebSocket broadcast (`/ws/display/{lane}`, `/ws/control/{lane}`).
- `main.py` — entry point; runs uvicorn, starts the UART bridge as a background thread, and bridges its callbacks into the async broadcast system (`asyncio.run_coroutine_threadsafe`). Also where per-lane event *timing/scheduling* lives (e.g. pairing a speed node's raw upstream/downstream `BeamEvent`s into an interval, with a timeout) — nodes only emit raw events and accept commands, they never correlate multiple readings themselves. See `on_beam_event()`.
- `speed.py` — interval (ms) -> ball speed (mph), using a calibratable beam-spacing constant.

## Status (2026-08-06)
UART bridge + protocol scaffold, the speed-pairing/timeout logic, the
scoring engine (verified against known games: perfect 300, all-gutter 0,
all-5-pin-spares 150, in-progress games), the full REST/WebSocket API layer,
and the per-lane game/mesh state machine (`state_machine.py`) are done. The
gateway now forwards pinsetter `MSG_STATUS` to the Pi
(`UART_PINSETTER_STATUS`, see `firmware/PROTOCOL.md`), so `PINSETTER_BUSY`
waits on a real `STATUS_CYCLE_COMPLETE` rather than a timeout. Camera
capture and pinfall detection live in `../vision/` and are not implemented
yet — `POST /api/lanes/{lane}/pinfall` is a manual-entry stand-in until
then (see `../vision/README.md`).

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
```
pip install -r requirements.txt
python main.py
```
Confirm `PI_UART_PORT` in `main.py` (placeholder: `/dev/serial0`) against how
the Pi's UART is actually wired, and the gateway's `RS485`/UART2 pins
(placeholders — see `firmware/HANDOFF.md`) against the real board. The
service starts and serves the API even without a gateway connected —
mesh-facing endpoints just 503 until `uart_bridge.UartBridge` connects.
