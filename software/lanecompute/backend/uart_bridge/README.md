# openlanelink UART bridge service

Standalone process that owns the single UART link from the Raspberry Pi to
the gateway ESP32. Runs as its own systemd service, independent of the
game state machine process (`../state_machine`) -- see "Relationship to
state_machine" below for why this was split out and what's still needed to
finish wiring the two together.

## Layout
- `protocol.py` -- wire format (de)serialization matching the firmware structs byte-for-byte. Intentionally a duplicate of `../state_machine/protocol.py`, not a shared import -- these are now two separate deployable processes; see that file's docstring.
- `serial_link.py` -- the framed byte-protocol transport (pyserial) + background read thread + reconnect logic. Adapted from `../state_machine/uart_bridge.py`'s `UartBridge` class, renamed `SerialLink` now that it's wrapped by an HTTP surface instead of imported directly.
- `service.py` -- FastAPI app: `GET /health`, `WS /events` (streams inbound mesh events as JSON), and `POST /commands/*` (outbound pinsetter/score commands).
- `main.py` -- entry point; constructs the `SerialLink`, wires it into `service.py`, runs uvicorn.
- `pyproject.toml` / `uv.lock` -- dependencies, managed with `uv` (see "Running locally").
- `deploy/openlanelink-uart-bridge.service` -- systemd unit.

