---
layout: default
title: Open Lane Link
---

## Background

My family and I bought a small, inactive bowling alley in Hillsboro Illinois after a personally, professionally, and financially difficult year. We looked around in our local community and found few places for people to gather together and have a good time. Our idea was simple - there isn't much for our kids to do, so let's build something for them. Our friends and neighbors can come, too.

What we didn't fully realize is what a battle it would be to do so.

Our pinsetters made horrible noises when they first activated. None of the 8 cycled perfectly. It took our family three weeks to bowl a complete game together. Our scoring was locked out, our fouling didn't work, our roof leaked, and our bar area needed a top-to-bottom remodel. Running out of time and money, we upgraded and repaired what we could, isolated sections that were under construction from the public, and opened our doors.

We've faced plumbing problems, A/C and facilities issues, broken pinsetters, uneven lanes, broken ball returns and more. Finally, eventually… we ran into a problem we couldn't fix. A power surge from the transformer that fed our building fried multiple arcades, some partner equipment, and one of our lane computers.

The cost was more than we could afford, so as a 21-year technology veteran, I started building my own system instead.

## Concept

Scoring systems are one of the single most expensive pieces of equipment in a bowling center, for good reason. They often form the backbone of a center's operation - running everything from point-of-sale, shoe rental, arcade token tracking, league tracking, and then some. All of this is in addition to the scoring, pinsetter control, and rich media features that any given scoring system on the market provides. A scoring system is therefore incredibly important to the operation of a modern center - especially one that runs lean, with minimal staff available during the off-season.

On the other hand, operating a lane with a Brunswick A2 is relatively simple. The basic workflow is easy: Detect a ball, wait a few seconds, count the standing pins on the deck, take score, read pinsetter state (ball 1, 2, out-of-range), trigger pinsetter cycle mechanism. There are of course edge cases and more advanced logic at play, but the critical path is clear.

As bowling is a relatively small industry, solutions for it are niche, and often kept behind closed doors. There are few (if any) open-source projects designed for supporting a bowling center. As a result, any software required for the operation of a bowling center at any scale often comes with a large capital expense. While bowling is an event-driven, data-rich sport; scoring systems are frequently closed in nature. This data therefore stays locked behind whatever interfaces are made available at time of purchase, limiting a proprietor's opportunity to innovate within their business.

By creating an open-source-first alternative, using commodity hardware, OpenLaneLink aims to enable proprietors of any size center. Its goals are to expose the data layer, enable a proprietor's ability to innovate and pivot rapidly, and keep costs minimal by using common components with rapid-replacement capabilities in lieu of purpose-built hardware.

In other words, the goal is simple: We want there to be more bowling centers in the world. We built OpenLaneLink to help make that possible.

## Current state

**Today**
- Pinsetter control
- ESP-NOW transport
- RS-485 redundant transport
- Gateway peer registration, with a compute-node-owned allowlist the gateway caches and enforces
- Generic firmware provisioning — every leaf sketch is identical on every lane pair
- Lane-local game state
- REST/WebSocket API
- Bowler and overhead UIs
- Camera pin detection
- UART Bridge integration

**In progress**
- Complete foul/speed integration
- Production field testing

**To-do**
- Node identity in NVS + pair-button provisioning
- Gateway failure/replacement recovery
- Node health monitoring
- Optimize pinsetter & gateway firmware
- Performance improvements & reliability upgrades, vision service


## Requirements

- **Lane-pair survivability**: a lane must keep bowling with zero server dependency during an active session. If the site aggregator, Redis, or the network dies mid-frame, the lane still detects pins, scores, and cycles the pinsetter. Loss of upstream = loss of visibility, not loss of function.
- **Vendor lock avoidance**: relay/optocoupler deploy pattern over OLL interconnects.
- **Hot-swap in 5 minutes**: any node can be pulled and replaced with a cold spare in ~5 min. A spare must not need per-node configuration at swap time. *Partly met:* sensor and pinsetter firmware is now identical on every lane pair — a cold spare needs only its gateway's MAC, because nodes address the two **sides** of their pair rather than lane numbers. Removing that last constant is what the pair-button provisioning below is for.
- **Commodity hardware only**: no purpose-built boards where an ESP32 + off-the-shelf sensor does the job. Cost and repairability over elegance.

