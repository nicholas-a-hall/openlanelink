// ============================================================================
// openlanelink -- CANONICAL MESH WIRE PROTOCOL
//
// The single definition of every byte that crosses the mesh, on either
// transport (ESP-NOW or RS485). firmware/PROTOCOL.md is the prose reference
// for this file; if the wire format changes, change PROTOCOL.md first, then
// this header, then re-sync the copies.
//
// ONE COPY, SHARED BY EVERY SKETCH. This is an Arduino library
// (firmware/lib/lanelink), not a per-sketch header, precisely because nodes
// whose enum values or struct layout have drifted apart do not fail loudly --
// they silently misparse every frame from every peer on the mesh. There is
// nothing to keep in sync because there is only one of these.
//
// It has to be visible to the Arduino IDE before anything will compile:
//
//     bash firmware/tools/install_lanelink_library.sh
//
// (one-time; links this folder into your Arduino sketchbook's libraries/.
// Re-run --check any time to confirm the link still points here.) Sketches
// then use `#include <lanelink_protocol.h>`.
// ============================================================================

#pragma once

#include <Arduino.h>

// ---- Message types ---------------------------------------------------------
// Every message on every transport is one NodeMessage; `msgType` is what
// every receive handler dispatches on first. See PROTOCOL.md.
enum MsgType : uint8_t {
  MSG_REGISTER    = 0,  // any node -> gateway, ESP-NOW only, boot + every 10s
  MSG_LANE_EVENT  = 1,  // fouling -> gateway, dual-sent
  MSG_BEAM_EVENT  = 2,  // speed OR ball detect -> gateway, dual-sent
  MSG_COMMAND     = 3,  // gateway -> pinsetter, dual-sent
  MSG_STATUS      = 4,  // pinsetter -> gateway, dual-sent
  MSG_SCORE_EVENT = 5,  // gateway -> broadcast, dual-sent
  MSG_ACK         = 6,  // gateway -> pinsetter, dual-sent, acks a MSG_STATUS
};

// Carried only in MSG_REGISTER's `code` field -- after registration the mesh
// relies on at-most-one-node-of-each-type to infer a sender from `msgType`.
enum NodeType : uint8_t {
  NODE_FOULING = 0, NODE_PINSETTER = 1, NODE_SCORING = 2, NODE_SPEED = 3,
  NODE_BALL_DETECT = 4,
};

// ---- Lane side -------------------------------------------------------------
// A gateway's mesh is exactly ONE LANE PAIR, so no node needs to know its
// real lane number -- only which of the pair's two sides it is talking about.
// Every leaf sketch is therefore identical across every pair in the house
// (GATEWAY_MAC is the only per-pair constant left), and the side -> lane
// resolution lives once, in software, on the Pi: see
// software/lanecompute/backend/uart_bridge/lane_map.py.
//
// LaneSide::NONE deliberately keeps 0's prior meaning as the old `laneNumber`
// field's "node-level / not lane-specific" sentinel, so every `== 0` check on
// either side of the wire means exactly what it meant before this rename.
//
// Scoped (`enum class`) so the values can be named plainly -- LaneSide::A,
// LaneSide::B -- without putting bare `A`/`B` identifiers at global scope in
// an Arduino sketch, where they would collide with the first library that
// declares a variable or macro by either name. The fixed uint8_t underlying
// type keeps it one byte on the wire AND makes every byte value a valid
// LaneSide, so memcpy'ing an untrusted frame off the wire into a NodeMessage
// is well-defined even when a corrupt byte isn't one of the three below.
enum class LaneSide : uint8_t {
  NONE = 0,   // node-level / not side-specific (also: unused MachineRecord slot)
  A    = 1,
  B    = 2,
};

// ---- Per-msgType sub-codes -------------------------------------------------
// `code` is scoped to `msgType`, not global, so these enums are independent
// of each other and free to overlap.
enum LaneEventCode : uint8_t { LANE_CLEAR = 0, LANE_FOUL = 1 };

enum BeamEventCode : uint8_t { BEAM_CLEAR = 0, BEAM_BROKEN = 1 };

// 0/1 are the speed node's PAIRED beams; 2 is the ball detection node's
// single near-pins beam, deliberately distinct so the Pi doesn't feed it into
// speed pairing and report a fabricated mph -- see PROTOCOL.md's
// MSG_BEAM_EVENT section for why this is worth an enum value.
enum BeamRole : uint8_t {
  ROLE_UPSTREAM = 0, ROLE_DOWNSTREAM = 1, ROLE_BALL_DETECT = 2,
};

enum CommandCode : uint8_t {
  CMD_CYCLE = 0, CMD_POWER_ON = 1, CMD_POWER_OFF = 2,
  CMD_RERACK = 3, CMD_RESPOT = 4, CMD_STATUS = 5,
};

