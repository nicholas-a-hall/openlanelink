# openlanelink — handoff notes

Bowling-lane automation on ESP32 boards talking over ESP-NOW.

## Sketch layout
Arduino IDE requires each sketch in its own folder matching the `.ino` filename:
- `firmware/break_beam_test/break_beam_test.ino` — fouling node
- `firmware/gateway_node/gateway_node.ino` — gateway
- `firmware/pinsetter_node/pinsetter_node.ino` — pinsetter interface
- `firmware/speed_node/speed_node.ino` — ball-speed node
- `firmware/mac_finder/mac_finder.ino` — prints a board's MAC over serial

## Design principles
**Every node hardcodes a lane preset (current approach, not a permanent rule).**
Every ESP-NOW node currently hardcodes its target gateway's MAC (`GATEWAY_MAC`)
and its own lane number(s) at compile time. A real installation has many
lane-pair meshes side by side, all sharing ESP-NOW channel 1. On a full-house
power outage every pair's nodes reboot at once; naive same-network discovery
could let a node from one pair mis-register with a neighboring pair's gateway
under that race, so for now hardcoding sidesteps the problem entirely.
**This is deliberately not the end state** — dynamic gateway discovery with
live peer-table updates is an explicit future goal (the user wants to solve
the race condition above properly rather than permanently avoid it via
hardcoding). Whatever discovery scheme gets designed later must still keep
lane-pair meshes isolated across a simultaneous house-wide reboot; that
constraint doesn't go away, only the hardcoding does.

**Nodes are dumb; the gateway + Pi bridge owns timing/scheduling.** A node
knows nothing about any other node, only the gateway. Its firmware does two
things: emit events (sensor state) and accept/act on commands relevant to its
own function — nothing else. No node computes, correlates, times, or debounces
across multiple readings into a derived result; that logic belongs at the
gateway/Pi level, which sees the whole picture. Concretely: the speed node
emits a raw `MSG_BEAM_EVENT` per beam edge and does no interval math itself
(see `PROTOCOL.md`) — pairing upstream/downstream timestamps into a ball
speed happens on the Pi. Likewise the pinsetter only executes the relay
commands it's given and reports status; it doesn't decide *when* to cycle.

**Messages between nodes stay uniform, regardless of transport.** A node has
one message vocabulary (`NodeMessage`, see `PROTOCOL.md`), not a different
one per wire. **Every node** has two transports — ESP-NOW and a wired RS485
fallback (a shared bus, see "Gateway <-> RS485 fallback bus" below) —
specifically because RS485 exists to **insulate the whole mesh against
ESP-NOW radio failures**, not just one link; for that redundancy to actually
work, both transports have to carry the same messages with the same meaning,
not two independently-maintained protocols that could silently drift apart.
This replaced an earlier design (same day, twice) — first the pinsetter
spoke JSON text on RS485 and a separate binary struct on ESP-NOW (two
protocols for one link), then RS485 itself was scoped to the
gateway↔pinsetter link only before being extended to every node. Both were
corrections of the same underlying mistake this principle rules out.
`MSG_LANE_EVENT`/`MSG_BEAM_EVENT`/`MSG_COMMAND`/`MSG_STATUS`/`MSG_ACK`/
`MSG_SCORE_EVENT` are all dual-sent on both transports unconditionally
(always-on redundancy, not failure-detect-then-failover); where ack/retry
applies (`MSG_STATUS`), a single table is satisfied by whichever transport
an ack arrives on first.

