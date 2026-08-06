# openlanelink node message protocol — canonical wire format

This is the single source of truth for the exact bytes every openlanelink
node exchanges, over **either** transport it might use (ESP-NOW, or RS485
where wired). `HANDOFF.md` covers narrative history and design principles;
`ESPNOW.md` covers per-node behavior (who emits what, who accepts what,
heartbeat timing) in prose/table form. This doc is the struct-and-enum
reference both of those point to — if the wire format changes, change it
here first, then propagate.

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
  MSG_BEAM_EVENT  = 2,  // speed -> gateway, dual-sent (ESP-NOW + RS485)
  MSG_COMMAND     = 3,  // gateway -> pinsetter, dual-sent (ESP-NOW + RS485)
  MSG_STATUS      = 4,  // pinsetter -> gateway, dual-sent (ESP-NOW + RS485)
  MSG_SCORE_EVENT = 5,  // gateway -> broadcast, dual-sent (ESP-NOW broadcast address + RS485,
                          // which is inherently broadcast too -- every node on the shared bus sees it)
  MSG_ACK         = 6,  // gateway -> pinsetter, dual-sent, acks a received MSG_STATUS
};

enum NodeType : uint8_t {
  NODE_FOULING = 0, NODE_PINSETTER = 1, NODE_SCORING = 2, NODE_SPEED = 3,
};