## Architecture overview

Every major component service and its current implementation status. **Green** is implemented and tested, **gold** is in progress or awaiting verification, **blue** is future work.

![Critical path diagram]({{ '/assets/critical-path.svg' | relative_url }})

Every major component service and its current implementation status. **Green** is implemented and tested, **gold** is in progress or awaiting verification, **blue** is future work.

- **Transport, last hop**: ESPNow primary, RS-485 wired fallback. These are orthogonal failure axes — RS-485 isn't a degraded ESPNow, it's a second physical path.
- **Per-lane compute**: Raspberry Pi. Runs the lane's local state machine, redis, and MQTT client. This is the box that keeps the lane alive if the site bus goes down.
- **Site message bus**: Redis Streams, unified from lane-local through site aggregation.
- **Integration bus**: separate MQTT bus, kept deliberately decoupled from the core Redis Streams bus, so external integrations (Home Assistant, etc.) can't back-pressure or couple to internal lane logic. MQTT is an optional egress adapter only — not a control path.
- **Server authority model**: async-only. The server does not hold synchronous authority over lane hardware. Commands go out, lanes act on local authority, state reconciles.

## Hardware requirements

Every node has exactly one job, done well. ESP nodes never communicate node-to-node — all traffic routes through the gateway. The compute node bridges the ESPNow mesh to other protocols and, through its REST API, requests operations like a pinsetter cycle — but it doesn't hold hardware command-and-control authority. The gateway is the only node with that authority over every other node type; the compute node's requests still flow through it.

| Node | Hardware | Per | Job |
|---|---|---|---|
| Gateway | Plain ESP32, UART to compute node | Lane-pair | Command-and-control authority over every other node type |
| Compute | Raspberry Pi (model flexible; needs WiFi, UART, sufficient CPU/RAM) | Lane-pair | Bridges ESPNow mesh traffic to other protocols (Redis, MQTT, ESP32 bridge middleware); runs each lane's state machine and the UI websocket server |
| Pinsetter interface | Waveshare ESP32-S3-ETH-8DI-8RO + 8-channel optocoupler board | Lane-pair | Senses and switches pinsetter control signals on gateway command |
| Pin-count sensor | ESP32-CAM | Lane | Reports standing pin count |
| Fouling sensor | Baomain E3F-R2NK retroreflective break-beam | Lane-pair | Detects foul line violations |
| Ball-speed sensor | 4x Baomain E3F-R2NK retroreflective break-beam (2 per lane) | Lane-pair | Calculates ball speed |
| Ball-detect sensor | 2x Baomain E3F-R2NK retroreflective break-beam (1 per lane) | Lane-pair | Positioned just before the pin deck; notifies the gateway a ball has arrived, which is what starts vision capture → scoring → pinsetter cycle. Independent of the ball-speed node: either can serve as a lane's trigger, both can coexist, and a lane can run neither (scoring still accepts pinfall reports without any beam at all) |

No pinsetter observability/telemetry stack in this draft — sensing is scoped to scoring-path inputs only.

## Mesh protocol: peer registration

Nodes provision once, then rejoin silently on every boot after that — identity is stored in NVS (non-volatile storage), the ESP32's onboard flash-backed key-value store that survives power loss.

**Initial provisioning** (one node at a time, operator in the loop):

![Initial provisioning flow]({{ '/assets/flow-initial-provisioning.svg' | relative_url }})

**Normal boot** (after power loss, any number of nodes simultaneously):

![Normal boot flow]({{ '/assets/flow-normal-boot.svg' | relative_url }})

**Corrupted NVS:**

![Corrupted NVS flow]({{ '/assets/flow-corrupted-nvs.svg' | relative_url }})