enum StatusCode : uint8_t {
  STATUS_RELAY_ACK = 0, STATUS_PULSE_ACK = 1, STATUS_PULSE_COMPLETE = 2,
  STATUS_ALL_ACK = 3, STATUS_RELAY_FAULT = 4, STATUS_REFUSED_PULSE_ONLY = 5,
  STATUS_MACHINE_STATUS = 6, STATUS_RESPOT_STUB = 7, STATUS_DI_CHANGE = 8,
  STATUS_HEARTBEAT = 9, STATUS_CYCLE_COMPLETE = 10,
};

// ---- The one struct --------------------------------------------------------
struct NodeMessage {
  uint8_t msgType;       // MsgType
  uint8_t seq;           // ack/retry correlation
  uint8_t code;          // msgType-scoped sub-code (see enums above)
  LaneSide laneSide;     // one byte; LaneSide::NONE = node-level
  uint32_t timestampMs;  // sender's own millis() -- uptime, NOT epoch
  uint8_t data[64];      // msgType-specific, see PROTOCOL.md
};

// 72 is deliberately a multiple of 4: timestampMs (uint32_t) needs 4-byte
// alignment, which is why it sits at offset 4 rather than immediately after
// laneSide, and why the struct has zero TRAILING padding. This has bitten the
// project once already. If this fires, the wire format changed -- fix the
// struct, don't relax the assert.
static_assert(sizeof(NodeMessage) == 72, "NodeMessage must stay 72 bytes -- see PROTOCOL.md");

// ---- MachineRecord accessors (MSG_STATUS's data[2..17]) --------------------
// Up to MAX_MACHINES_PER_MSG records, 4 bytes each, packed into data[]:
//   [0] laneSide (LaneSide::NONE = unused slot)
//   [1] flags
//   [2] cooldownMs low byte
//   [3] cooldownMs high byte
// Every MSG_STATUS carries ALL machines regardless of `code`, so a reader
// always has fresh data no matter which StatusCode triggered the message.
#define MAX_MACHINES_PER_MSG 4
#define MACHINE_RECORD_OFFSET 2   // data[] index of the first record
#define MACHINE_RECORD_SIZE   4

#define MACHINE_FLAG_ON            0x01
#define MACHINE_FLAG_CYCLING       0x02
#define MACHINE_FLAG_BALL2         0x04   // set = 2nd ball, clear = 1st
#define MACHINE_PENDING_SHIFT      3
#define MACHINE_PENDING_MASK       0x03   // pendingCycles, 0-3

inline int machineRecordOffset(int i) {
  return MACHINE_RECORD_OFFSET + i * MACHINE_RECORD_SIZE;
}

inline uint16_t machineRecordCooldownMs(const uint8_t *data, int i) {
  int off = machineRecordOffset(i);
  return (uint16_t)(data[off + 2] | (data[off + 3] << 8));
}

// ---- RS485 framing ---------------------------------------------------------
// [0xAA START][LEN][PAYLOAD = the raw NodeMessage bytes][CHECKSUM]
// No message-type wrapper byte -- NodeMessage's own msgType is already the
// first payload byte, since the whole struct is what gets framed.
#define RS485_FRAME_START 0xAA
#define RS485_FRAME_SIZE (sizeof(NodeMessage) + 3)   // start + len + payload + checksum

// ---- Dual-send duplicate filter --------------------------------------------
// Every operational message goes out on ESP-NOW *and* RS485, unconditionally
// (PROTOCOL.md's "Dual-send"). Both copies are byte-identical -- senders stamp
// seq and timestampMs once, before either send -- so when both transports are
// actually up, a receiver sees each message TWICE and will act on it twice
// unless it filters. For the gateway that meant every foul, every
// ball-detect trigger, and every STATUS_CYCLE_COMPLETE reaching the Pi
// doubled.
//
// The key is exact rather than a hash, so there are no false positives: a
// genuinely new message differs in at least timestampMs (the sender's own
// millis()) or seq. data[0] is included because MSG_BEAM_EVENT is the one
// msgType with two possible senders (speed and ball detect nodes), each with
// its own independent seq counter -- their beam role is what tells an
// unlucky same-millisecond, same-seq coincidence apart.
//
// The window has to cover the worst-case lag between the two copies, which is
// the RS485 queue draining ahead of this frame: 8 queued frames x 75 bytes at
// 9600 baud 8N1 is roughly 900ms, plus idle/jitter backoff.
#define DUAL_SEND_FILTER_SLOTS 8
#define DUAL_SEND_FILTER_WINDOW_MS 1500

struct DualSendFilter {
  struct Entry {
    uint8_t msgType;
    uint8_t seq;
    uint8_t code;
    LaneSide laneSide;
    uint8_t data0;
    uint32_t timestampMs;
    unsigned long seenAt;
    bool used;
  };

