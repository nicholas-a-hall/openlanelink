# openlanelink node message protocol — canonical wire format

This is the single source of truth for the exact bytes every openlanelink
node exchanges, over **either** transport it might use (ESP-NOW, or RS485
where wired). `HANDOFF.md` covers narrative history and design principles;
`ESPNOW.md` covers per-node behavior (who emits what, who accepts what,
heartbeat timing) in prose/table form. This doc is the struct-and-enum
reference both of those point to — if the wire format changes, change it
here first, then propagate.

**The code that implements this doc lives in exactly one place:** the
`lanelink` Arduino library, `firmware/lib/lanelink/src/` — every sketch
`#include <lanelink_protocol.h>` rather than carrying its own copy, because
nodes whose enum values or struct layout drift apart don't fail loudly, they
silently misparse every frame from every peer. Install it once with
`firmware/tools/install_lanelink_library.ps1` (Windows) or
`install_lanelink_library.sh` (macOS/Linux); both link the repo folder into
your Arduino sketchbook so edits take effect on the next compile.

## One message struct, uniform across transports
**The messages between nodes are uniform regardless of transport.** A node
does not have a different vocabulary for ESP-NOW vs. RS485 — it has one
message struct, `NodeMessage`, and each transport just carries the same
bytes differently:
- **ESP-NOW** delivers `NodeMessage` as the entire packet payload directly —
  ESP-NOW is already packetized by the radio MAC layer, so no extra framing
  is needed.
- **RS485** is a raw byte stream (like the gateway↔Pi UART link), so it wraps
  `NodeMessage` in an explicit frame — see "RS485 framing" below.

This replaces an earlier design (same day) where the pinsetter's RS485 side
spoke a completely different, JSON-based text protocol from its ESP-NOW
side, and where RS485 was scoped to the gateway↔pinsetter link only. Both of
those are gone. **Why:** RS485 exists as a wired fallback to insulate the
*whole mesh* against ESP-NOW radio failures, not just one link — for that to
actually work, every transport needs to carry the same messages with the
same meaning, not independently-maintained protocols (or independently-wired
subsets of the mesh) that could drift apart.

## Why one struct for everything (ESP-NOW-specific reasoning)
ESP-NOW's real constraints, and how they shape this:
- **250-byte hard payload cap, no fragmentation.** One message = one packet,
  always. We're nowhere near the ceiling (see sizing below), so there's no
  pressure to byte-golf — a single generously-sized fixed struct is fine.
  Different node needing different amounts of data is expected; wasted bytes
  on a small message cost nothing at this scale.
- **No application-level ack.** `esp_now_send`'s callback only confirms the
  radio handed the frame to the peer, not that its application processed it.
  Anything that needs guaranteed delivery needs its own seq+ack+retry on top
  — see "Reliability scope" below for which messages actually get this.
- **No routing / no query-response correlation.** Any request→reply pattern
  (e.g. `CMD_STATUS` → a status reply) has to self-correlate via `seq`.

Previously each node defined its own struct per message shape (`LaneEvent`,
`BeamEvent`, `RegisterEvent`, `PinsetterCommand`, `ScoringCommand`), and the
pinsetter separately emitted JSON text for its status/heartbeat traffic.
That's gone — every node now sends exactly one struct shape, always exactly
the same size, for every purpose, on every transport it has. Receive code no
longer needs to disambiguate binary vs. text or infer type from length —
every payload is always `sizeof(NodeMessage)` bytes.

## The struct