The peer registry itself lives upstream (`MAC address → { lane_id, node_role, provisioned, last_seen }`). The gateway holds a local copy of its own lane-pair's slice; edge nodes only know their own identity and the gateway's MAC.

**Built so far:** the upstream registry and the gateway's cached copy of it. The compute node owns an allowlist of `{MAC, nodeType}`, pushes it to the gateway over the UART link, and the gateway caches it in NVS and enforces it on every inbound ESP-NOW frame — reporting every registration attempt, accepted or refused, back upstream. Until an allowlist is first pushed the gateway stays *ungoverned* and accepts anyone, so a fresh install still comes up unattended. Enforcement is ESP-NOW-only; RS485 frames carry no sender address and that bus is trusted because each pair has its own isolated segment.

**Not built yet:** edge nodes have no NVS identity — `GATEWAY_MAC` is still compile-time, so there is no provisioning handshake pushing identity *down* to a node, no `provisioned` flag, and no corrupted-NVS recovery path. The gateway failure mode below is also still a design, not code.

## Mesh protocol: gateway failure mode

The gateway is a plain ESP32 with no redundancy of its own, and it's the single point every edge node depends on for command-and-control — so a dead gateway needs a recovery path that doesn't require touching every node by hand.

Nodes trust a gateway by its ESPNow MAC, so a straight hot-swap breaks that trust: the replacement comes up with a different MAC and every node still has the dead one cached. The fix rides on the UART link the gateway already has to the compute node, rather than adding a new comms path:

![Gateway failure recovery flow]({{ '/assets/flow-gateway-failure.svg' | relative_url }})

The compute node already knows the current gateway's MAC from their UART heartbeat, so it doesn't depend on the dead gateway to supply it. Nodes don't trust *any* gateway that shows up — they only re-pair with one that can prove, via the MAC the compute node hands it, that it's the legitimate successor to the gateway they already trusted.

## Mesh protocol: message format

Every node, for every message type, sends the same struct — regardless of which transport carries it. There's no separate binary protocol for ESP-NOW and text protocol for RS485; both wires carry identical bytes, just packaged differently.

```cpp
struct NodeMessage {
  uint8_t msgType;       // what kind of message this is
  uint8_t seq;           // ack/retry correlation
  uint8_t code;          // msgType-scoped sub-code
  LaneSide laneSide;     // A or B side of this gateway's lane pair; NONE = node-level
  uint32_t timestampMs;  // sender's own millis()
  uint8_t data[64];      // msgType-specific payload
};                        // 72 bytes, fixed, every message, every transport
```

There are **no lane numbers anywhere on the mesh**. A gateway's mesh is
exactly one lane pair, so a message only ever names which of the pair's two
*sides* it concerns. That is what makes firmware generically provisionable —
every leaf sketch is identical on every pair in the house, with the gateway's
MAC the only per-pair constant — and the side → real lane number mapping
lives once, in software, on the compute node.

- **ESP-NOW** carries `NodeMessage` as the packet payload directly — ESP-NOW is already packetized by the radio, so no extra framing needed.
- **RS485** is a raw byte stream, so it wraps the same struct in an explicit frame: start byte, length, payload, XOR checksum. Every node's operational traffic goes out on both transports at once — not failure-detection-then-failover, always-on redundancy.

The uniform format means every receive handler dispatches on `msgType` first, on either transport — there's no "binary vs. text" disambiguation and no second protocol to keep in sync with the first.

`NodeType` isn't repeated on every message — it only appears once, in `MSG_REGISTER`'s `code` field, sent at boot and every 10s. After that, the mesh relies on a structural assumption: each gateway's mesh has at most one node of each type, so `msgType` alone tells the receiver who must have sent it (`MSG_LANE_EVENT` can only come from the fouling node, `MSG_STATUS` only from the pinsetter). This is the same assumption RS485 framing leans on for sender identification, since the RS485 frame carries no addressing at all. Breaks if a future topology puts two same-type nodes on one bus — not designed for yet.

