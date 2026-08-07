# OpenLaneLink

Open-source, hardware-agnostic data platform for bowling centers — pinsetter control, scoring, and lane automation built on commodity hardware instead of closed, proprietary scoring systems.

**Full docs, architecture, and protocol spec: [nicholas-a-hall.github.io/openlanelink](https://nicholas-a-hall.github.io/openlanelink/)**

## Why

Bowling scoring systems are one of the most expensive pieces of equipment in a center, and most are closed-source, locking a proprietor's data behind whatever interfaces the vendor decides to expose. OpenLaneLink is an attempt at an open-source-first alternative: expose the data layer, keep costs down with commodity parts and rapid-replacement hardware, and let proprietors innovate on top of their own system instead of waiting on a vendor.

See the [full background and concept](https://nicholas-a-hall.github.io/openlanelink/#background) for the story behind the project.

## Repo layout

| Path | What's there |
|---|---|
| [`firmware/`](firmware) | ESP32 firmware for gateway, pinsetter, fouling, and speed nodes — ESP-NOW mesh + RS-485 fallback transport |
| `hardware/` | Hardware references and board notes (placeholder — empty for now) |
| [`software/lanecompute/`](software/lanecompute) | Per-lane compute node: FastAPI scoring/state-machine backend, vision (pin detection), and the React bowler/overhead UI |
| [`software/openlanescheduler/`](software/openlanescheduler) | Lane reservation and maintenance scheduler — manager dashboard, lane kiosks, mechanics module |
| [`docs/`](docs) | Source for the GitHub Pages site (architecture, mesh protocol, message format, API surface, real-installation walkthrough) |

## Current state

**Today:** pinsetter control, ESP-NOW transport, RS-485 redundant transport, gateway registration/recovery, lane-local game state, REST/WebSocket API, bowler and overhead UIs.

**In progress:** camera pin detection, node health monitoring, dynamic gateway discovery, complete foul/speed integration, production field testing.

## License

[GPLv3](LICENSE)

## Links

- Project repo: [github.com/nicholas-a-hall/openlanelink](https://github.com/nicholas-a-hall/openlanelink)
- [LinkedIn](https://www.linkedin.com/in/nicholashall87/) · [nicholas-a-hall.github.io](https://nicholas-a-hall.github.io)
