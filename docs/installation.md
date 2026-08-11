---
layout: default
title: Installation — Open Lane Link
---

# Installing one lane pair

This walks through bringing up a **single gateway/lane-pair** end to end —
the unit everything in this project scales by. A full house is just this,
repeated once per pair, each with its own gateway and its own Raspberry Pi
(see the [hardware requirements table]({{ '/' | relative_url }}#hardware-requirements)
on the main page — "Per: Lane-pair" there means literally one of that node
per pair, not shared across the house).

This guide reflects what's actually built and tested today, not the full
end-state architecture described on the main page — where something isn't
built yet, that's called out explicitly rather than glossed over.

## What you need per pair

From the [hardware requirements table]({{ '/' | relative_url }}#hardware-requirements):
one gateway ESP32, one Raspberry Pi, one pinsetter interface board, one
fouling break-beam pair, four ball-speed break-beams, and (for pin
detection — see "Vision" below) one USB webcam per lane, pointed at that
lane's deck.

## 1. Firmware

Flash each ESP32 node from its own sketch folder under `firmware/`
(`gateway_node/`, `pinsetter_node/`, `foul_node/`, `speed_node/`) via the
Arduino IDE — each `.ino` is self-contained per the project's sketch-layout
convention. Wiring, pin assignments, and per-node hardware notes are in
[`firmware/HANDOFF.md`](https://github.com/nicholas-a-hall/openlanelink/blob/main/firmware/HANDOFF.md);
the wire protocol itself is documented on the [main page]({{ '/' | relative_url }}#mesh-protocol-message-format)
if you need to debug traffic on the bus.

### 1a. Per-pair constants to set before flashing

Every downstream node hardcodes its gateway's MAC address and its own
lane-pair preset at compile time (dynamic discovery isn't built yet — see
the main page's "Top of mind todos"). Set these for your actual pair, not
the example values shipped in the sketches:

| Sketch | Constant | What it is |
|---|---|---|
| `foul_node`, `speed_node` | `GATEWAY_MAC` | your gateway's ESP-NOW MAC |
| `foul_node`, `speed_node` | `LANE_NUMBER[]` | the two lane numbers this pair covers (`{7, 8}` in the shipped sketches) |
| `speed_node` | `SENSOR_LANE[]` | which of the 4 beams belongs to which lane |
| `pinsetter_node` | `MACHINES[]` | `{laneNumber, cycleRelay, powerRelay}` per machine — the relay channels each lane's pinsetter is physically wired to |

The gateway itself needs none of these: it's lane-agnostic by design (a
dumb relay — lane numbers are stamped in by the leaf nodes), which is also
why nothing can cross-check your lane numbers automatically. Get the
gateway's MAC by flashing
[`firmware/utility/mac_finder/`](https://github.com/nicholas-a-hall/openlanelink/blob/main/firmware/utility/mac_finder/mac_finder.ino)
onto it first and reading the serial console at 9600 baud, then flash the
real `gateway_node` sketch over it.

Two things worth knowing before you wire anything up:

- **Several GPIO assignments are still placeholders**, notably the
  gateway's UART2 pins for the Pi link (RX=16/TX=17) and the speed node's
  sensor and RS485 pins. Confirm them against your actual boards —
  `firmware/HANDOFF.md` flags each unverified one.
- **The pinsetter node's OTA password is `changeme`.** Set a real one
  before this goes anywhere near a public network.

### 1b. Check the mesh before touching the Pi

The gateway has a serial bench console at **9600 baud** — `cycle <lane>`,
`rerack <lane>`, `respot <lane>`, `power <lane> on|off`, `pstatus`,
`status`. Use it to confirm each node registers (`Registered FOULING
node`, `Registered PINSETTER node`, `Registered SPEED node`) and that
relays fire on the right machine, before any software is in the loop. If a
lane cycles from here, the mesh half is good.

## 2. Compute node (Raspberry Pi)

Everything below runs on the Pi for this specific lane pair. Each service
manages its own Python dependencies with [uv](https://docs.astral.sh/uv/),
not pip — `uv sync` inside each service's directory before running it.

Three separate processes, and the **start order matters**: the UART bridge
owns the serial link, the state machine and the vision daemon are both
independent clients of it, and vision's calibration tool needs the vision
daemon already running:

```
uart_bridge (8100) ──┬── state_machine (8000) ── UI
                     └── vision (8200) ── calibration.py / debug_view.py
```

### 2a. Set which lanes this Pi covers

`LANE_NUMBERS` (comma-separated, default `7,8`) tells `state_machine`
which lanes this compute node serves. It's an environment variable, not a
code edit:

```bash
export LANE_NUMBERS=7,8
```

It must match whatever's actually flashed onto this mesh's
fouling/speed/pinsetter nodes (section 1a) — nothing verifies that for
you. There's no configuration UI for it yet.

### 2b. UART bridge

Owns the actual serial connection to the gateway. Runs as its own
process, independent of the state machine:
```bash
cd software/lanecompute/backend/uart_bridge
uv sync
uv run main.py
```
Serves on port 8100. Config is environment variables, all optional:
`UART_BRIDGE_PORT` (default `/dev/serial0`, the Pi's GPIO UART header),
`UART_BRIDGE_BAUD` (115200), `UART_BRIDGE_HTTP_PORT` (8100). If the
gateway is wired over USB instead of the GPIO header, that's a
`/dev/ttyUSB*`/`/dev/ttyACM*` path — and one that can move across
reboots, so a udev rule for a stable symlink is worth setting up rather
than hardcoding a numbered device. Whichever user runs the service needs
to be in `dialout` (`sudo usermod -aG dialout pi`).

[Its README](https://github.com/nicholas-a-hall/openlanelink/blob/main/software/lanecompute/backend/uart_bridge/README.md)
has the systemd install steps and the `/health` contract. **Caveat worth
reading before you rely on it:** the systemd unit, the `/dev/serial0`
default, and the `dialout` setup have only ever been exercised on a
Windows dev machine — none of it has been run on real Pi hardware yet,
and the unit file's `User=`/`WorkingDirectory=`/`uv` path are all
placeholders.

The bridge starts and serves `/health` with no gateway attached, and
`state_machine` treats it as unreachable-but-non-fatal if it's down —
mesh commands 503 until it's back, everything else still works.

### 2c. State machine / REST API

The actual game-state service — bowler rosters, scoring, turn order,
pinsetter commands:
```bash
cd software/lanecompute/backend/state_machine
uv sync
uv run main.py
```
Serves on port 8000 (a code constant in `main.py`, not configurable), and
points at the UART bridge via `UART_BRIDGE_URL` (default
`http://localhost:8100`, correct if both run on the same Pi). Interactive
API docs at `/docs` once it's running. See
[its README](https://github.com/nicholas-a-hall/openlanelink/blob/main/software/lanecompute/backend/state_machine/README.md)
for the full endpoint list.

### 2d. Vision (camera pin detection)

A separate, un-Dockerized daemon with direct camera access — see
[`vision/README.md`](https://github.com/nicholas-a-hall/openlanelink/blob/main/software/lanecompute/backend/vision/README.md)
for the full detail.

**Start the daemon first.** It owns the camera devices, and both the
calibration tool and the debug viewer pull their frames from it over HTTP
rather than opening a capture device themselves — so calibration will
fail outright if the daemon isn't up:

```bash
cd software/lanecompute/backend/vision
uv sync
uv run pinfall.py
```
Serves on port 8200. Environment config (all optional, defaults shown):
```
STATE_MACHINE_URL=http://localhost:8000
UART_BRIDGE_URL=http://localhost:8100
VISION_CAPTURE_DELAY_S=0.5
VISION_AUTO_EXPOSURE=      # device-specific; e.g. 1 = manual on V4L2
VISION_EXPOSURE=
```

`VISION_CAPTURE_DELAY_S` is how long after the ball-detection beam breaks
the daemon waits before snapping the deck. **Tune it on real hardware,
watching specifically for undercounts** — too long only costs latency,
but too short reads a mid-topple pin as still standing and produces a
score that's too low. Pinning `VISION_AUTO_EXPOSURE`/`VISION_EXPOSURE` is
worth doing per camera: it removes the frame-to-frame brightness drift
the detector otherwise has to correct for.

**Calibrate each lane once**, with the daemon running (needs a real
display attached to the Pi, or X11 forwarding/VNC over SSH — this step
can't run fully headless):
```bash
uv run calibration.py --list-cameras     # what the daemon found at startup
uv run calibration.py --lane 7           # prompts if more than one camera
uv run calibration.py --lane 7 --camera 0
```
Freezes a reference frame of the empty, fully-racked deck, then walks you
through marking each of the 10 pins (digit key to select, click to place,
`+`/`-` — or `[`/`]` for bigger steps — to resize that pin's detection
radius, `s` to save). Repeat per lane. Two gotchas:

- The reference frame bakes in whatever exposure settings the daemon was
  started with. Change `VISION_AUTO_EXPOSURE`/`VISION_EXPOSURE` later and
  you need to recalibrate.
- The daemon caches a lane's calibration in memory the first time it
  captures that lane. Re-calibrating a lane it has already captured
  requires a daemon restart to take effect.

To eyeball detection quality afterwards — each pin's ROI overlaid live,
green/red with its current brightness against its cutoff:
```bash
uv run debug_view.py --lane 7
```

**How captures get triggered:** the daemon is its own client of the UART
bridge's `/events` feed and self-triggers off a downstream
ball-detection beam break (a `speed_node`'s near-pins beam today), then
POSTs the raw standing-pin mask to `state_machine`. `POST /capture/{lane}`
stays available for manual and bench triggering. Note what vision does
*not* do: it reports which pins are standing right now, with no memory
across captures at all — `state_machine` is what diffs that against what
it already knew was standing to derive the per-ball count.

### 2e. Verify the pair is live

Health first:
```bash
curl http://localhost:8100/health   # uartConnected / stale tell you about the mesh link
curl http://localhost:8000/api/lanes/7
curl http://localhost:8200/health
curl http://localhost:8200/cameras
```

For a full scoring/UI check with no hardware in the loop, run a scripted
game against the live API — it drives the same beam/pinfall/cycle-complete
endpoints the UART bridge's callbacks hit, so you can watch a real game
unfold on the UI:
```bash
cd software/lanecompute/backend/state_machine
uv run --with requests python simulate_game.py --lane 7
```

To confirm the camera path specifically, set up a manual game and take a
capture:
```bash
curl -X POST http://localhost:8000/api/lanes/7/bowlers -H "Content-Type: application/json" -d '{"name":"Test"}'
curl -X POST http://localhost:8000/api/lanes/7/games -H "Content-Type: application/json" -d '{}'
curl -X POST http://localhost:8200/capture/7
curl http://localhost:8000/api/lanes/7
```
The last call's `bowlers[0].frames[0]` should show a recorded ball with a
`pinMasks` entry — no beam events or manual pinfall entry required, a
pinfall report alone is enough to drive the game forward (see the main
page's API surface section).

### 2f. Bowler/overhead UI

```bash
cd software/lanecompute/frontend/ui
npm install
npm run dev
```
Point an overhead monitor at `/display/7` and a bowler tablet at
`/control/7` (swap `7` for whichever of your pair's lanes that screen is
for).

The UI finds its backend at `<whatever host served the page>:8000`, which
is correct when it's served from the same Pi that runs `state_machine`.
If it isn't, set `VITE_BACKEND_URL` at build time (Vite bakes it in;
it isn't readable at runtime).

## 3. Scheduler / reservations (optional, site-wide)

[`openlanescheduler`](https://github.com/nicholas-a-hall/openlanelink/blob/main/software/openlanescheduler/README.md)
is a separate reservation/kiosk/maintenance system — it does **not**
currently integrate with `lanecompute` at all (no shared state, no API
calls between them; they're two independent systems today). It runs
site-wide, not per-pair, and supports a `LANES` environment variable
so a partial house doesn't have to configure (or look like) all 8 lanes:

```bash
cd software/openlanescheduler
cp .env.example .env
```
In `.env`, set:
```
LANES=7,8
```
Then bring up just the pieces you need — for one pair, that's the backend,
frontend, and a single kiosk instance rather than all four:
```bash
docker compose up redis mongodb backend frontend kiosk-lanes-7-8
```
`backend`, `mqtt-bridge`, and `pmScheduler`'s maintenance-task generation
all read `LANES` from the environment. The frontend and kiosk apps need
the *same* value baked in at **build** time instead (Vite environment
variables aren't available at container runtime) — `docker-compose.yml`
already passes `LANES` through as a `VITE_LANES` build arg for the
`frontend` service; if you rebuild the kiosk image yourself, pass
`--build-arg VITE_LANES=7,8` the same way `VITE_KIOSK_LANES` is already
passed per kiosk instance.

## Adding a second pair later

Repeat sections 1 and 2 with a new gateway/Pi, that pair's own
`GATEWAY_MAC`/`LANE_NUMBER[]`/`MACHINES[]` values, a new `LANE_NUMBERS`,
and a fresh camera calibration per new lane. If you're running
`openlanescheduler`, extend `LANES` in its `.env` (e.g. `LANES=5,6,7,8`)
and add that pair's `kiosk-lanes-*` service to whatever you pass to
`docker compose up`, then rebuild the frontend/kiosk images so the new
`VITE_LANES` value takes effect.