`MSG_BEAM_EVENT` is the one type with two possible senders (speed node and ball detection node), and it doesn't strain that assumption: nothing downstream needs to know which *board* sent one. The gateway forwards every beam event unchanged, and the Pi keys off the beam role — a property of the beam's purpose, not the sender's identity.

### Message types

| `msgType` | Direction | Transport | Purpose |
|---|---|---|---|
| `MSG_REGISTER` (0) | any node → gateway | ESP-NOW only | boot announce + heartbeat, every 10s |
| `MSG_LANE_EVENT` (1) | fouling → gateway | dual-sent | foul/clear edge |
| `MSG_BEAM_EVENT` (2) | speed *or* ball detect → gateway | dual-sent | break-beam edge (`data[0]` = beam role: 0 upstream, 1 downstream, 2 ball-at-pins) |
| `MSG_COMMAND` (3) | gateway → pinsetter | dual-sent | cycle, power, rerack, respot, status request |
| `MSG_STATUS` (4) | pinsetter → gateway | dual-sent | relay/DI state, machine records, heartbeat |
| `MSG_SCORE_EVENT` (5) | gateway → broadcast | dual-sent | pinfall mask per ball |
| `MSG_ACK` (6) | gateway → pinsetter | dual-sent | acks a received `MSG_STATUS` |

`MSG_REGISTER` stays ESP-NOW-only because a raw UART bus has no discovery concept — RS485 doesn't need it. Every other message type goes out on both transports, unconditionally, every time — not failure-detection-then-failover, always-on redundancy. Sending is gated independently per channel: ESP-NOW sends require the peer to have registered; RS485 sends only require the hardware to be present, so RS485 keeps working even if ESP-NOW registration never completed.

### RS485 framing

RS485 is a raw byte stream, so it wraps the identical 72-byte struct in an explicit frame:

```
[0xAA START][LEN uint8][PAYLOAD (LEN bytes = the raw NodeMessage struct)][CHECKSUM uint8 = XOR of LEN and all PAYLOAD bytes]
```

`LEN` is always 72. Both sides scan for `0xAA`, read `LEN`, read `LEN` payload bytes, verify the checksum. On mismatch the whole frame is discarded and scanning resumes from the next byte. It's a shared multi-drop bus — gateway, fouling, speed, ball detect, and pinsetter all tap the same physical wire pair, not point-to-point links, since the gateway only has one spare UART left after the Pi link.

### Worked example: a foul event on the wire

A `MSG_LANE_EVENT` for the **B side** of a pair going into foul state, at `timestampMs = 0x0001E240` (123456 ms since boot):

```
msgType     = 0x01              // MSG_LANE_EVENT
seq         = 0x00              // unused for this type, fire-and-forget
code        = 0x01              // LANE_FOUL (0x00 would be LANE_CLEAR)
laneSide    = 0x02              // LaneSide::B (0x01 = A, 0x00 = node-level)
timestampMs = 40 E2 01 00       // little-endian uint32
data[64]    = 00 00 00 ... 00   // unused, zeroed
```

That's the raw 72-byte payload ESP-NOW sends as-is. Framed for RS485, with `LEN = 0x48` (72 decimal):

```
AA 48 01 00 01 02 40 E2 01 00 [64 zero bytes] <checksum>
```

`checksum` is the XOR of `LEN` and all 72 payload bytes. To write a test: construct that byte sequence, compute the XOR checksum, feed it to the RS485 receive parser, and confirm it decodes back to `laneSide=B, code=LANE_FOUL`. Same struct works for an ESP-NOW loopback test — skip the frame entirely and hand the raw 72 bytes straight to the receive callback.

### Reliability

Only `MSG_STATUS` is tracked with seq/ack/retry — a single pending table on the pinsetter keyed by `seq`, satisfied by an ack arriving on *either* transport. Backoff is exponential from a 300ms base (300ms, 900ms, 2100ms), giving up after 3 retries. Every retry is dual-sent again.

