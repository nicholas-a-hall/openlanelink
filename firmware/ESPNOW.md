# openlanelink — mesh protocol reference (ESP-NOW + RS485 fallback)

Per-node reference: what each node **emits** (events), what it **accepts**
(commands), and its **heartbeat/liveness timing**. This is a structured
companion to `HANDOFF.md` (narrative history, design principles,
hardware/pin details) and `PROTOCOL.md` (the exact `NodeMessage`
struct/enum definitions and full `data[]` layout, for both transports) —
this doc is the per-node behavioral summary that sits between the two. All
nodes share ESP-NOW channel 1 and, for now, hardcode their gateway's MAC at
compile time (dynamic gateway discovery is a planned future direction, not
implemented — see `HANDOFF.md`'s design principles).

Every node also has a **wired RS485 fallback** — a shared bus, not separate
point-to-point links (the gateway only has one spare `HardwareSerial` for
it) — carrying the exact same messages as ESP-NOW. It exists to insulate the
whole mesh against ESP-NOW radio failures, not just one link.

## Topology
Star topology over ESP-NOW: gateway at the center, every downstream node
only ever talks to the gateway over the radio — it has no knowledge of any
other node, and no other node's MAC is ever hardcoded anywhere except the
gateway's. RS485 is physically a shared bus underneath that same logical
star (every node's operational traffic still only means something to the
gateway; see "One message shape" below for how sender identity works
without addressing). The one ESP-NOW exception is the gateway's
**broadcast** send (`FF:FF:FF:FF:FF:FF`), which any node on the channel can
passively receive without being added as a peer — see "Known gaps" at the
bottom.

```
   fouling ─┐
   speed   ─┼══► gateway ◄══► pinsetter   (══ = ESP-NOW + RS485, dual-sent;
  (scoring) ─┘        │                     RS485 is one shared bus, not
                       ▼ UART (framed,       separate wires per node)
                          separate protocol)
                   Pi (scoring compute)
```

## One message shape for everything, on every transport
Every node, for every purpose, sends the same fixed 72-byte
`NodeMessage{msgType, seq, code, laneNumber, timestampMs, data[64]}` — see
`PROTOCOL.md` for the full struct and the exact `data[]` layout per
`msgType`. This is true regardless of which wire carries it: ESP-NOW gets
the struct as its packet payload directly; RS485 wraps the identical struct
in a simple frame (`PROTOCOL.md`'s "RS485 framing"). Practical consequence
for this doc: **every receive handler in this system dispatches on
`msgType` first**, not on payload length or which transport it arrived on —
there is no longer a "binary vs. text" disambiguation anywhere, and no
separate RS485 protocol to keep in sync with the ESP-NOW one. If a node
receives a message type it doesn't care about, it just ignores it (see
"Known gaps" for what that means for the broadcast score event).

Every node's **registration is also its heartbeat**: `MSG_REGISTER` is sent
once at boot and **re-sent every 10000 ms** (`REGISTER_RETRY_MS`) for the
node's entire lifetime, not just at startup. The gateway treats a
re-registration from an already-known node as a no-op liveness signal (logs
nothing, silently confirms it's still there) rather than re-adding the peer.
**The gateway currently has no explicit timeout/offline detection** — if a
node stops re-registering, the gateway has no mechanism to notice or flag it
as gone; this re-announce is purely so a *rebooted gateway* re-learns
existing nodes, not so the gateway can detect a *dead node*. Worth building
later.

---

## Fouling (break-beam) node — `break_beam_test.ino`
Covers **two lanes**, one break-beam sensor each. Registers as `NODE_FOULING`.

| | |
|---|---|
| **Emits** | `MSG_REGISTER{code=NODE_FOULING}` — boot + every 10s, **ESP-NOW only**.<br>`MSG_LANE_EVENT{code=LANE_FOUL\|LANE_CLEAR, laneNumber}` — on every debounced (30ms) sensor edge, per lane, **dual-sent on ESP-NOW and RS485**. |
| **Accepts** | Nothing, on either transport. This node has no `esp_now_register_recv_cb` and never reads from RS485 — it cannot receive anything, by design (pure sensor emitter, transmit-only on both wires). |
| **Heartbeat** | Only the 10s `MSG_REGISTER` re-announce (see "One message shape" above), ESP-NOW only. No separate heartbeat message. |

## Speed node — `speed_node.ino`
Covers **one lane pair**, two break-beams per lane (upstream/downstream), 4
sensors total. Registers as `NODE_SPEED`. Does no timing/pairing math itself
— see `HANDOFF.md`'s "nodes are dumb" principle.

| | |
|---|---|
| **Emits** | `MSG_REGISTER{code=NODE_SPEED}` — boot + every 10s, **ESP-NOW only**.<br>`MSG_BEAM_EVENT{code=BEAM_BROKEN\|BEAM_CLEAR, laneNumber, data[0]=beamRole}` — on every debounced (30ms) sensor edge, per beam, **dual-sent on ESP-NOW and RS485**. `beamRole`: 0=upstream, 1=downstream. |
| **Accepts** | Nothing, on either transport. Same as the fouling node — no recv callback, never reads RS485, pure sensor emitter. |
| **Heartbeat** | Only the 10s `MSG_REGISTER` re-announce, ESP-NOW only. |

## Pinsetter interface node — `pinsetter_node.ino`
Waveshare ESP32-S3-(POE-)ETH-8DI-8RO. Covers **one lane pair** (up to two
Brunswick A2 machines). Registers as `NODE_PINSETTER`. The only downstream
node with two-way ESP-NOW traffic and the only one with a real ack/retry
layer.

| | |
|---|---|
| **Emits** | `MSG_REGISTER{code=NODE_PINSETTER}` — boot + every 10s, **ESP-NOW only**.<br>`MSG_STATUS{code=StatusCode, ...}` — carries `relayState`, `diState`, and up to 4 packed `MachineRecord`s (lane, on/cycling/ball/pendingCycles flags, `cooldownMs` at full ms precision). Sent for: `STATUS_RELAY_ACK`, `STATUS_PULSE_ACK`, `STATUS_PULSE_COMPLETE`, `STATUS_ALL_ACK`, `STATUS_RELAY_FAULT`, `STATUS_REFUSED_PULSE_ONLY`, `STATUS_MACHINE_STATUS` (reply to `CMD_STATUS`), `STATUS_RESPOT_STUB`, `STATUS_CYCLE_COMPLETE`, `STATUS_DI_CHANGE` (on input-state change), `STATUS_HEARTBEAT` (periodic, see below). **Dual-sent on ESP-NOW and RS485, every time** — see PROTOCOL.md's "Dual-send". |
| **Accepts** | `MSG_COMMAND{code=CommandCode, laneNumber, data[0]=cycleCount}` from the gateway, on **either transport**: `CMD_CYCLE`/`CMD_RERACK` (run exactly `cycleCount` solenoid pulses — as of 2026-08-07 this node no longer decides 1-vs-2 itself from its own tracked ball state, the Pi does, using this node's own reported ball as ground truth; see `PROTOCOL.md`'s `MSG_COMMAND` fields), `CMD_POWER_ON`/`CMD_POWER_OFF` (latch machine power, `cycleCount` ignored), `CMD_RESPOT` (**stub**, logs + acks only, not implemented), `CMD_STATUS` (request a `STATUS_MACHINE_STATUS` report). Also `MSG_ACK{code=MSG_STATUS, seq}` from the gateway on either transport, acking this node's own outbound `MSG_STATUS` retries. A single dispatcher (`handleIncomingNodeMessage`) handles both, regardless of which wire the message came in on. |
| **Heartbeat** | Two independent timers: `MSG_REGISTER` re-announce every **10s** (ESP-NOW only, liveness/re-registration), and an explicit `STATUS_HEARTBEAT` every **5000 ms** (`HEARTBEAT_INTERVAL_MS`, dual-sent) — distinct purposes, not synchronized. DI (digital input) is polled every 100ms but only triggers a `STATUS_DI_CHANGE` *on an actual change*, not periodically. |
| **Ack/retry** | Only `MSG_STATUS` is tracked, across **both transports in one shared table** — an ack arriving via either ESP-NOW or RS485 satisfies the same pending entry. Backoff: initial send, retry at **+300ms**, **+900ms** (300+600), **+2100ms** (300+600+1200) — exponential (`ACK_TIMEOUT_MS=300 × 2^retries`), giving up after **3 retries** (4 transmissions total per transport) if never acked, logged as `Giving up on seq <n>`. Every retry is dual-sent again. `MSG_COMMAND` (gateway→pinsetter) is **not** ack/retry-tracked — a pre-existing gap, not new; dual-sending it reduces but doesn't eliminate the risk of total loss. See `PROTOCOL.md`'s "Reliability scope". |

**RS485 is a real wired fallback, not a legacy side-channel.** It carries the exact same `NodeMessage` struct as ESP-NOW, framed (`PROTOCOL.md`'s "RS485 framing") rather than packetized by radio. Shared bus with the gateway/fouling/speed nodes too, not a dedicated pinsetter-only wire; no addressing in the frame (relies on `msgType` self-disambiguating the sender — see `PROTOCOL.md`'s "RS485 framing" for the topology assumption this depends on). `MSG_REGISTER` doesn't go out over RS485 — a raw UART bus doesn't need discovery. The old JSON/text RS485 grammar (`ch:`/`pulse:`/`all:`/`ack:`) is gone entirely, replaced by this.

## Gateway node — `gateway_node.ino`
The hub. Not itself discovered by anything (every other node hardcodes its MAC). Owns dynamic peer registration; does no interval/timing math on sensor data and (as of 2026-08-07) no foul cooldown/rerack decision either -- both forwarded to the Pi as-is, which owns that logic now (see `state_machine/state_machine.py`'s `on_foul()`). Has RS485 hardware (pins UNVERIFIED placeholder, like every other node's) as the shared bus's other endpoint — every node's RS485 fallback traffic ultimately terminates here.

| | |
|---|---|
| **Emits (to pinsetter, dual-sent ESP-NOW + RS485)** | Bench-console-triggered: `CMD_CYCLE`, `CMD_RERACK`, `CMD_RESPOT`, `CMD_POWER_ON/OFF`, `CMD_STATUS`. `UART_PINSETTER_COMMAND` from the Pi passes through any `CommandCode` the same way (generalized 2026-07-18 from a cycle-only message, so the Pi's REST API can also issue re-rack, not just cycle) — this is now also how a `LANE_FOUL`'s rerack reaches the pinsetter, via the Pi rather than a local gateway decision (see below). Every `CMD_CYCLE`/`CMD_RERACK` now also carries `data[0]=cycleCount` (2026-08-07) — the bench console picks a literal default (1 for cycle, 2 for rerack, no ball state to consult); `UART_PINSETTER_COMMAND` from the Pi passes through whatever count the Pi computed. ESP-NOW send is gated on the pinsetter being registered; RS485 send is gated only on the hardware being present (`RS485_ENABLED`) — so RS485 keeps working even if ESP-NOW registration never completed. |
| **Emits (broadcast, both transports)** | `MSG_SCORE_EVENT{laneNumber, code=ballNumber, data[0..1]=pinfallMask}` — only when the Pi sends `UART_SCORE_EVENT`. Sent to ESP-NOW's `FF:FF:FF:FF:FF:FF` (the one message type that isn't per-peer unicast on ESP-NOW) and enqueued on RS485, which is inherently broadcast on a shared bus — no separate broadcast address needed there. No node currently consumes it; see "Known gaps" below. |
| **Emits (ack, dual-sent ESP-NOW + RS485)** | `MSG_ACK{code=MSG_STATUS, seq}` back to the pinsetter for each `MSG_STATUS` received, on whichever transport(s) are available — regardless of which transport the status arrived on. |
| **Accepts (from mesh)** | `MSG_REGISTER` from any node, ESP-NOW only (dispatches by `code`/`NodeType` to the fouling/speed/pinsetter registration tables — this is the one case still handled separately, since it needs a MAC). `MSG_LANE_EVENT` from fouling nodes, `MSG_BEAM_EVENT` from speed nodes, and `MSG_STATUS` from the pinsetter — **all on either ESP-NOW or RS485**, all dispatched through the same shared `handleIncomingNodeMessage()` function, so the response is identical regardless of which wire the message came in on. |
| **Accepts (bench console, serial @9600, not ESP-NOW)** | `cycle <lane>`, `rerack <lane>`, `respot <lane>`, `power <lane> on\|off`, `pstatus`, `status`. |
| **Foul handling** | None on the gateway anymore (removed 2026-08-07). `MSG_LANE_EVENT{LANE_FOUL}` is forwarded to the Pi exactly like `LANE_CLEAR`, with no cooldown and no `CMD_RERACK` sent from here. The per-lane debounce (a trip over the foul line produces several edges in quick succession) and the rerack decision both moved to `state_machine/state_machine.py`'s `on_foul()`/`FOUL_COOLDOWN_S` (0.75s), which has real game state to decide with. Bench-console `cycle`/`rerack` are unaffected. |
| **Heartbeat** | None outbound — the gateway is passive/central, it only reacts. It has no timeout/offline-detection for nodes that stop re-registering (see "One message shape" note above). |

There is no longer a gateway→scoring command path (`CMD_FOUL`/`ScoringCommand` were removed, not just superseded — see `PROTOCOL.md`). `NODE_SCORING` stays defined in the `NodeType` enum but is effectively vestigial.

## Pi (scoring compute) — not an ESP-NOW participant
Wired to the gateway over **UART**, a separate framed byte protocol (start
byte + length + payload + XOR checksum) — not ESP-NOW at all, so its
commands/events are intentionally out of scope for this doc. The gateway
translates between the two protocols rather than passing raw ESP-NOW bytes
through, so the Pi-facing UART shape (`UART_LANE_EVENT`, `UART_BEAM_EVENT`,
`UART_PINSETTER_COMMAND`, `UART_SCORE_EVENT`) is unaffected by the ESP-NOW
protocol unification — see `HANDOFF.md`'s "Gateway <-> Pi UART bridge"
section and `PROTOCOL.md`'s "Gateway ↔ Pi UART boundary" note.

## `mac_finder.ino` — utility only
Not a persistent mesh participant. Flash it, read the board's MAC off
serial, done. No commands, no events, no heartbeat.

---

## Known gaps
- **No node liveness/timeout detection.** The 10s `MSG_REGISTER` re-announce
  is only used to let a *rebooted gateway* re-learn nodes; the gateway never
  notices if a node goes silent. Worth adding if the UI needs to show
  online/offline status per node.
- **`MSG_SCORE_EVENT`s are received-but-ignored by every node today, and
  this is now an explicit dispatch decision rather than an accidental side
  effect.** Before the protocol unification, a broadcast score event
  happened to be silently dropped by the pinsetter because its length
  didn't match `sizeof(PinsetterCommand)`. Now that every message is the
  same fixed `NodeMessage` size, that accidental filter is gone — the
  pinsetter's (and any future node's) receive handler must explicitly check
  `msgType` and ignore anything that isn't relevant to it. The fouling and
  speed nodes still can't receive anything regardless (no recv callback,
  and they never poll RS485 either). There is no real consumer of
  `MSG_SCORE_EVENT` yet — that's a future display/UI node's job.
- **`MSG_COMMAND` (gateway→pinsetter) is still not ack/retry-tracked**, even
  after adding the RS485 fallback. A lost `CMD_RERACK` means the pinsetter
  silently never cycles — dual-sending on both transports meaningfully
  reduces the odds of total loss, but doesn't eliminate it the way real
  ack/retry would. Flagged in `PROTOCOL.md` as a candidate future
  improvement (`MSG_ACK` already exists generically, so extending it to
  commands later doesn't need another redesign).
- **RS485 has no sender/receiver addressing.** It works today only because
  each gateway's mesh has at most one node of each type, so `msgType` alone
  tells the receiver who must have sent a given frame. If a future topology
  puts two nodes of the *same* type on one RS485 bus, that assumption breaks
  and real addressing has to be added; not designed for yet. See
  `PROTOCOL.md`'s "RS485 framing".
- **Dynamic gateway discovery is not implemented.** See `HANDOFF.md`'s
  design-principles section — hardcoded `GATEWAY_MAC` per node is the
  current approach, explicitly not the intended end state.