  Entry slots[DUAL_SEND_FILTER_SLOTS] = {};
  int next = 0;

  // Returns true if this exact message was already seen inside the window
  // (i.e. this is the other transport's copy). Otherwise records it and
  // returns false. Call once per inbound message, on every transport.
  bool seenBefore(const NodeMessage &msg) {
    unsigned long now = millis();
    for (int i = 0; i < DUAL_SEND_FILTER_SLOTS; i++) {
      Entry &e = slots[i];
      if (!e.used) continue;
      if (now - e.seenAt > DUAL_SEND_FILTER_WINDOW_MS) { e.used = false; continue; }
      if (e.msgType == msg.msgType && e.seq == msg.seq && e.code == msg.code &&
          e.laneSide == msg.laneSide && e.data0 == msg.data[0] &&
          e.timestampMs == msg.timestampMs) {
        return true;
      }
    }

    Entry &slot = slots[next];
    next = (next + 1) % DUAL_SEND_FILTER_SLOTS;
    slot = Entry{msg.msgType, msg.seq, msg.code, msg.laneSide, msg.data[0],
                 msg.timestampMs, now, true};
    return false;
  }
};

// ---- Human-readable names (Serial logging only) ----------------------------
inline const char *laneSideName(LaneSide side) {
  switch (side) {
    case LaneSide::A:    return "A";
    case LaneSide::B:    return "B";
    case LaneSide::NONE: return "-";
    default:             return "?";   // reachable: any byte is a valid LaneSide
  }
}

inline const char *msgTypeName(uint8_t type) {
  switch (type) {
    case MSG_REGISTER:    return "REGISTER";
    case MSG_LANE_EVENT:  return "LANE_EVENT";
    case MSG_BEAM_EVENT:  return "BEAM_EVENT";
    case MSG_COMMAND:     return "COMMAND";
    case MSG_STATUS:      return "STATUS";
    case MSG_SCORE_EVENT: return "SCORE_EVENT";
    case MSG_ACK:         return "ACK";
    default:              return "UNKNOWN";
  }
}

inline const char *nodeTypeName(uint8_t type) {
  switch (type) {
    case NODE_FOULING:     return "FOULING";
    case NODE_PINSETTER:   return "PINSETTER";
    case NODE_SCORING:     return "SCORING";
    case NODE_SPEED:       return "SPEED";
    case NODE_BALL_DETECT: return "BALL_DETECT";
    default:               return "UNKNOWN";
  }
}

inline const char *beamRoleName(uint8_t role) {
  switch (role) {
    case ROLE_UPSTREAM:    return "upstream";
    case ROLE_DOWNSTREAM:  return "downstream";
    case ROLE_BALL_DETECT: return "ball_detect";
    default:               return "UNKNOWN";
  }
}

inline const char *commandCodeName(uint8_t code) {
  switch (code) {
    case CMD_CYCLE:     return "CYCLE";
    case CMD_POWER_ON:  return "POWER_ON";
    case CMD_POWER_OFF: return "POWER_OFF";
    case CMD_RERACK:    return "RERACK";
    case CMD_RESPOT:    return "RESPOT";
    case CMD_STATUS:    return "STATUS";
    default:            return "UNKNOWN";
  }
}

inline const char *statusCodeName(uint8_t code) {
  switch (code) {
    case STATUS_RELAY_ACK:          return "RELAY_ACK";
    case STATUS_PULSE_ACK:          return "PULSE_ACK";
    case STATUS_PULSE_COMPLETE:     return "PULSE_COMPLETE";
    case STATUS_ALL_ACK:            return "ALL_ACK";
    case STATUS_RELAY_FAULT:        return "RELAY_FAULT";
    case STATUS_REFUSED_PULSE_ONLY: return "REFUSED_PULSE_ONLY";
    case STATUS_MACHINE_STATUS:     return "MACHINE_STATUS";
    case STATUS_RESPOT_STUB:        return "RESPOT_STUB";
    case STATUS_DI_CHANGE:          return "DI_CHANGE";
    case STATUS_HEARTBEAT:          return "HEARTBEAT";
    case STATUS_CYCLE_COMPLETE:     return "CYCLE_COMPLETE";
    default:                        return "UNKNOWN";
  }
}

// Parses a bench-console side token ("a"/"A"/"b"/"B"). Returns LaneSide::NONE
// for anything else, which every caller treats as a usage error -- there is
// no lane number to fall back on anymore.
inline LaneSide laneSideFromChar(char c) {
  switch (c) {
    case 'a': case 'A': return LaneSide::A;
    case 'b': case 'B': return LaneSide::B;
    default:            return LaneSide::NONE;
  }
}