`MSG_COMMAND` (gateway→pinsetter) must execute exactly once. Dual-sending the same command on both ESP-NOW and RS485 already means the pinsetter can see the same `seq` twice under normal operation, not just on retry — the pinsetter dedupes on `seq` before acting, so a duplicate delivery is a no-op rather than a second cycle. This matters more than it looks: without dedup, a slowdown or bus contention that delays one transport's copy relative to the other can execute the same rerack or cycle command twice in quick succession — rapid batch cycling that could damage the pinsetter or double-count a rack. `MSG_COMMAND` isn't ack/retry-tracked the way `MSG_STATUS` is, but exactly-once execution on the receiving end is a hard requirement independent of that.

Register, lane, and beam events are fire-and-forget by design: a lost sensor edge is a missed reading, not a stuck state, and retrying a stale edge after the fact isn't useful.

### Heartbeat and status

Every node's registration is also its heartbeat: `MSG_REGISTER` fires once at boot and again every 10s, for the node's entire lifetime, not just at startup. The gateway treats a re-registration from an already-known node as a silent liveness confirmation — it logs nothing and doesn't re-add the peer, it just knows the node is still alive. This exists so a *rebooted gateway* can re-learn its nodes, not so the gateway can detect a *dead* one — there's currently no explicit timeout/offline detection. If a node stops re-registering, nothing notices.

The pinsetter interface node carries a second, independent heartbeat on top of that: an explicit `STATUS_HEARTBEAT` every 5000ms, dual-sent on both transports, unsynchronized with the 10s register cycle. It's one of several `StatusCode` values a `MSG_STATUS` datagram can carry:

```cpp
enum StatusCode : uint8_t {
  STATUS_RELAY_ACK = 0, STATUS_PULSE_ACK = 1, STATUS_PULSE_COMPLETE = 2,
  STATUS_ALL_ACK = 3, STATUS_RELAY_FAULT = 4, STATUS_REFUSED_PULSE_ONLY = 5,
  STATUS_MACHINE_STATUS = 6, STATUS_RESPOT_STUB = 7, STATUS_DI_CHANGE = 8,
  STATUS_HEARTBEAT = 9, STATUS_CYCLE_COMPLETE = 10,
};

struct MachineRecord {       // 4 bytes, naturally aligned, no padding
  uint8_t laneSide;          // LaneSide; NONE (0) = unused slot
  uint8_t flags;             // bit0=on, bit1=cycling, bit2=ball(0=1st/1=2nd), bits3-4=pendingCycles(0-3)
  uint16_t cooldownMs;       // full ms precision
};
```

Every `MSG_STATUS`, regardless of which `StatusCode` triggered it, carries the same `data[]` layout — a status datagram never sends a partial picture:

| `data[]` bytes | contents |
|---|---|
| `data[0]` | `relayState` — raw 8-bit relay bitmask |
| `data[1]` | `diState` — raw 8-bit digital-input bitmask |
| `data[2..17]` | up to 4 `MachineRecord`s, 4 bytes each — always all machines on the node, regardless of which event triggered the send |
| `data[18..63]` | reserved, zeroed — headroom for future fields without another protocol-breaking redesign |

`laneSide` follows the same split as the rest of the protocol: the specific side for single-machine events (`STATUS_RELAY_ACK`, `STATUS_PULSE_ACK`, `STATUS_PULSE_COMPLETE`, `STATUS_REFUSED_PULSE_ONLY`, `STATUS_CYCLE_COMPLETE`, `STATUS_RESPOT_STUB`), and `NONE` for node-level events that describe every machine at once (`STATUS_ALL_ACK`, `STATUS_RELAY_FAULT`, `STATUS_MACHINE_STATUS`, `STATUS_DI_CHANGE`, `STATUS_HEARTBEAT`).

Digital input is polled every 100ms on the pinsetter node, but only produces a `STATUS_DI_CHANGE` datagram on an actual state change — it's edge-triggered, not periodic. The periodic signal is `STATUS_HEARTBEAT` alone.