struct NodeMessage {
  uint8_t msgType;       // MsgType
  uint8_t seq;           // ack/retry correlation (see "Reliability scope")
  uint8_t code;          // msgType-scoped sub-code, see table below
  uint8_t laneNumber;    // 0 = node-level / not lane-specific
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
fouling, speed, pinsetter, and the gateway. RS485 exists to insulate the
whole mesh against ESP-NOW radio failures, not just the gateway↔pinsetter
link specifically, so it doesn't stop at the one node pair with the most
obviously expensive failure mode. See "RS485 framing" below for how this
works as a shared bus rather than a set of point-to-point links (the ESP32
only has one spare `HardwareSerial` on the gateway after the Pi link, so a
star of separate point-to-point RS485 links isn't even physically possible
here).

## Per-`msgType` field mapping

### `MSG_REGISTER` — any node → gateway, boot + every 10s, **ESP-NOW only**
| field | value |
|---|---|
| `code` | `NodeType` of the sender |
| `laneNumber` | 0 |
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
| `laneNumber` | the lane |
| `data[]` | unused |

The fouling node only ever transmits on RS485 — it has no recv callback on
either transport (see `HANDOFF.md`'s "nodes are dumb" principle), so there's
nothing to gate on registration or peer state the way the pinsetter's
two-way traffic is. It just enqueues the RS485 frame unconditionally
alongside every ESP-NOW send.

### `MSG_BEAM_EVENT` — speed node → gateway, **dual-sent (ESP-NOW + RS485)**
```cpp
enum BeamEventCode : uint8_t { BEAM_CLEAR = 0, BEAM_BROKEN = 1 };
enum BeamRole      : uint8_t { ROLE_UPSTREAM = 0, ROLE_DOWNSTREAM = 1 };
```
| field | value |
|---|---|
| `code` | `BeamEventCode` |
| `laneNumber` | the lane |
| `data[0]` | `BeamRole` |

No timing/pairing math here or anywhere in firmware — see `HANDOFF.md`'s
"nodes are dumb" principle. Pairing upstream/downstream into an interval
happens on the Pi. Same transmit-only pattern as the fouling node above.

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
| `laneNumber` | target lane (ignored for `CMD_STATUS`) |
| `data[]` | unused |

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
  uint8_t laneNumber;       // 0 = unused slot
  uint8_t flags;             // bit0=on, bit1=cycling, bit2=ball(0=1st/1=2nd), bits3-4=pendingCycles(0-3)
  uint16_t cooldownMs;       // full ms precision, 0-65535 (A2 cycle time ~8000ms fits easily)
};
#define MAX_MACHINES_PER_MSG 4   // matches the 8RO board's hardware ceiling (2 relays/machine x 4)
```
| field | value |
|---|---|
| `code` | `StatusCode` |
| `laneNumber` | the specific machine's lane for single-machine events (`STATUS_RELAY_ACK`, `STATUS_PULSE_ACK`, `STATUS_PULSE_COMPLETE`, `STATUS_REFUSED_PULSE_ONLY`, `STATUS_CYCLE_COMPLETE`, `STATUS_RESPOT_STUB`); **0** for node-level events that cover every machine (`STATUS_ALL_ACK`, `STATUS_RELAY_FAULT`, `STATUS_MACHINE_STATUS`, `STATUS_DI_CHANGE`, `STATUS_HEARTBEAT`) |
| `data[0]` | `relayState` (raw 8-bit relay bitmask) |
| `data[1]` | `diState` (raw 8-bit DI bitmask) |
| `data[2..17]` | up to `MAX_MACHINES_PER_MSG` (4) × `MachineRecord`, 4 bytes each — **always all machines, regardless of `code`**, same as the old JSON always included the full `machines[]` array no matter what `type` was |
| `data[18..63]` | reserved, zeroed on send — 46 bytes free for future fields (firmware version, uptime, error codes, RSSI, ...) without another protocol-breaking redesign |

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
| `laneNumber` | the lane |
| `data[0..1]` | `pinfallMask`, `uint16_t` LE, bit per pin 1–10, **bit=1 means that pin fell on this ball** (bit0=pin1 ... bit9=pin10) — the count/delta of *newly* fallen pins, not a raw standing-pin snapshot. Was ambiguous until `scoring/game_state.py` needed a firm answer to score against; that module works in per-ball pinfall *counts* derived from this, not the mask directly — see its docstring. The camera pipeline (`pinfall.py`, not yet implemented) is responsible for turning a raw standing-pins observation into this delta before it ever reaches `MSG_SCORE_EVENT`. |

### `MSG_ACK` — gateway → pinsetter, **dual-sent (ESP-NOW + RS485)**
| field | value |
|---|---|
| `code` | the `msgType` being acked (always `MSG_STATUS` today — see "Reliability scope") |
| `seq` | the `seq` value being acknowledged |
| `laneNumber`, `data[]` | unused |

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
the gateway, fouling node, speed node, and pinsetter all tap into the same
physical wire pair. (The ESP32 only has one `HardwareSerial` left on the
gateway after the Pi link uses another, so separate point-to-point RS485
runs to each node aren't even physically possible with this hardware —
multi-drop is the only option, which conveniently is also RS485's whole
reason to exist.)

**There is no sender/receiver addressing in the frame.** This works only
because of a structural assumption that holds for the current topology: each
gateway's mesh has *at most one node of each type* (one fouling node, one
speed node, one pinsetter), so `msgType` (and `code` for `MSG_REGISTER`)
already tells the receiver unambiguously who must have sent it —
`MSG_LANE_EVENT` can only ever come from the fouling node, `MSG_BEAM_EVENT`
only from the speed node, `MSG_STATUS` only from the pinsetter. **If that
assumption ever breaks — e.g. two fouling nodes sharing one RS485 bus —
real addressing has to be added to the frame.** Not designed for yet.

The pinsetter's existing send-side collision-avoidance queue (idle detection
+ jitter before transmitting, since RS485 is half-duplex) is used by every
node now, not just the pinsetter — with more transmitters sharing one bus,
this matters more than it used to, not less.

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
`timestampMs` sits at byte offset 4, not immediately after `laneNumber`.
`MachineRecord`'s `cooldownMs` (`uint16_t`) only needs 2-byte alignment,
which it already has at offset 2, so it has zero padding.

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
2026-08-06), which forwards every pinsetter `MSG_STATUS` down to the Pi
verbatim (`statusCode`, `laneNumber`, `timestampMs`) — added so the Pi's game
state machine has a real `STATUS_CYCLE_COMPLETE` signal instead of guessing
off a fixed timeout after sending `CMD_CYCLE`/`CMD_RERACK`. See
`scoring/protocol.py`'s `StatusEvent` for the Pi-side decode.