## Running locally
Dependencies are managed with [uv](https://docs.astral.sh/uv/) (`pyproject.toml` + `uv.lock`), not pip/`requirements.txt` -- this applies to every Python subproject in `openlanelink`.
```
uv sync
uv run main.py
```
Config is via environment variables (all optional, defaults shown):
```
UART_BRIDGE_PORT=/dev/serial0
UART_BRIDGE_BAUD=115200
UART_BRIDGE_HTTP_HOST=0.0.0.0
UART_BRIDGE_HTTP_PORT=8100
```
The service starts and serves `/health` even without a gateway attached --
`serial_link.SerialLink` retries the port on an interval in the
background, and `/commands/*` just 503 until it connects.

## API surface
| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | see "Health check contract" below |
| `WS` | `/events` | read-only broadcast of every inbound `LaneEvent`/`BeamEvent`/`StatusEvent`, JSON-encoded. `statusEvent` includes `ballNumber` (the pinsetter's own reported ball for `laneNumber`, `null` if not applicable/unknown) as of 2026-08-07. |
| `POST` | `/commands/pinsetter` | `{command, lane_number, cycle_count?}` -- raw `CommandCode` (see `protocol.py`); `cycle_count` (default 1) only matters for `CMD_CYCLE`/`CMD_RERACK` |
| `POST` | `/commands/cycle` | `{lane_number, cycle_count?}` (default 1) |
| `POST` | `/commands/rerack` | `{lane_number, cycle_count?}` (default 2 -- the safe "sweep + spot fresh" fallback; callers with real ball-state should pass an explicit count) |
| `POST` | `/commands/score-event` | `{lane_number, ball_number, pinfall_mask, timestamp_ms}` |

Interactive docs at `/docs` once running.

## Health check contract
`GET /health` always returns HTTP 200 as long as the process is alive --
that alone is what answers "can the state machine reach the bridge
service." The body then separately reports whether the *mesh* link is
actually good:

```json
{
  "status": "ok",
  "uartConnected": true,
  "stale": false,
  "port": "/dev/serial0",
  "baud": 115200,
  "lastFrameAgoS": 2.3,
  "uptimeS": 941.7
}
```

- `uartConnected` -- is the serial port currently open.
- `stale` -- port is open but no frame of any type has been heard in over
  15s. A stuck or miswired link can hold the port open with nothing ever
  arriving, so `uartConnected=true` alone doesn't prove the gateway is
  actually talking -- the pinsetter's own status heartbeat repeats roughly
  every 5s (see `firmware/ESPNOW.md`), so a couple of missed beats past
  that is a real signal, not noise.

A consuming client (the state machine) should treat any 200 response as
"bridge process reachable" and then branch on `uartConnected`/`stale` for
mesh-link health -- a connection failure to `/health` itself (timeout,
refused) is the only case that means "bridge service itself is down."

## Relationship to state_machine
`../state_machine` is an HTTP/WebSocket client of this service
(`../state_machine/bridge_client.py`) -- it polls `GET /health`, subscribes
to `WS /events`, and calls `POST /commands/*` instead of touching pyserial
directly. Verified end-to-end (2026-08-06): both processes running
together, `state_machine` logging `UART bridge service reachable` and
`subscribed to UART bridge event feed`, mesh-facing endpoints correctly
503ing until the bridge reports `uartConnected`.

## TODO: Raspberry Pi deployment adaptation
Everything above has only been exercised on the Windows dev machine so
far -- `serial_link.SerialLink` pointed at a nonexistent placeholder port
for the state_machine integration test, and (next) a real gateway ESP32
over a Windows COM port via USB. None of the following has been verified
on an actual Raspberry Pi yet:
- **Serial device path.** `UART_BRIDGE_PORT` defaults to `/dev/serial0`
  (the Pi's GPIO UART header, per `firmware/HANDOFF.md`), but if the
  gateway ends up wired to the Pi over USB instead (as it currently is on
  the dev machine) the real path is a `/dev/ttyUSB*`/`/dev/ttyACM*`
  device, which can shift across reboots/replugs -- may need a udev rule
  for a stable symlink (e.g. by USB vendor/product ID) rather than
  hardcoding a numbered device.
- **The systemd unit itself is untested.** `deploy/openlanelink-uart-bridge.service`
  has never been installed on real Pi hardware -- `User=pi`,
  `WorkingDirectory=/opt/openlanelink/uart_bridge`, and the `uv` binary
  path (`ExecStart=/usr/local/bin/uv run main.py`) are all placeholders
  that need confirming against however the Pi actually gets provisioned.
- **`dialout` group membership** for whichever user the service runs as
  needs to actually be set up on the Pi and confirmed to grant serial
  access (`sudo usermod -aG dialout pi`, per the install steps below) --
  not yet exercised for real.
- **`uv` needs installing on the Pi** (not preinstalled on Raspberry Pi OS)
  -- confirm the install method used matches the unit file's `ExecStart`
  path.
- **Boot/startup ordering with state_machine.** `state_machine` already
  tolerates the bridge being unreachable at startup and retries (see its
  README), so strict systemd ordering (`After=`/`Wants=`) probably isn't
  required, but this hasn't been decided or tested against a real
  simultaneous-boot scenario (matches the mesh's existing full-house-reboot
  concerns, see `firmware/HANDOFF.md`).
- **`STALE_AFTER_S = 15.0`** (see `service.py`) was chosen from the
  pinsetter's documented ~5s heartbeat interval, not measured against real
  mesh traffic over a real UART link yet -- revisit once real hardware is
  in the loop.

## Installing on the Pi (systemd)
1. Install `uv` on the Pi if it isn't already (`curl -LsSf https://astral.sh/uv/install.sh | sh`).
2. Copy this directory to the Pi, e.g. `/opt/openlanelink/uart_bridge`.
3. Sync dependencies (creates `.venv` in place from `pyproject.toml`/`uv.lock`):
   ```
   cd /opt/openlanelink/uart_bridge
   uv sync --frozen
   ```
4. Add the service user to the `dialout` group (required for `/dev/serial0` access):
   ```
   sudo usermod -aG dialout pi
   ```
5. Copy the unit file and adjust `User=`/`WorkingDirectory=`/`ExecStart=` if your install path or user differs:
   ```
   sudo cp deploy/openlanelink-uart-bridge.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now openlanelink-uart-bridge
   ```
6. Optionally override config without editing the unit, e.g. create `/etc/openlanelink/uart-bridge.env`:
   ```
   UART_BRIDGE_PORT=/dev/ttyAMA0
   ```
7. Verify:
   ```
   curl http://localhost:8100/health
   sudo journalctl -u openlanelink-uart-bridge -f
   ```