**Todo:** heartbeats should double as health/status checks. The offline-detection gap above doesn't need a new message type to fix — `MSG_REGISTER` and `STATUS_HEARTBEAT` already carry a timestamp and a known sender; the gateway just needs to track last-seen-per-node against those and flag anything that's gone quiet. Same principle either could be extended to carry lightweight health data (uptime, RSSI, error state) in the reserved `data[18..63]` bytes without another protocol-breaking redesign.

## API surface: Pi REST API

The scoring compute node runs a FastAPI service that exposes game state and mesh commands to the UI and any other programmatic client. Interactive docs are auto-generated at `/docs` once it's running.

| Method | Path | Bucket | Notes |
|---|---|---|---|
| `GET` | `/api/lanes/{lane}` | — | full lane snapshot (bowlers, frames, running scores) |
| `POST` | `/api/lanes/{lane}/pinsetter/cycle` | mesh | 503 if not connected to the gateway |
| `POST` | `/api/lanes/{lane}/pinsetter/rerack` | mesh | 503 if not connected to the gateway |
| `POST` | `/api/lanes/{lane}/bowlers` | game state | add a bowler |
| `PUT` | `/api/lanes/{lane}/bowlers/{id}` | game state | rename a bowler |
| `DELETE` | `/api/lanes/{lane}/bowlers/{id}` | game state | remove a bowler |
| `POST` | `/api/lanes/{lane}/games` | game state | fresh scoresheet for the current roster |
| `PUT` | `/api/lanes/{lane}/bowlers/{id}/score` | game state | manual ball correction |
| `POST` | `/api/lanes/{lane}/assistance` | isolated | summons staff — deliberately kept separate from game state |
| `WS` | `/ws/display/{lane}` | — | read-only broadcast, overhead monitor |
| `WS` | `/ws/control/{lane}` | — | same broadcast, bowler tablet — commands go through REST above, not this socket |

The mesh-facing bucket is the REST layer's thin wrapper over the gateway UART bridge: those two endpoints fail with a 503 rather than blocking or erroring ambiguously if the Pi isn't currently connected to its gateway, since the service is designed to start and serve the rest of the API even with no hardware attached.

Both WebSocket endpoints are read-only broadcast — a control tablet sends its commands through REST, then gets state updates pushed back over its own socket like every other client. There's no command channel on the socket itself, which keeps the write path in one place regardless of which client issued it.

## API surface: UART bridge

A second, smaller service owns the serial link to the gateway and nothing else. Everything upstream of it — the scoring API above, the vision daemon, the UI — reaches the mesh through it rather than opening the port themselves, so exactly one process talks to the hardware.

It is also the boundary where mesh identity becomes lane identity, in both directions: the mesh reports which **side** of a lane pair an event concerns, and this service resolves that to a real lane number before publishing. Nothing above it ever sees a side.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | link state, the configured A/B → lane mapping, and peer counts. Returns 200 even with no gateway attached — "is the process up" and "is the mesh reachable" are separate questions |
| `WS` | `/events` | read-only broadcast of every decoded mesh event, in lane numbers |
| `POST` | `/commands/pinsetter`, `/commands/cycle`, `/commands/rerack`, `/commands/score-event` | outbound to the mesh; the lane number is mapped back to a side here |
| `GET` | `/peers` | every node MAC the gateway has reported, allowed or not |
| `GET` | `/peers/pending` | seen on the mesh but not yet allowed — the operator's work queue |
| `POST` | `/peers/{mac}/allow` · `/peers/{mac}/deny` | grant or revoke; the updated allowlist is pushed to the gateway immediately |

**Why allowing a node is a human decision.** Every node hardcodes its gateway's MAC, so a correctly flashed one can only ever reach its own gateway. A *mis*flashed one reaches whichever gateway that MAC names — and because every leaf sketch is now identical across pairs, its events are indistinguishable from the real node's. Nothing in software can tell "my fouling node" apart from "the neighbouring pair's fouling node, flashed wrong". So the gateway enforces a list rather than guessing, and a person decides what goes on it.

A gateway with no allowlist yet accepts anyone, which is what lets a fresh install come up unattended; the first allow ends that. The compute node persists the list and re-pushes it whenever the link reconnects, and the gateway keeps its own copy in flash so it keeps enforcing while the Pi is down.