## System architecture
- **Fouling (break-beam) node** — covers *two lanes*, one sensor each: GPIO17 = lane 7, GPIO19 = lane 8. Sends per-lane FOUL/CLEAR to the gateway, dual-sent on ESP-NOW and RS485. Shared local buzzer if either lane is blocked.
- **Gateway node** — learns downstream nodes via dynamic registration (no hardcoded MACs). The **pinsetter node**, not the gateway, owns the lane → relay-channel mapping (see `PROTOCOL.md`). On FOUL: tells the pinsetter to RERACK that lane. (There is no gateway→scoring command anymore — see `PROTOCOL.md`'s note on `CMD_FOUL`/`ScoringCommand` being removed, not just superseded.) Also the shared endpoint every node's RS485 fallback traffic terminates at.
- **Speed node** — covers *one lane pair*, two break-beams per lane (4 sensors total). Does NOT time anything itself — emits a raw `MSG_BEAM_EVENT` (BROKEN/CLEAR, tagged upstream/downstream) per sensor edge, dual-sent on ESP-NOW and RS485, same as the fouling node emits per-lane FOUL/CLEAR. The gateway forwards these to the Pi as-is; pairing the two timestamps into an interval and computing speed is the Pi bridge's job (event timing/scheduling lives off-node — see "Design principle" above and the UART bridge section below).
- **Pinsetter interface node** — Waveshare ESP32-S3-(POE-)ETH-8DI-8RO. Executes relay ops the gateway sends. Up to two pinsetters (one lane pair) per node.
- **Scoring / compute node** — NOT an ESP32 mesh node. A Raspberry Pi wired directly via UART to the gateway (see "Gateway <-> Pi UART bridge" below). Runs game state + scoring: consumes lane/beam events forwarded from the gateway, waits out a cooldown after ball detection, grabs a frame from a USB webcam, determines standing pins/pinfall (camera + pin-position calibration required), and tells the gateway when to cycle the pinsetter and what to broadcast onto the mesh as the score result.

Firmware-side, only the speed node is newly scaffolded and unverified on hardware. The scoring logic itself lives off-mesh on the Pi, not as a fifth ESP32 node.

## Hardware

### Gateway node
Plain ESP32 devkit. Two extra `HardwareSerial` links beyond the USB debug
console, **both pin sets UNVERIFIED — placeholder, confirm against the
actual board**:

| Link | UART | RX | TX | Baud | Purpose |
|---|---|---|---|---|---|
| Pi link | UART2 | 16 | 17 | 115200 | Scoring compute node (see "Gateway <-> Pi UART bridge" below) |
| RS485 | UART1 | 5 | 4 | 9600 | Shared fallback bus reaching every node (fouling, speed, pinsetter), insulates the whole mesh against ESP-NOW failures (see `PROTOCOL.md`) — **baud must match on the wire itself**, though each board's own GPIO numbers don't need to match each other |

### Fouling node
ESP32 30-pin devkit; 2x Baomain E3F-R2NK retroreflective break-beams (NPN, normally-open, open-collector; needs a reflector target); shared 12VDC supply; passive piezo buzzer.

| Signal | GPIO | Lane |
|---|---|---|
| Sensor A (black/OUT) | 17 | 7 |
| Sensor B (black/OUT) | 19 | 8 |
| Buzzer (+) | 4 | (both, shared) |
| RS485 TX | 16 | (fallback bus, placeholder — verify) |
| RS485 RX | 18 | (unused — this node only transmits, placeholder — verify) |

Beam clear = pin HIGH; beam broken = pin LOW. Both sensor pins use `INPUT_PULLUP`. Common ground: 12V supply GND, both sensors' blue wires, ESP32 GND, buzzer GND.

### Speed node
ESP32 devkit; 4x break-beam sensors (same Baomain E3F-R2NK style as the fouling node), two per lane, spaced apart along the lane in the direction of travel ("upstream"/"downstream" beam). GPIO pins **unverified — placeholder, confirm against the actual board before wiring**:

| Signal | GPIO | Lane | Role |
|---|---|---|---|
| Beam A-1 | 25 | 7 | upstream |
| Beam A-2 | 26 | 7 | downstream |
| Beam B-1 | 27 | 8 | upstream |
| Beam B-2 | 32 | 8 | downstream |
| RS485 TX | 16 | — | fallback bus, placeholder — verify |
| RS485 RX | 18 | — | unused — this node only transmits, placeholder — verify |

Same wiring convention as the fouling node (NPN open-collector, `INPUT_PULLUP`, beam clear = HIGH). Avoid GPIO34–39 for these (input-only, no internal pull-up). Emits a `NodeMessage` (`MSG_BEAM_EVENT`, BROKEN/CLEAR, tagged lane + upstream/downstream) on every debounced sensor edge, dual-sent on ESP-NOW and RS485 — no interval math, no timeout logic, no state machine on the node. The Pi pairs the two beams' timestamps into an interval and converts to mph using a configurable beam-spacing constant (`scoring/speed.py`), so re-spacing the sensors doesn't require a reflash, and the timing/pairing logic itself lives in one place instead of being duplicated per node.

### Pinsetter node — relay budget
**Two relays per lane**: one pulse-only CYCLE relay + one latching POWER relay.
So **2 lanes = 4 relays**; the 8RO board's 8 relays cover **two lane pairs (4 lanes)**.

| Channel | Lane | Role |
|---|---|---|
| 1 | 7 | CYCLE (pulse-only) |
| 2 | 7 | POWER (on/off) |
| 3 | 8 | CYCLE (pulse-only) |
| 4 | 8 | POWER (on/off) |
| 5–8 | 9/10 | spare, second lane pair |

Relay driver **confirmed**: TCA9554 @ `0x20`, SDA=42, SCL=41, config reg `0x03`, output reg `0x01`, readback reg `0x00`. Ethernet (W5500) confirmed: SCK 15, MISO 14, MOSI 13, CS 16, IRQ 12.
**Unverified**: DI expander addr (`0x24` placeholder) and RS485 TX/RX pins (17/18 placeholder) — confirm with an I2C scanner / the silkscreen.

## Wire protocol
**See `PROTOCOL.md` — the canonical, detailed reference.** As of 2026-07-18
every node sends exactly one struct shape, `NodeMessage` (72 bytes, fixed),
for every purpose — registration, sensor events, commands, status, acks, and
the broadcast score result — **on every transport it has**. There is no more
per-message-type struct (`LaneEvent`/`BeamEvent`/`RegisterEvent`/
`PinsetterCommand`/`ScoringCommand` are all gone) and **no more JSON or text
grammar anywhere in the mesh** — the pinsetter's status/heartbeat traffic,
previously JSON text, is the same binary struct as everything else
(`MSG_STATUS`, with a packed `MachineRecord` array), whether it goes out over
ESP-NOW or the gateway↔pinsetter RS485 fallback link (see "Gateway <->
Pinsetter RS485 fallback" below). `PROTOCOL.md` has the full struct/enum
definitions, the exact `data[]` layout per message type, and the reasoning
(ESP-NOW's 250-byte cap, no fragmentation, no built-in app-level ack; RS485's
framing needs) that shaped the design.

## Gateway <-> Pi UART bridge
The gateway has a second `HardwareSerial` (UART2, **pins unverified — placeholder,
confirm against the board**: RX=16, TX=17) dedicated to the Pi link at 115200 baud,
separate from the USB `Serial` used for the bench console/logging. This is a raw
byte stream, so messages are framed explicitly (unlike ESP-NOW, which is already
packetized):

```
[0xAA START][LEN uint8][PAYLOAD (LEN bytes)][CHECKSUM uint8 = XOR of LEN and all PAYLOAD bytes]
```

Both sides scan for `0xAA`, read `LEN`, read `LEN` payload bytes, verify the
checksum. On mismatch the whole consumed frame is discarded and scanning
resumes from the next byte (not a byte-by-byte rewind) — adequate for a direct
wired point-to-point link, where the main failure mode is a mid-message
connect rather than random bit corruption. Payload byte 0 is a message-type
discriminator, split into disjoint ranges per direction so a misrouted byte is
obvious in logs:

**Gateway → Pi** (mesh events forwarded down to the Pi, unmodified — no logic applied):
```cpp
enum UartMsgType : uint8_t {
  UART_LANE_EVENT       = 0x01,  // forwards a fouling node's MSG_LANE_EVENT verbatim
  UART_BEAM_EVENT       = 0x02,  // forwards a speed node's MSG_BEAM_EVENT verbatim
  UART_PINSETTER_STATUS = 0x03,  // forwards a pinsetter MSG_STATUS verbatim (any StatusCode)
};
```
`UART_PINSETTER_STATUS` was added 2026-08-06 so the Pi's game state machine has a
real signal for `STATUS_CYCLE_COMPLETE` instead of guessing off a timeout —
every `MSG_STATUS` the gateway receives (any `StatusCode`, not just cycle
completion) is forwarded down verbatim, same "forward raw, let the Pi decide"
pattern as lane/beam events. Only `statusCode`, `laneNumber`, and
`timestampMs` cross the wire — the `MachineRecord` array in the original
`MSG_STATUS` (`data[2..17]`) is not forwarded; add it later if the Pi ever
needs relay/DI state, not just "which status code fired."

**Pi → Gateway** (commands/results the Pi emits):
```cpp
enum UartMsgType : uint8_t {
  UART_PINSETTER_COMMAND = 0x10,  // { command, laneNumber } -> gateway sends MSG_COMMAND{command, laneNumber}
  UART_SCORE_EVENT   = 0x11,  // { laneNumber, ballNumber, pinfallMask u16, timestampMs u32 }
};
```
`UART_SCORE_EVENT` triggers the gateway to send the score onto ESP-NOW via the
**broadcast address** (`FF:FF:FF:FF:FF:FF`, added once as a peer at boot) rather
than a specific registered peer — this is what "every event is broadcast to every
node" means for scoring results: any current or future node/UI listening on the
mesh picks it up without the gateway needing to know who's interested. It's
also enqueued on RS485, which needs no separate broadcast address at all — a
shared bus is inherently broadcast, every node on it sees whatever the
gateway sends. `UART_PINSETTER_COMMAND` (generalized 2026-07-18 from an
earlier cycle-only message — see "Compute node API" below) carries any
`CommandCode`, not just cycle; the resulting `MSG_COMMAND` is sent
point-to-point on ESP-NOW but dual-sent on the RS485 fallback bus (see
below) too — not purely ESP-NOW unicast the way it was before that bus
existed.

This is a new trigger path for `CMD_CYCLE`, distinct from the existing
foul-triggered `CMD_RERACK`: the Pi decides when to cycle *after* it finishes
reading pinfall from the photo, not immediately off a beam break.

## RS485 fallback bus (all nodes)
A second, wired link reaching **every node** — fouling, speed, and
pinsetter, all sharing one physical bus terminated at the gateway — **not**
the Pi link above, a separate UART instance on each board. Added to insulate
the *whole mesh* against ESP-NOW radio failures, not just one link (an
earlier same-day version of this scoped RS485 to the gateway↔pinsetter link
only; extended to every node per an explicit correction — "all should have
rs485 fallback"). Pins on every board are **unverified placeholders**, see
the Hardware section. Baud (9600) must match on the wire.

It's a genuinely **shared, multi-drop bus, not separate point-to-point
links** — the ESP32 only has one spare `HardwareSerial` on the gateway after
the Pi link claims another, so a star of individual RS485 runs to each node
isn't physically possible here even if it were desired; multi-drop is also
just what RS485 is for.

Unlike the Pi link, this carries the **exact same `NodeMessage` struct** as
ESP-NOW (see `PROTOCOL.md`) — no translation, no separate protocol. Framing
mirrors the Pi link's byte-stream framing:
```
[0xAA START][LEN uint8][PAYLOAD = raw NodeMessage bytes][CHECKSUM uint8 = XOR of LEN and all PAYLOAD bytes]
```
`LEN` is always `sizeof(NodeMessage)` — there's no message-type wrapper byte
the way the Pi link has, since `NodeMessage`'s own `msgType` is already the
first payload byte.

`MSG_LANE_EVENT`, `MSG_BEAM_EVENT`, `MSG_COMMAND`, `MSG_STATUS`, `MSG_ACK`,
and `MSG_SCORE_EVENT` all go out on **both** ESP-NOW and RS485, every time,
unconditionally — always-on redundancy, not failure-detect-then-failover.
`MSG_REGISTER` stays ESP-NOW-only for every node: a raw UART bus has no
peer/discovery concept. A single ack/retry table on the pinsetter tracks
`MSG_STATUS` across both transports — an ack arriving via either one
satisfies the same pending entry. The fouling and speed nodes only ever
transmit on RS485 (matching their ESP-NOW behavior — no recv callback,
pure sensor emitters); they never poll it for incoming data. See
`PROTOCOL.md`'s "Dual-send" and "Reliability scope" sections for the full
reasoning, including why this replaced an earlier same-day design where
RS485 spoke JSON text independently of ESP-NOW's binary struct (two
protocols for one link — exactly what the "messages stay uniform regardless
of transport" principle above rules out).

**RS485 has no sender/receiver addressing** in the frame — this works only
because each gateway's mesh currently has at most one node of each type, so
`msgType` (fouling → `MSG_LANE_EVENT`, speed → `MSG_BEAM_EVENT`, pinsetter →
`MSG_STATUS`) already tells the gateway unambiguously who sent a given
frame. A future topology with two nodes of the *same* type on one bus would
break that assumption and need real addressing added; not designed for yet.
See `PROTOCOL.md`'s "RS485 framing".

## Registration
Every downstream node sends a `NodeMessage` (`MSG_REGISTER`) **over ESP-NOW only** on startup **and re-sends it every 10s** (fouling, speed, and pinsetter) so a rebooted gateway re-learns them without node power-cycles. The gateway calls `esp_now_add_peer` on the fly, tracks fouling/speed nodes in `registeredLaneNodes[]`/`registeredSpeedNodes[]` and the pinsetter in `pinsetterMac`, and **silently ignores re-registrations from nodes it already knows** — you should see exactly one `Registered ... node` line per node per gateway boot. **No node MACs are hardcoded on the gateway** (though see the design-principles note above — this asymmetry, downstream nodes hardcoding the gateway but not vice versa, is itself part of what dynamic gateway discovery would eventually change). Only the gateway's MAC (`68:25:DD:32:64:7C`) is hardcoded on the downstream nodes. RS485 never carries registration, for any node — it's a hardwired bus, nothing to discover; see "RS485 fallback bus (all nodes)" above.

## ESP-NOW radio rules — important
- **Channel:** peers must share a radio channel (`ESPNOW_CHANNEL = 1` in all sketches). The gateway and fouling node never join an AP, so they pin the channel explicitly. The pinsetter can only pin it when **not associated to an AP** (i.e. on Ethernet, or after its WiFi attempt times out) — if it does associate, the radio sits on the AP's channel and ESP-NOW silently fails unless the AP is also on channel 1. Prefer Ethernet on the pinsetter.
- **No WiFi power saving, ever:** every node calls `WiFi.setSleep(false)` right after `WiFi.mode(WIFI_STA)`. Modem sleep makes ESP-NOW receivers silently miss packets — this applies even to nodes that never join an AP.
- **Never block on WiFi:** the pinsetter's WiFi fallback is time-boxed (`WIFI_CONNECT_TIMEOUT_MS = 15s`). On timeout it calls `WiFi.disconnect()` (a scanning STA hops channels, which also breaks ESP-NOW) and continues ESP-NOW-only with no IP network. The original test firmware looped forever waiting for WiFi, which kept `setup()` from ever reaching ESP-NOW init — that was why the pinsetter never registered (endless `....` on serial).

## Firmware state
`break_beam_test.ino` — debounced (30ms) per-lane reads, per-lane FOUL/CLEAR dual-sent on ESP-NOW and RS485, buzzer warble (700/1300Hz) while either lane is blocked. ESP-NOW behavior verified on hardware; RS485 fallback added 2026-07-18, not yet tested.

`gateway_node.ino` — dynamic registration for fouling, speed, and pinsetter nodes (ESP-NOW only); sends pure semantic `NodeMessage{MSG_COMMAND, code=CommandCode, laneNumber}` (the pinsetter resolves relays itself), dual-sent on ESP-NOW and RS485. On FOUL sends `CMD_RERACK`. **Per-lane foul cooldown** (`FOUL_COOLDOWN_MS = 750`): a trip over the line produces several FOUL edges in quick succession — only the first triggers the pinsetter re-rack; repeats within the window are logged as `Foul cooldown active ... repeat suppressed`. The serial console's manual `cycle`/`rerack` bypass the cooldown (bench tool). `PINSETTER_ENABLED=true`, `RS485_ENABLED=true`. Acks the pinsetter's `MSG_STATUS` messages (received on either transport) with a dual-sent `MSG_ACK` — see `PROTOCOL.md`. `MSG_LANE_EVENT`/`MSG_BEAM_EVENT`/`MSG_STATUS` all dispatch through one shared `handleIncomingNodeMessage()` regardless of which transport (ESP-NOW or RS485) they arrived on; `MSG_REGISTER` stays ESP-NOW-only and handled separately (needs a MAC). Forwards every lane/beam event to the Pi over UART2 as-is, with no interval/timing logic applied on the gateway either; a `UART_SCORE_EVENT` from the Pi is broadcast onto both ESP-NOW (`FF:FF:FF:FF:FF:FF`) and RS485 (inherently broadcast on a shared bus) as `MSG_SCORE_EVENT`. **Serial bench console @9600**: `cycle <lane>`, `rerack <lane>`, `respot <lane>`, `power <lane> on|off`, `pstatus`, `status`.

`speed_node.ino` — one lane pair, 2 break-beams per lane. No local timing/state machine: debounces each sensor and emits `MSG_BEAM_EVENT` (BROKEN/CLEAR, upstream/downstream) on every edge, dual-sent on ESP-NOW and RS485, same shape as the fouling node's per-sensor emission. Registers as `NODE_SPEED` (ESP-NOW only). Not yet bench-tested; GPIO pins (sensors and RS485) are placeholders.

`pinsetter_node.ino` — from the tested Waveshare firmware: Ethernet + time-boxed WiFi fallback, RS485, OTA, ack/retry, DI polling, plus the openlanelink protocol. The WebServer/REST layer was removed (2026-07-14, user's call) — command paths are ESP-NOW and RS485, both carrying the same binary `NodeMessage` (JSON is gone entirely, including RS485's old `ch:`/`pulse:`/`all:`/`ack:` text grammar — see `PROTOCOL.md`). `MSG_STATUS` is dual-sent on both transports every time; a single `pending[]` ack/retry table is satisfied by an ack from either one. `MSG_REGISTER` stays ESP-NOW-only. A shared `handleIncomingNodeMessage()` dispatches incoming `MSG_COMMAND`/`MSG_ACK` identically regardless of which transport they arrived on. Executes `CMD_CYCLE` as a pulse and `CMD_POWER_ON/OFF` as a latch, on the relay channel it resolves itself from `MACHINES[]`.

### Two changes made to the tested firmware (deliberate)
1. **Bug fix in `sendStatus()`** — the original had a stray escaped quote after seq, emitting malformed JSON (`"seq":0","type":...`). Relays still worked, so a relay-only test wouldn't catch it, but the gateway can't parse it to ack. Fixed.
2. **`PULSE_ONLY_MASK` safety guard** — the original `execAll(true)` set `relayState = 0xFF`, which would latch the *cycle* solenoids on. Cycle relays are pulse-only by design; holding one energized can jam/damage a pinsetter. Toggle/all-on requests targeting a masked channel are now refused (`refused_pulse_only`). Mask is `0b00000101` (ch1, ch3) for one lane pair; use `0b01010101` if lanes 9/10 are wired.

## Next
1. Bench test the full chain: fouling node boots → gateway logs `Registered FOULING node`; pinsetter boots → `Registered PINSETTER node`; break a beam → gateway sends `CMD_RERACK`, pinsetter sequences its re-rack cycles.
2. Drive the gateway serial console directly (`power 7 on`, `cycle 8`, `rerack 8`) to test relays without tripping beams.
3. Verify the DI expander address and RS485 pins on **every board** — pinsetter, gateway, fouling, and speed. The gateway/fouling/speed RS485 transceivers and pins are all brand new, entirely unverified (see the Hardware section); only the pinsetter's RS485 pins predate this session, and even those were never bench-tested.
4. Confirm each machine's relay channel assignment matches real wiring in the pinsetter's own `MACHINES[]` (no longer on the gateway).
5. Set a real `otaPassword` on the pinsetter node (currently `changeme`).
6. Verify the speed node's GPIO assignment and UART2 pins on the gateway (both placeholders — see above); bench test beam-A→beam-B pairing on the Pi (`main.py`'s `on_beam_event`) before trusting speed numbers.
7. Build out the Pi-side scoring project (`doodles/openlanelink/scoring/`): camera capture, pin-position calibration, and pinfall detection are still not implemented. The UART bridge + protocol scaffold and the speed-pairing/timeout logic are done; the game-state/REST-and-WebSocket API layer is in progress as of 2026-07-18 (see `scoring/README.md` for current status). `UART_PINSETTER_COMMAND` (generalized from a cycle-only message) and `UART_SCORE_EVENT` are the command paths this layer uses to reach the mesh.
8. Bench test the unified `NodeMessage` protocol (`PROTOCOL.md`) on real hardware — implemented 2026-07-18 across all four sketches (previously JSON on the pinsetter, now binary `MSG_STATUS` on both transports; RS485 extended from pinsetter-only to every node later the same session) but not yet flashed/verified. Watch especially for: the `MachineRecord` bit-packing round-tripping correctly, the gateway's UART translation to the Pi producing byte-identical payloads to before (scoring/protocol.py is unchanged and expects the old shapes), and the RS485 shared bus actually working end-to-end with all four boards wired to it (entirely new hardware on the gateway/fouling/speed side — the transceivers don't physically exist yet). Specifically confirm: a `MSG_STATUS` sent with ESP-NOW deliberately jammed/out of range still arrives and gets ack'd via RS485 alone, and that a `MSG_LANE_EVENT`/`MSG_BEAM_EVENT` shows up at the gateway via RS485 under the same condition.
