# OpenLaneLink

Open-source, hardware-agnostic data platform for bowling centers — pinsetter control, scoring, and lane automation built on commodity hardware instead of closed, proprietary scoring systems.

**Full docs, architecture, and protocol spec: [nicholas-a-hall.github.io/openlanelink](https://nicholas-a-hall.github.io/openlanelink/)**

## Why

Bowling scoring systems are one of the most expensive pieces of equipment in a center, and most are closed-source, locking a proprietor's data behind whatever interfaces the vendor decides to expose. OpenLaneLink is an attempt at an open-source-first alternative: expose the data layer, keep costs down with commodity parts and rapid-replacement hardware, and let proprietors innovate on top of their own system instead of waiting on a vendor.

See the [full background and concept](https://nicholas-a-hall.github.io/openlanelink/#background) for the story behind the project.

## Repo layout

| Path | What's there |
|---|---|
| [`firmware/`](firmware) | ESP32 firmware for gateway, pinsetter, fouling, speed, and ball detection nodes — ESP-NOW mesh + RS-485 fallback transport |
| [`firmware/lib/lanelink/`](firmware/lib/lanelink) | The shared wire-protocol + RS-485 library every sketch includes. **Install it before compiling anything** — see Contributing |
| [`firmware/tools/`](firmware/tools) | Install/verify scripts for the above |
| `hardware/` | Hardware references and board notes (placeholder — empty for now) |
| [`software/lanecompute/`](software/lanecompute) | Per-lane compute node: UART bridge, FastAPI scoring/state-machine backend, vision (pin detection), and the React bowler/overhead UI |
| [`software/openlanescheduler/`](software/openlanescheduler) | Lane reservation and maintenance scheduler — manager dashboard, lane kiosks, mechanics module |
| [`docs/`](docs) | Source for the GitHub Pages site (architecture, mesh protocol, message format, API surface, real-installation walkthrough) |

The unit everything scales by is **one lane pair**: one gateway, one Raspberry Pi, one pinsetter interface board, and the sensor nodes for those two lanes. A full house is that, repeated.

## Current state

**Working in software:** pinsetter control, ESP-NOW transport, RS-485 redundant transport, gateway peer registration with a compute-node-owned allowlist, lane-local game state and scoring, camera pin detection, REST/WebSocket API, bowler and overhead UIs.

**Designed, not built:** node identity in NVS with a pair-button provisioning handshake, gateway failure/replacement recovery, node liveness and offline detection. See `firmware/HANDOFF.md`'s "Next" list — every deferred item is written up there with its reasoning rather than left implicit.

## Contributing

Issues and PRs welcome. The project is GPLv3, so contributions are too.

A few things about this codebase are non-obvious and will cost you time if you don't know them up front.

### Before you compile any firmware

Every sketch `#include`s a shared library that lives in this repo, not in your sketchbook. **Nothing compiles until you link it in**, once:

```bash
powershell -ExecutionPolicy Bypass -File firmware\tools\install_lanelink_library.ps1
```

macOS/Linux: `bash firmware/tools/install_lanelink_library.sh`. Both create a link rather than a copy, so editing the header in the repo takes effect on the next compile. Re-run with `-Check` / `--check` to verify. Skipping this gives you `lanelink_protocol.h: No such file or directory`.

### Design rules that aren't negotiable

These aren't style preferences — each one exists because violating it caused a real bug.

- **Nodes are dumb.** Firmware emits raw sensor edges and executes commands. It never times, correlates, counts, or derives. Anything needing more than one reading belongs on the Pi, which can see the whole picture. (`firmware/HANDOFF.md`, "Design principles")
- **The mesh has no lane numbers.** Nodes address the two *sides* of their gateway's lane pair (`LaneSide::A`/`LaneSide::B`). Side → real lane resolution happens once, in `uart_bridge/lane_map.py`. Don't reintroduce a lane number into firmware — that's what makes every leaf sketch identical across every pair in the house.
- **One message struct, every transport.** ESP-NOW and RS-485 carry the identical `NodeMessage`. There is no second protocol, no JSON anywhere in the mesh. Both prior attempts at a transport-specific format were reverted.
- **`NodeMessage` is exactly 72 bytes.** A `static_assert` enforces it. The layout is deliberately padding-free — a `uint32_t` needs 4-byte alignment, which is why `timestampMs` sits at offset 4. If you add a field, take a byte from `data[]` rather than growing the struct, and don't relax the assert.
- **Each lane pair needs its own isolated RS-485 segment.** Frames carry no sender address, so a bus shared across pairs means one gateway silently ingesting another's events, and no amount of software can detect it.

### Changing the wire protocol

Order matters, because several files mirror each other by hand:

1. `firmware/PROTOCOL.md` first — it's the source of truth, and the reasoning belongs there before the code exists.
2. `firmware/lib/lanelink/src/` — one definition, shared by all five sketches.
3. `software/lanecompute/backend/uart_bridge/protocol.py` — the Pi side of the gateway↔Pi UART link.

**The two `protocol.py` files are deliberately no longer identical.** `uart_bridge/protocol.py` describes the raw wire (lane *sides*, struct layouts, framing). `state_machine/protocol.py` describes the bridge's decoded JSON feed (real *lane numbers*). They used to be byte-for-byte duplicates; "fixing" them back into sync is a regression. The constants they share (`EVENT_*`, `ROLE_*`, `STATUS_*`, `CMD_*`) do still have to be kept in step by hand.

### Python services

Each backend service under `software/lanecompute/backend/` is independently deployable and manages its own dependencies with [uv](https://docs.astral.sh/uv/), not pip:

```bash
cd software/lanecompute/backend/uart_bridge
uv sync
uv run main.py
```

Services talk to each other over HTTP/WebSocket, never by importing each other. Client glue lives on the *dependent* side only — `vision` and `state_machine` each own their own client for the UART bridge; the bridge knows nothing about them.

### Verifying without hardware

Most of this can be checked on a dev machine, and that's the expected baseline for a PR:

- **Firmware compiles** via the `arduino-cli` bundled with the Arduino IDE (`resources/app/lib/backend/resources/arduino-cli.exe` on Windows). Gateway/fouling/speed/ball-detect are `esp32:esp32:esp32`; the pinsetter is `esp32:esp32:esp32s3`.
- **The services run with no serial port attached** — the UART bridge starts, serves `/health`, and reconnects on its own once hardware appears. `/debug/beam-event` and `/debug/node-seen` inject synthetic events so the whole event path can be exercised cold.
- **A full game can be simulated:** `uv run --with requests python simulate_game.py --lane 7` against a running state machine.

If you touch protocol structs, please verify the layouts actually match rather than assuming — a padding mistake misparses silently rather than failing loudly, and that has bitten this project before.

### Writing things down

This repo leans heavily on prose docs, and PRs are expected to keep them true:

- `firmware/PROTOCOL.md` — canonical wire format
- `firmware/ESPNOW.md` — per-node behaviour and the **Known gaps** list
- `firmware/HANDOFF.md` — design principles, hardware pinouts, and the **Next** list
- `docs/` — the public GitHub Pages site

If you deliberately leave something unfixed, add it to Known gaps or Next with the reasoning, rather than leaving it silent. Several entries in those lists are there precisely because the *reason* for a decision was more valuable than the decision.

## License

[GPLv3](LICENSE)

## Links

- Project repo: [github.com/nicholas-a-hall/openlanelink](https://github.com/nicholas-a-hall/openlanelink)
- [LinkedIn](https://www.linkedin.com/in/nicholashall87/) 
- [nicholas-a-hall.github.io](https://nicholas-a-hall.github.io)