## UI: React front end

Two screens per lane: a 16:9 overhead monitor and a 9:16 bowler-facing control tablet, each pointed at its own device (`/display/:laneId`, `/control/:laneId`). Built on Vite + React Router. Game state is pushed down from a per-lane WebSocket service run by the compute node; the front end's own hooks (`useLaneFeed`, `useTakeoverFeed`) are the sole integration points for that feed, so the components consuming them stay decoupled from wherever the data actually comes from.

## Top of mind todos

Loose threads in the current design, gathered here instead of scattered through the sections above:

- **No node liveness/timeout detection.** The gateway has no mechanism to notice a node that's gone silent — the 10s `MSG_REGISTER` re-announce only lets a *rebooted gateway* re-learn its nodes, it was never meant to detect a *dead* one. Flagged above as a todo: extend the existing heartbeats to double as health/status checks rather than adding a new message type.
- **`MSG_SCORE_EVENT` has no consumer yet.** The gateway broadcasts it whenever the Pi emits a score event, but no node currently acts on it — it's there for a future display/UI node that doesn't exist yet. Every receiver's default dispatch already ignores unrecognized-but-valid message types harmlessly, so broadcasting it early costs nothing.
- **RS485 has no sender/receiver addressing.** The frame carries no source identifier — it works today only because each gateway's mesh has at most one node of each type, so `msgType` alone disambiguates who sent it. Breaks the moment a future topology puts two same-type nodes on one shared bus; not designed for yet.
- **Gateway MAC is hardcoded at compile time**, not dynamically discovered. It is now the *only* per-pair constant left in a leaf sketch — everything else became generic when the mesh dropped lane numbers for A/B sides. The intended end state is node identity in NVS plus a **pair button** on the board: an unprovisioned node stays quiet until a human presses it, which is what removes the house-wide-reboot race that made naive discovery unsafe in the first place. Designed, not built.
- **Gateway failure/replacement is designed, not built.** The flow above depends on nodes having a stored gateway MAC to verify a claimed successor against, which only exists once the item above lands. Note also that the compute node has to be the one that declares the incumbent dead — a degraded-but-alive gateway would otherwise leave two boards claiming one identity.
- **`CMD_RESPOT` is a stub.** It logs and acks but doesn't do anything yet.
- **`MSG_COMMAND` still isn't ack/retry-tracked.** Duplicate *execution* is handled — both the gateway and the pinsetter now drop the second copy of a dual-sent message by keying on the whole message, so a command runs exactly once however the two transports interleave. Delivery is the remaining gap: A command lost on both transports simultaneously still silently never arrives — dual-sending reduces that risk, it doesn't eliminate it. Extending `MSG_ACK` to cover commands, not just `MSG_STATUS`, is the natural fix and doesn't need another protocol redesign.

## Contributing

Issues and PRs are welcome — the project is GPLv3, so contributions are too.

A few conventions in this codebase are load-bearing rather than stylistic, and the [repo README](https://github.com/nicholas-a-hall/openlanelink#contributing) covers them properly: installing the shared firmware library before anything will compile, the order to change the wire protocol in, why the two `protocol.py` files are deliberately *not* identical any more, and how to verify a change end to end with no hardware attached.

The short version of the design rules: nodes are dumb and never correlate across readings; the mesh has no lane numbers; one message struct on every transport; `NodeMessage` stays exactly 72 bytes; and each lane pair needs its own isolated RS-485 segment. Each of those exists because breaking it caused a real bug, and the reasoning is written up in `firmware/PROTOCOL.md` and `firmware/HANDOFF.md` rather than left to be rediscovered.

---

This project and spec are a work in progress, updated regularly.

Project repo: [github.com/nicholas-a-hall/openlanelink](https://github.com/nicholas-a-hall/openlanelink)
[LinkedIn](https://www.linkedin.com/in/nicholashall87/) · [nicholas-a-hall.github.io](https://nicholas-a-hall.github.io)