```cpp
enum MsgType : uint8_t {
  MSG_REGISTER    = 0,  // any node -> gateway, ESP-NOW only, boot + every 10s
  MSG_LANE_EVENT  = 1,  // fouling -> gateway, dual-sent (ESP-NOW + RS485)
  MSG_BEAM_EVENT  = 2,  // speed OR ball detect -> gateway, dual-sent (ESP-NOW + RS485)
  MSG_COMMAND     = 3,  // gateway -> pinsetter, dual-sent (ESP-NOW + RS485)
  MSG_STATUS      = 4,  // pinsetter -> gateway, dual-sent (ESP-NOW + RS485)
  MSG_SCORE_EVENT = 5,  // gateway -> broadcast, dual-sent (ESP-NOW broadcast address + RS485,
                          // which is inherently broadcast too -- every node on the shared bus sees it)
  MSG_ACK         = 6,  // gateway -> pinsetter, dual-sent, acks a received MSG_STATUS
};

enum NodeType : uint8_t {
  NODE_FOULING = 0, NODE_PINSETTER = 1, NODE_SCORING = 2, NODE_SPEED = 3,
  NODE_BALL_DETECT = 4,
};

// A gateway's mesh is exactly ONE LANE PAIR, so nothing on the wire needs a
// lane number -- only which of the pair's two sides an event concerns.
enum class LaneSide : uint8_t {
  NONE = 0,   // node-level / not side-specific (also: unused MachineRecord slot)
  A    = 1,
  B    = 2,
};

struct NodeMessage {
  uint8_t msgType;       // MsgType
  uint8_t seq;           // ack/retry correlation (see "Reliability scope")
  uint8_t code;          // msgType-scoped sub-code, see table below
  LaneSide laneSide;     // one byte; LaneSide::NONE = node-level
  uint32_t timestampMs;  // sender's own millis()
  uint8_t data[64];      // msgType-specific, see table below
};                        // sizeof = 1+1+1+1 + 4 + 64 = 72 bytes, fixed, no padding
                           // (72 is already a multiple of 4 -- deliberately sized
                           // that way so the compiler adds zero trailing padding;
                           // see the struct-padding gotcha further down)
```

`code` is scoped to `msgType`, not global — unlike the old single `EventType`
enum that had to avoid collisions across unrelated node types, each message
type below gets its own small, independent code enum.

**Every node has RS485 hardware and dual-sends its operational traffic** —
fouling, speed, ball detect, pinsetter, and the gateway. RS485 exists to insulate the
whole mesh against ESP-NOW radio failures, not just the gateway↔pinsetter
link specifically, so it doesn't stop at the one node pair with the most
obviously expensive failure mode. See "RS485 framing" below for how this
works as a shared bus rather than a set of point-to-point links (the ESP32
only has one spare `HardwareSerial` on the gateway after the Pi link, so a
star of separate point-to-point RS485 links isn't even physically possible
here).

## Lane sides, not lane numbers
**No node knows its lane number, and none can be configured with one.** A
gateway's mesh is exactly one lane pair — one gateway, one ESP-NOW
registration domain, one RS485 bus, two sides — so a lane number carries no
information the mesh can act on. `laneSide` names which of the pair's two
sides an event concerns and nothing more.

This is what makes firmware **generically provisionable**: every fouling,
speed, ball detection, and pinsetter sketch is byte-identical on every lane
pair in the house, with `GATEWAY_MAC` the only per-pair constant left. There
is nothing to edit and reflash when a board moves to a different pair, and
no lane number that can silently disagree with what the Pi believes.

Resolving side → real lane number happens exactly once, in software, at the
mesh boundary: `uart_bridge/lane_map.py` (`LANE_SIDE_A`/`LANE_SIDE_B`
environment variables). Everything upstream of that — `state_machine`,
`vision`, the UI — speaks real lane numbers and was unaffected by this
change; the bridge's `/events` payloads still carry `laneNumber`.

`LaneSide::NONE` deliberately keeps the value `0` had as the old
`laneNumber` field's "node-level / not lane-specific" sentinel, so every
`== 0` check on both sides of the wire kept its exact meaning through the
rename. **The byte layout did not change** — same offsets, same size, same
padding — only what the fourth byte means.

**Consequence for the pinsetter's 8RO board:** channels 5–8 are spare, not
"a second lane pair." A second pair needs its own gateway and its own
pinsetter node, because a pair is defined by its gateway. `MAX_MACHINES_PER_MSG`
stays 4 for wire compatibility; only two slots are ever populated now.

