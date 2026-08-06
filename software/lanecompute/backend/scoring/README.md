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
- `game_state.py` — authoritative bowler rosters, frames, and 10-pin scoring math. Single source of truth; the UI is a thin client.
- `assistance.py` — isolated staff/maintenance summon requests, deliberately separate from game state. Stubbed pending the existing lane-status dashboard's integration interface.
- `api.py` — FastAPI app: REST commands (mesh-facing, game-state, assistance) + read-only WebSocket broadcast (`/ws/display/{lane}`, `/ws/control/{lane}`).
- `main.py` — entry point; runs uvicorn, starts the UART bridge as a background thread, and bridges its callbacks into the async broadcast system (`asyncio.run_coroutine_threadsafe`). Also where per-lane event *timing/scheduling* lives (e.g. pairing a speed node's raw upstream/downstream `BeamEvent`s into an interval, with a timeout) — nodes only emit raw events and accept commands, they never correlate multiple readings themselves. See `on_beam_event()`.
- `speed.py` — interval (ms) -> ball speed (mph), using a calibratable beam-spacing constant.

## Status (2026-07-18)
UART bridge + protocol scaffold, the speed-pairing/timeout logic, the
scoring engine (verified against known games: perfect 300, all-gutter 0,
all-5-pin-spares 150, in-progress games), and the full REST/WebSocket API
layer are done. Camera capture and pinfall detection live in `../vision/`
and are not implemented yet, and — separately — the integration between
that daemon and this API isn't wired up (see `../vision/README.md`).

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
| `POST` | `/api/lanes/{lane}/games` | game state | fresh scoresheet for the current roster |
| `PUT` | `/api/lanes/{lane}/bowlers/{id}/score` | game state | `{ball_index, pinfall}`, manual correction |
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
