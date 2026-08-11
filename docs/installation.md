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

Every downstream node hardcodes its gateway's MAC address and its own
lane-pair preset at compile time (dynamic discovery isn't built yet — see
the main page's "Top of mind todos") — set those constants for your actual
pair before flashing, not the example values in the sketches.

## 2. Compute node (Raspberry Pi)

Everything below runs on the Pi for this specific lane pair. Each service
manages its own Python dependencies with [uv](https://docs.astral.sh/uv/),
not pip — `uv sync` inside each service's directory before running it.

### 2a. Set which lanes this Pi covers

`software/lanecompute/backend/state_machine/api.py` has:
```python
VALID_LANES = (7, 8)
```
Change this to your pair's actual lane numbers. This is a code constant
today, not an environment variable — there's no configuration UI for it
yet (planned for a later session, same as the vision calibration tool's
camera picker).

### 2b. UART bridge

Owns the actual serial connection to the gateway. Runs as its own
process, independent of the state machine:
```bash
cd software/lanecompute/backend/uart_bridge
uv sync
uv run main.py
```
See [its README](https://github.com/nicholas-a-hall/openlanelink/blob/main/software/lanecompute/backend/uart_bridge/README.md)
for the systemd service file and `UART_BRIDGE_URL`/serial port
configuration. `state_machine` (next) treats this as unreachable-but-
non-fatal if it's down — mesh commands 503 until it's back, everything
else still works.

### 2c. State machine / REST API

The actual game-state service — bowler rosters, scoring, turn order,
pinsetter commands:
```bash
cd software/lanecompute/backend/state_machine
uv sync
uv run main.py
```
Defaults to port 8000, points at the UART bridge via `UART_BRIDGE_URL`
(default `http://localhost:8100`, correct if both run on the same Pi).
Interactive API docs at `/docs` once it's running. See
[its README](https://github.com/nicholas-a-hall/openlanelink/blob/main/software/lanecompute/backend/state_machine/README.md)
for the full endpoint list.

### 2d. Vision (camera pin detection)

A separate, un-Dockerized daemon with direct camera access — see
[`vision/README.md`](https://github.com/nicholas-a-hall/openlanelink/blob/main/software/lanecompute/backend/vision/README.md)
for the full detail. Two steps:

**Calibrate each lane once** (needs a real display attached to the Pi, or
X11 forwarding/VNC over SSH — this step can't run fully headless):
```bash
cd software/lanecompute/backend/vision
uv sync
uv run calibration.py --lane 7
```
Freezes a reference frame of the empty, fully-racked deck, then walks you
through marking each of the 10 pins (digit key to select, click to place,
`+`/`-` to resize that pin's detection radius). If more than one camera is
attached, you'll be prompted to pick which one. Repeat per lane.

**Run the detection daemon:**
```bash
uv run pinfall.py
```
Defaults to port 8200, reports to `state_machine` via `STATE_MACHINE_URL`
(default `http://localhost:8000`).

**Not yet built:** anything that automatically triggers a capture off the
beam sensors. Today `/capture/{lane}` is a manually/externally-triggered
endpoint — see the vision README's "Relationship to state_machine" for
the intended design (vision self-triggering off the UART bridge's beam
events) versus what's actually wired up right now.

### 2e. Verify the pair is live

```bash
curl http://localhost:8000/api/lanes/7
curl http://localhost:8200/health
```
Set up a quick manual game and confirm a capture lands correctly:
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

## 3. Scheduler / reservations (optional, site-wide)

[`openlanescheduler`](https://github.com/nicholas-a-hall/openlanelink/blob/main/software/openlanescheduler/README.md)
is a separate reservation/kiosk/maintenance system — it does **not**
currently integrate with `lanecompute` at all (no shared state, no API
calls between them; they're two independent systems today). It runs
site-wide, not per-pair, and now supports a `LANES` environment variable
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

Repeat section 1 and 2 with a new gateway/Pi, new `VALID_LANES` values,
and a fresh camera calibration per new lane. If you're running
`openlanescheduler`, extend `LANES` in its `.env` (e.g. `LANES=5,6,7,8`)
and add that pair's `kiosk-lanes-*` service to whatever you pass to
`docker compose up`, then rebuild the frontend/kiosk images so the new
`VITE_LANES` value takes effect.