## Per-`msgType` field mapping

### `MSG_REGISTER` — any node → gateway, boot + every 10s, **ESP-NOW only**
| field | value |
|---|---|
| `code` | `NodeType` of the sender |
| `laneSide` | `LaneSide::NONE` — registration is node-level |
| `data[]` | unused |

RS485 doesn't need a registration/discovery handshake — there's no peer
table or dynamic MAC learning on a raw UART bus the way ESP-NOW needs.
`MSG_REGISTER` is the one message type every node keeps ESP-NOW-exclusive,
even now that all of them have RS485.

### `MSG_LANE_EVENT` — fouling node → gateway, **dual-sent (ESP-NOW + RS485)**
```cpp
enum LaneEventCode : uint8_t { LANE_CLEAR = 0, LANE_FOUL = 1 };
```
| field | value |
|---|---|
| `code` | `LaneEventCode` |
| `laneSide` | which side of the pair tripped |
| `data[]` | unused |

The fouling node acts on nothing it receives, on either transport (see
`HANDOFF.md`'s "nodes are dumb" principle), so there's nothing to gate sends
on the way the pinsetter's two-way traffic is — it enqueues the RS485 frame
unconditionally alongside every ESP-NOW send. It does still **read** the bus
every loop (`rs485.observeBus()`), discarding what it decodes, because that
is the only way its send-side collision avoidance can see anyone else's
traffic — see "RS485 framing" below.

### `MSG_BEAM_EVENT` — speed node **or ball detection node** → gateway, **dual-sent (ESP-NOW + RS485)**
```cpp
enum BeamEventCode : uint8_t { BEAM_CLEAR = 0, BEAM_BROKEN = 1 };
enum BeamRole      : uint8_t { ROLE_UPSTREAM = 0, ROLE_DOWNSTREAM = 1, ROLE_BALL_DETECT = 2 };
```
| field | value |
|---|---|
| `code` | `BeamEventCode` |
| `laneSide` | which side of the pair the beam watches |
| `data[0]` | `BeamRole` — 0/1 from a speed node, 2 from a ball detection node |

No timing/pairing math here or anywhere in firmware — see `HANDOFF.md`'s
"nodes are dumb" principle. Pairing upstream/downstream into an interval
happens on the Pi. Same transmit-only pattern as the fouling node above.

**`BeamRole` is what distinguishes the two emitters, and it is the only
thing that does** — the message type, struct, and gateway handling are
otherwise identical, and the gateway forwards any role to the Pi verbatim
without caring which node sent it (see "RS485 framing" below for why that
matters: two beam-event emitters on one bus is the first real stress on the
unaddressed-frame assumption, and it holds precisely because the gateway
never needs to know the sender).

**Why `ROLE_BALL_DETECT` is a third role rather than the ball detection node
just reporting `ROLE_DOWNSTREAM`** (which is what an earlier design note in
`vision/bridge_client.py` assumed, since both physically mean "the ball
reached the pins"): roles 0 and 1 are a matched *pair*, and the Pi's
`state_machine/main.py` pops its pending upstream timestamp on **any**
`ROLE_DOWNSTREAM` edge to compute an interval. A ball detection node's beam
has no pairing partner and sits at a different point on the lane, so wearing
role 1 would let it consume a speed node's pending upstream reading and
produce a ball speed measured over the wrong beam spacing entirely — a
plausible-looking wrong number, on any lane covered by both nodes. Consumers
that genuinely don't care about the distinction just accept both roles
(`vision/bridge_client.py`'s `TRIGGER_ROLES`); the one consumer that does
care gets to tell them apart.

### `MSG_COMMAND` — gateway → pinsetter, **dual-sent (ESP-NOW + RS485)**
```cpp
enum CommandCode : uint8_t {
  CMD_CYCLE = 0, CMD_POWER_ON = 1, CMD_POWER_OFF = 2,
  CMD_RERACK = 3, CMD_RESPOT = 4, CMD_STATUS = 5,
};
```
| field | value |
|---|---|
| `code` | `CommandCode` |
| `laneSide` | target side (ignored for `CMD_STATUS`, which is node-level) |
| `data[0]` | `cycleCount` — `CMD_CYCLE`/`CMD_RERACK` only: exact solenoid pulse count to run, decided by the Pi (`state_machine.py`'s `_rerack_cycle_count()`) from the pinsetter's own last-reported ball number (see `MSG_STATUS` below), not derived locally on the pinsetter (2026-08-07 — see `firmware/HANDOFF.md`). Ignored by other `CommandCode`s. |
| `data[1..63]` | unused |

**`CMD_FOUL`/`ScoringCommand` removed, not carried forward.** The old
protocol had a gateway→scoring command that was always dead code
(`SCORING_ENABLED=false`, no scoring ESP32 node was ever built) — scoring now
lives on the Pi, reached over UART, not ESP-NOW. `NODE_SCORING` stays defined
in `NodeType` (harmless, in case something registers as one someday) but
there is no longer a command path to it.

### `MSG_STATUS` — pinsetter → gateway, **dual-sent (ESP-NOW + RS485)**
```cpp
enum StatusCode : uint8_t {
  STATUS_RELAY_ACK = 0, STATUS_PULSE_ACK = 1, STATUS_PULSE_COMPLETE = 2,
  STATUS_ALL_ACK = 3, STATUS_RELAY_FAULT = 4, STATUS_REFUSED_PULSE_ONLY = 5,
  STATUS_MACHINE_STATUS = 6, STATUS_RESPOT_STUB = 7, STATUS_DI_CHANGE = 8,
  STATUS_HEARTBEAT = 9, STATUS_CYCLE_COMPLETE = 10,
};

struct MachineRecord {      // 4 bytes, naturally aligned, no padding
  uint8_t laneSide;         // LaneSide; NONE (0) = unused slot
  uint8_t flags;             // bit0=on, bit1=cycling, bit2=ball(0=1st/1=2nd), bits3-4=pendingCycles(0-3)
  uint16_t cooldownMs;       // full ms precision, 0-65535 (A2 cycle time ~8000ms fits easily)
};
#define MAX_MACHINES_PER_MSG 4   // matches the 8RO board's hardware ceiling (2 relays/machine x 4)
```
| field | value |
|---|---|
| `code` | `StatusCode` |
| `laneSide` | the specific machine's side for single-machine events (`STATUS_RELAY_ACK`, `STATUS_PULSE_ACK`, `STATUS_PULSE_COMPLETE`, `STATUS_REFUSED_PULSE_ONLY`, `STATUS_CYCLE_COMPLETE`, `STATUS_RESPOT_STUB`); **`LaneSide::NONE`** for node-level events that cover every machine (`STATUS_ALL_ACK`, `STATUS_RELAY_FAULT`, `STATUS_MACHINE_STATUS`, `STATUS_DI_CHANGE`, `STATUS_HEARTBEAT`) |
| `data[0]` | `relayState` (raw 8-bit relay bitmask) |
| `data[1]` | `diState` (raw 8-bit DI bitmask) |
| `data[2..17]` | up to `MAX_MACHINES_PER_MSG` (4) × `MachineRecord`, 4 bytes each — **always all machines, regardless of `code`**, same as the old JSON always included the full `machines[]` array no matter what `type` was |
| `data[18..63]` | reserved, zeroed on send — 46 bytes free for future fields (firmware version, uptime, error codes, RSSI, ...) without another protocol-breaking redesign |

`MachineRecord.flags`' ball bit is extracted by the gateway (matching `laneSide` against the record array — see `ballForSide()` in `gateway_node.ino`) and forwarded to the Pi on every `UART_PINSETTER_STATUS` frame as of 2026-08-07 (see "Gateway ↔ Pi UART boundary" below) — previously only `statusCode`/`laneSide`/`timestampMs` crossed that boundary.

### `MSG_SCORE_EVENT` — gateway → broadcast, **on both transports**
Originates from the Pi via `UART_SCORE_EVENT`; the gateway rebroadcasts it —
the one message type that isn't per-peer unicast on ESP-NOW (sent to
`FF:FF:FF:FF:FF:FF` instead of a specific registered peer). On RS485 there's
no separate "broadcast address" concept needed — the bus is shared, so
anything the gateway sends is already physically seen by every node on it.
No node currently acts on `MSG_SCORE_EVENT` (see `ESPNOW.md`'s "Known gaps"
— this is for a future display/UI node), but every receiver's default
dispatch case already logs-and-ignores unrecognized-but-valid `msgType`s
harmlessly, so there's no reason to withhold it from RS485.

| field | value |
|---|---|
| `code` | ball number (1 or 2) |
| `laneSide` | which side the ball was thrown on |
| `data[0..1]` | `pinfallMask`, `uint16_t` LE, bit per pin 1–10, **bit=1 means that pin fell on this ball** (bit0=pin1 ... bit9=pin10) — the count/delta of *newly* fallen pins, not a raw standing-pin snapshot. Was ambiguous until `state_machine/game_state.py` needed a firm answer to score against; that module works in per-ball pinfall *counts* derived from this, not the mask directly — see its docstring. The camera pipeline (`pinfall.py`, not yet implemented) is responsible for turning a raw standing-pins observation into this delta before it ever reaches `MSG_SCORE_EVENT`. |

### `MSG_ACK` — gateway → pinsetter, **dual-sent (ESP-NOW + RS485)**
| field | value |
|---|---|
| `code` | the `msgType` being acked (always `MSG_STATUS` today — see "Reliability scope") |
| `seq` | the `seq` value being acknowledged |
| `laneSide`, `data[]` | unused |

## RS485 framing
RS485 is a raw byte stream, so — same as the gateway↔Pi UART link — messages
are framed explicitly:

```
[0xAA START][LEN uint8][PAYLOAD (LEN bytes -- the raw NodeMessage struct)][CHECKSUM uint8 = XOR of LEN and all PAYLOAD bytes]
```

`LEN` is always `sizeof(NodeMessage)` = 72 here (there's no extra
message-type wrapper byte the way the Pi UART bridge has — `NodeMessage`'s
own `msgType` field already is the first payload byte, since the *whole*
struct is what's being framed, not a translated/compacted subset of it).
Both sides scan for `0xAA`, read `LEN`, read `LEN` payload bytes, verify the
checksum. On mismatch the whole consumed frame is discarded and scanning
resumes from the next byte — same resync approach and tradeoff as the Pi
UART link (adequate for a direct wired link; see `HANDOFF.md`).

**RS485 is one shared multi-drop bus, not a set of point-to-point links** —
the gateway, fouling node, speed node, ball detection node, and pinsetter all
tap into the same physical wire pair. (The ESP32 only has one `HardwareSerial` left on the
gateway after the Pi link uses another, so separate point-to-point RS485
runs to each node aren't even physically possible with this hardware —
multi-drop is the only option, which conveniently is also RS485's whole
reason to exist.)

**There is no sender/receiver addressing in the frame.** This works only
because of a structural assumption that holds for the current topology: each
gateway's mesh has *at most one node of each type* (one fouling node, one
speed node, one ball detection node, one pinsetter), so `msgType` (and `code`
for `MSG_REGISTER`) already tells the receiver unambiguously who must have
sent it — `MSG_LANE_EVENT` can only ever come from the fouling node,
`MSG_STATUS` only from the pinsetter. **If that assumption ever breaks — e.g.
two fouling nodes sharing one RS485 bus — real addressing has to be added to
the frame.** Not designed for yet.

`MSG_BEAM_EVENT` is the one message type with **two** possible senders (the
speed node and the ball detection node, added 2026-08-12) and it does not
break the assumption, because nothing downstream needs to know which board
emitted it: the gateway forwards every beam event to the Pi unchanged
regardless of role, and the Pi keys off `BeamRole` — a property of the beam's
purpose, not of the sender's identity. Roles are disjoint across the two
node types (0/1 vs. 2), so this stays a message-level distinction rather than
a sender-level one. That's the shape any future second-emitter-per-`msgType`
case should take too; anything needing to identify the *board* is what would
actually force addressing into the frame.

The pinsetter's existing send-side collision-avoidance queue (idle detection
+ jitter before transmitting, since RS485 is half-duplex) is used by every
node now, not just the pinsetter — with more transmitters sharing one bus,
this matters more than it used to, not less.

**Idle detection only works if a node actually reads the bus.** The activity
timestamp it compares against is updated when bytes are *read*, so a node
that never reads sees only its own transmissions, concludes the bus is quiet
whenever it personally hasn't spoken recently, and transmits straight over
another node's frame — corrupting both, since RS485 is half-duplex with no
arbitration. **Every node therefore calls into `Rs485Link` every loop**, even
the three that act on nothing: the pure emitters (fouling, speed, ball
detect) call `observeBus()`, which reads and discards, while the gateway and
pinsetter call `poll(handler)`. This makes each emitter board's **RS485 RX
pin required wiring**, not optional — a floating RX puts the node right back
to transmitting blind.

## Dual-send: what actually goes out on both channels
**Every `MSG_LANE_EVENT`, `MSG_BEAM_EVENT`, `MSG_COMMAND`, `MSG_STATUS`, and
`MSG_ACK` is sent on ESP-NOW and RS485 simultaneously, unconditionally** —
this isn't failure-detection-then-failover, it's always-on redundancy: both
copies go out every time, and whichever arrives (possibly both) does the
job. This is simpler and more robust than trying to detect "ESP-NOW seems
down, switch to RS485," and it's what the original tested pinsetter firmware
already did (dual-sending its JSON status on both channels) — this redesign
keeps that property and now extends it to every node, with one message
format everywhere instead of two divergent ones.

Sending is gated independently per channel. On the pinsetter/gateway: ESP-NOW
sends are gated on the peer having registered (discovered dynamically);
RS485 sends are gated on `RS485_ENABLED` only, since the wire's presence is a
hardware fact, not something discovered at runtime — RS485 keeps working
even if ESP-NOW registration never completed, which is the whole point of
"insulate against ESP-NOW failures." The fouling and speed nodes have no
receive path at all (see "nodes are dumb"), so for them there's nothing to
gate sends on beyond `RS485_ENABLED` — they just always try both.

`MSG_REGISTER` is the only message type that stays ESP-NOW-only — a raw UART
bus has no discovery/registration concept. Every other message type,
including the broadcast `MSG_SCORE_EVENT`, goes out on both transports.

### Receivers must filter the second copy
Dual-sending means that **when both transports are up, a receiver sees every
message twice**. That is the intended cost of the redundancy, but it is only
harmless if receivers deduplicate: without it the gateway forwarded every
foul, every ball-detect trigger, and every `STATUS_CYCLE_COMPLETE` to the Pi
*twice* — double-recorded balls and double pinsetter cycles.

Both copies are **byte-identical**: senders stamp `seq` and `timestampMs`
once, before either send. So an exact key rather than a hash works, with no
false positives — a genuinely new message differs in at least `timestampMs`
or `seq`. `DualSendFilter` (`lanelink_protocol.h`) keys an 8-slot ring on
`{msgType, seq, code, laneSide, data[0], timestampMs}` over a 1500 ms window.

- `data[0]` is in the key because `MSG_BEAM_EVENT` has **two** senders (speed
  and ball detect nodes) with independent `seq` counters; their beam role is
  what separates a same-millisecond, same-`seq` coincidence.
- The window covers the worst-case lag between copies, which is the RS485
  queue draining ahead of the frame: 8 queued frames × 75 bytes at 9600 baud
  ≈ 900 ms, plus idle/jitter backoff.
- `MSG_REGISTER` deliberately bypasses the filter: it is never dual-sent, and
  it repeats every 10 s by design.

**Both receivers apply this**, in their own `handleIncomingNodeMessage()` —
shared by both transports, which is the whole point, since the duplicate
arrives on the *other* wire from the original. On the gateway it stops every
foul, beam, and status reaching the Pi twice; on the pinsetter it stops one
`CMD_RERACK` firing two machine cycles.

The pinsetter previously used a single-slot "was that the last seq I saw"
check. That catches the common back-to-back pair but not interleaved
delivery: espnow(A), espnow(B), rs485(A) leaves A looking new again and
re-runs it. Keying the ring on the whole message makes arrival order
irrelevant.

A receiver on the shared RS485 bus also sees traffic that simply isn't its
business — the pinsetter reads every fouling/speed/ball-detect event, plus
the broadcast `MSG_SCORE_EVENT`. Those are ignored **silently and
explicitly**, not via the "unrecognized msgType" branch, which stays reserved
for something genuinely unknown. Logging them instead produced a line per
beam break, per foul, and per ball.

## Reliability scope — what gets acked, what doesn't
Only `MSG_STATUS` is tracked with seq/ack/retry, same as before this
redesign — dual-sending doesn't change *which* messages are tracked, only
*how many wires* a tracked message goes out on. A single `pending[]` table on
the pinsetter is keyed by `seq`; an ack arriving on **either** transport
satisfies the same pending entry (a real payoff of unifying the format — an
ack is an ack, regardless of which wire it came in on). If the ESP-NOW copy
of a `MSG_STATUS` times out and gets retried, the retry also goes out on both
channels again.

Everything else is fire-and-forget, unchanged from before:
- `MSG_REGISTER` re-announces every 10s anyway — losing one occasionally is a
  non-issue.
- `MSG_LANE_EVENT`/`MSG_BEAM_EVENT` are live, perishable sensor edges; a lost
  one just means a missed reading, not a stuck state. Dual-sending them
  reduces the odds of a total loss, but there's still no ack/retry on either
  transport for these — that's a deliberate choice, not an oversight, since
  retrying a stale sensor edge after the fact isn't useful.
- `MSG_COMMAND` (gateway→pinsetter) is **not** ack/retry-tracked — that's a
  real gap (a lost `CMD_RERACK` means the pinsetter silently never cycles),
  pre-existing and not fixed here. Dual-sending it on both transports
  meaningfully reduces the odds of total loss without needing full
  ack/retry machinery on the command path. Extending `MSG_ACK` to cover
  commands too remains a candidate future improvement, not done now.

## Struct-padding gotcha (bit us once already)
Any struct with `uint8_t` fields followed by a `uint32_t` gets compiler
padding to 4-byte-align the `uint32_t` — this is why `NodeMessage`'s
`timestampMs` sits at byte offset 4, not immediately after `laneSide`.
`MachineRecord`'s `cooldownMs` (`uint16_t`) only needs 2-byte alignment,
which it already has at offset 2, so it has zero padding.

## Peer registry — which nodes belong to a gateway
Every node hardcodes its `GATEWAY_MAC`, so a **correctly flashed** node can
only ever reach its own gateway over ESP-NOW unicast. A **misflashed** one
reaches whichever gateway that MAC names, and the gateway used to accept it
permanently and silently. Since every leaf sketch is now byte-identical across
lane pairs (they report `laneSide`, not a lane number), such a node's events
are indistinguishable from the real node's — generic provisioning traded a
loud misassignment for a quiet one.

**The Pi owns the allowlist; the gateway caches and enforces it.** The root of
trust is the UART cable: the Pi is wired to exactly one gateway, which is the
only unforgeable "this one is mine" signal in the system — every MAC-based
claim is observable by a sniffer and forgeable.

| | |
|---|---|
| `UART_NODE_SEEN` (0x04) | gateway → Pi: `{mac[6], nodeType, status, timestampMs}` (12 bytes). Sent on first sighting, on any status change, and otherwise at most every 30 s per MAC — nodes re-announce every 10 s forever and the Pi only needs liveness. `status` is `UNGOVERNED`/`ACCEPTED`/`REJECTED_NOT_LISTED`/`REJECTED_WRONG_TYPE`. **Refusals are reported too** — a node silently turned away is otherwise impossible to diagnose from the lane. |
| `UART_PEER_TABLE_ACK` (0x05) | gateway → Pi: `{generation uint16, count}`. Which allowlist the gateway *actually* applied; divergence means a push didn't land. |
| `UART_PEER_TABLE` (0x12) | Pi → gateway: `{generation uint16, count, count × {mac[6], nodeType}}`. **The whole table in one frame**, which is what makes applying it atomic — there is no staging/commit protocol and no way to half-apply a table and lock out the lane's real nodes. 8 entries is 59 bytes; the gateway's UART payload buffer was raised from 32 to 64 bytes for it. |

**Fail open until provisioned, fail closed after.** A gateway with no allowlist
in NVS accepts every registration and reports it as `UNGOVERNED` — identical to
its behavior before the registry existed, so a fresh install still comes up on
its own and the Pi can watch who appears before locking anything down. Once a
table has been pushed, unlisted MACs are refused. Failing closed on an empty
NVS instead would brick a lane on any provisioning-order mistake.

Enforcement happens on **every inbound ESP-NOW frame**, not just at
registration: ESP-NOW's receive callback fires for any unicast addressed to the
board regardless of its peer table, so a node accepted once and later denied
would otherwise keep delivering events forever.

**Scope: ESP-NOW only.** RS485 frames carry no sender address (see "RS485
framing"), so there is nothing to check them against. That transport is trusted
because **each lane pair has its own physically isolated RS485 segment** — a
load-bearing install requirement, not a convention. A bus shared across pairs
would reintroduce exactly the cross-pair contamination this section exists to
prevent, and no software here would catch it.

Still unbuilt, from the design in `docs/index.md`: nodes have no NVS identity
(so `GATEWAY_MAC` remains compile-time), there is no operator provisioning
handshake pushing identity *down* to a node, and there is no gateway
replacement/failover flow.

## Gateway ↔ Pi UART boundary
The gateway translates between the mesh (ESP-NOW/RS485) and the Pi's UART
link — it is not a raw pass-through of mesh bytes. The Pi-facing UART
protocol (`UART_LANE_EVENT`, `UART_BEAM_EVENT`, `UART_PINSETTER_STATUS`,
`UART_PINSETTER_COMMAND`, `UART_SCORE_EVENT`, documented in `HANDOFF.md`'s
"Gateway <-> Pi UART bridge" section) was **unaffected by this doc's ESP-NOW
protocol unification**: the gateway receives a `NodeMessage` off whichever
transport it arrived on and extracts the fields it needs to build the same
compact UART payloads it already sent, regardless of which wire it came in
on. It has since gained one new payload, `UART_PINSETTER_STATUS` (added
2026-08-06), which forwards every pinsetter `MSG_STATUS` down to the Pi --
added so the Pi's game state machine has a real `STATUS_CYCLE_COMPLETE`
signal instead of guessing off a fixed timeout after sending
`CMD_CYCLE`/`CMD_RERACK`. As of 2026-08-07 this payload also carries
`ballNumber` (`statusCode`, `laneSide`, `ballNumber`, `timestampMs`) --
the pinsetter's own reported ball, extracted from `MachineRecord` (see
`MSG_STATUS` above) -- so the Pi can decide rerack cycle counts itself
instead of the pinsetter deriving them locally (see `state_machine.py`'s
`_rerack_cycle_count()`/`reconcile_ball_number()`, and `UART_PINSETTER_COMMAND`
below, which gained the matching `cycleCount` field the same day). See
`state_machine/protocol.py`'s `StatusEvent`/`encode_pinsetter_command` for
the Pi-side (de)coding.
