// openlanelink -- GATEWAY NODE
//
// Downstream nodes (fouling, speed, ball detect, pinsetter) register
// themselves on startup by sending MSG_REGISTER, which this node adds as an
// ESP-NOW peer on the fly -- no MACs are hardcoded here. Registration carries
// a nodeType (in the `code` field) so the gateway knows what it just learned
// about.
//
// ONE GATEWAY == ONE LANE PAIR == ONE MESH. Everything on this mesh is
// addressed by which SIDE of the pair it concerns (LaneSide::A /
// LaneSide::B), never by a lane number -- that's what lets every leaf sketch
// be identical on every pair in the house. This gateway is lane-agnostic in
// the strongest sense: it doesn't know, and never learns, which real lanes
// its pair is. Resolving side -> lane number happens exactly once, in
// software, on the Pi (uart_bridge/lane_map.py). Nothing here needs
// per-installation configuration at all.
//
// Fouling nodes send per-side MSG_LANE_EVENT. The gateway does NOT act on a
// FOUL itself -- it forwards the raw event to the Pi verbatim, same as any
// other sensor event, and the Pi (state_machine.py's on_foul()) decides whose
// ball it is and issues the pinsetter rerack itself via
// UART_PINSETTER_COMMAND. (Earlier version: the gateway auto-reracked
// directly off its own per-lane cooldown timer, independent of the Pi's
// actual game state -- removed 2026-08-07, see firmware/HANDOFF.md and
// state_machine/state_machine.py's FOUL_COOLDOWN_S.)
//
// Speed nodes and ball detection nodes both send per-beam MSG_BEAM_EVENT,
// told apart by data[0]'s BeamRole (0/1 = the speed node's paired beams,
// 2 = the ball detection node's single near-pins beam). This gateway does no
// pairing or interval math itself -- it just forwards raw beam events to the
// Pi regardless of role. Pairing upstream/downstream timestamps into a speed
// reading, and acting on a ball reaching the pins, are both timing/scheduling
// logic that lives on the Pi side of the bridge, not in any node's firmware.
//
// The PINSETTER NODE owns the machine config (side -> relays) and all A2
// state (ball, cycling, cooldown). This gateway sends pure semantic
// MSG_COMMAND{code=CommandCode, laneSide}.
//
// DUAL-SEND DEDUPE: every downstream node sends its operational traffic on
// BOTH ESP-NOW and RS485, so with both transports up this node sees every
// message twice. dedupe (DualSendFilter, lanelink_protocol.h) drops the
// second copy -- without it every foul, every ball-detect trigger, and every
// STATUS_CYCLE_COMPLETE reached the Pi doubled. See PROTOCOL.md's
// "Dual-send".
//
// EVERY openlanelink node -- including this one -- sends the SAME
// NodeMessage struct for every purpose (registration, events, commands,
// status, acks, broadcast score). There is no more JSON and no more
// per-message-type struct. See the shared `lanelink` Arduino library
// (firmware/lib/lanelink, installed via
// firmware/tools/install_lanelink_library.ps1 (Windows) or .sh) for the canonical definitions
// and firmware/PROTOCOL.md for the prose reference.
//
// PI LINK: the scoring compute node is a Raspberry Pi wired directly to this
// board's UART2 (pins below, unverified placeholder). This gateway
// TRANSLATES between the mesh and the Pi's UART framing -- it is not a raw
// byte pass-through. The Pi-facing payload LAYOUTS are unchanged by the
// A/B-side rename (same field sizes and offsets), only the meaning of the
// lane byte changed: it now carries a LaneSide, which uart_bridge resolves
// to a real lane number. See firmware/HANDOFF.md's "Gateway <-> Pi UART
// bridge" section and PROTOCOL.md's "Gateway <-> Pi UART boundary" note.
//
// Bench testing: type commands into this node's serial monitor (9600):
//   cycle a          -- fire side A's cycle solenoid once
//   rerack b         -- cycle side B through to a fresh full rack
//   respot a         -- stub on the node, logged + acked only
//   power a on|off   -- latch/release side A's machine power
//   pstatus          -- ask the pinsetter node for a machine_status report
//   status           -- dump this gateway's registered peers
//
// Every payload this node receives or sends is logged to serial at 9600 baud.
//
// Uses the esp32 core 3.3.x ESP-NOW callback signatures: recv takes
// esp_now_recv_info_t* (sender MAC in ->src_addr), send takes
// wifi_tx_info_t* (destination MAC in ->des_addr). Older cores instead pass
// the MAC directly as `const uint8_t *` for both.

#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <HardwareSerial.h>

#include <lanelink_protocol.h>
#include <lanelink_rs485.h>

const bool PINSETTER_ENABLED = true;

// ---- TEMPORARY BENCH-TEST HACK: reroute PiLink onto the USB/console UART
// (UART0) instead of its real UART2/GPIO16-17 wiring, so the binary PiLink
// protocol is reachable over the same USB cable already used for the bench
// console -- no second USB-serial adapter needed. Framed 0xAA binary and
// human Serial.print() text share the wire; the bridge's frame parser
// discards non-0xAA bytes while hunting for a frame start, so console text
// is (mostly) harmless noise to it, but the human console becomes far
// noisier/less readable and BOTH now run at PI_UART_BAUD, not 9600 -- set
// your serial monitor to that baud while this is on. REVERT (set to 0)
// before any real deployment; this is not how the Pi will actually be wired.
#define PILINK_OVER_USB_BENCH_TEST 1

// ---- Pi link (UART2) -- pins UNVERIFIED, confirm against the board ----
#define PI_UART_RX_PIN 16
#define PI_UART_TX_PIN 17
#define PI_UART_BAUD 115200
#if PILINK_OVER_USB_BENCH_TEST
  #define PiLink Serial
#else
  HardwareSerial PiLink(2);
#endif

// ---- RS485 (UART1) -- the shared fallback bus every node taps, insulating
// the whole mesh against ESP-NOW failures. Pins UNVERIFIED, confirm against
// the board. Baud MUST match every other node's. Gated independently of
// ESP-NOW peer registration -- see PROTOCOL.md's "Dual-send" section. Bus
// timing/framing lives in lanelink_rs485.h; only this board's wiring is here. ----
#define RS485_ENABLED 1
#define RS485_TX_PIN 4    // placeholder, verify
#define RS485_RX_PIN 5    // placeholder, verify
#define RS485_BAUD 9600

HardwareSerial RS485Port(1);
Rs485Link rs485(RS485Port, RS485_ENABLED);

uint8_t BROADCAST_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ESP-NOW peers must share a radio channel. This node never joins an AP, so
// it sits here. The pinsetter node pins itself to the same channel (it can
// only do that while on Ethernet -- see the note in pinsetter_node.ino).
#define ESPNOW_CHANNEL 1

// Drops the second copy of every dual-sent message -- see the header comment
// and lanelink_protocol.h's DualSendFilter.
DualSendFilter dedupe;

// ============================================================
// Pi UART payload shapes. LAYOUTS are unchanged by the A/B-side rename (same
// field sizes, same offsets, same struct padding), so state_machine/
// uart_bridge protocol.py's struct format strings need no edit -- but the
// lane byte now carries a LaneSide, not a lane number. uart_bridge resolves
// it to a real lane. These are NOT sent over the mesh, only over the UART
// link to the Pi; this gateway translates NodeMessage into them on the way.
// ============================================================

struct UartLaneEventPayload {   // matches uart_bridge/protocol.py's _LANE_EVENT_FMT
  uint8_t eventType;            // 0 = CLEAR, 1 = FOUL
  uint8_t laneSide;             // LaneSide
  uint32_t timestampMs;
};

struct UartBeamEventPayload {   // matches uart_bridge/protocol.py's _BEAM_EVENT_FMT
  uint8_t eventType;            // 3 = BEAM_CLEAR, 4 = BEAM_BROKEN
  uint8_t laneSide;             // LaneSide
  uint8_t beamRole;
  uint32_t timestampMs;
};

struct UartPinsetterStatusPayload {   // matches uart_bridge/protocol.py's _STATUS_EVENT_FMT
  uint8_t statusCode;                 // StatusCode, see lanelink_protocol.h
  uint8_t laneSide;                   // LaneSide; NONE for node-level codes, see PROTOCOL.md
  uint8_t ballNumber;                 // pinsetter's own reported ball (1 or 2) for laneSide; 0 if unknown/not applicable -- see ballForSide()
  uint32_t timestampMs;
};

struct PinsetterCommandFromPi { // Pi -> gateway, any CommandCode (cycle, rerack, ...)
  uint8_t command;
  uint8_t laneSide;     // LaneSide -- the Pi has already mapped its lane number back to a side
  uint8_t cycleCount;   // CMD_CYCLE/CMD_RERACK only: exact solenoid pulse count the Pi wants run, computed from its own tracked/reported ball state -- the pinsetter no longer derives this itself (see pinsetter_node.ino's execPinsetterCommand). Ignored by other CommandCodes.
};

struct ScoreEventFromPi {       // Pi -> gateway, then broadcast onto the mesh as MSG_SCORE_EVENT
  uint8_t laneSide;             // LaneSide
  uint8_t ballNumber;
  uint16_t pinfallMask;
  uint32_t timestampMs;
};

// ---- Gateway <-> Pi UART framing -- see firmware/HANDOFF.md ----
#define UART_FRAME_START 0xAA

enum UartMsgType : uint8_t {
  // Gateway -> Pi
  UART_LANE_EVENT         = 0x01,
  UART_BEAM_EVENT         = 0x02,
  UART_PINSETTER_STATUS   = 0x03,  // forwards a pinsetter MSG_STATUS verbatim (any StatusCode, including STATUS_CYCLE_COMPLETE)
  // Pi -> Gateway
  UART_PINSETTER_COMMAND = 0x10,  // any CommandCode -- generalized from the old cycle-only message
  UART_SCORE_EVENT       = 0x11,
};

// ============================================================

const int MAX_LANE_NODES = 8;
uint8_t registeredLaneNodes[MAX_LANE_NODES][6];
int registeredLaneNodeCount = 0;

uint8_t registeredSpeedNodes[MAX_LANE_NODES][6];
int registeredSpeedNodeCount = 0;

uint8_t registeredBallDetectNodes[MAX_LANE_NODES][6];
int registeredBallDetectNodeCount = 0;

uint8_t pinsetterMac[6];
bool pinsetterRegistered = false;

uint8_t nextSeq = 0;   // for traceability in logs -- this node's outbound MSG_COMMAND/MSG_SCORE_EVENT aren't acked

// Defined further down; declared here so the call order in this file reads
// top-down rather than depending on the Arduino preprocessor's auto-generated
// prototypes.
void forwardLaneEventToPi(const NodeMessage &msg);
void forwardBeamEventToPi(const NodeMessage &msg);
void forwardStatusToPi(const NodeMessage &msg);
void logMachineRecords(const uint8_t *data);
void handleSerialCommand(String cmd);

String macToString(const uint8_t *mac) {
  char buf[18];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
    Serial.print("[");
    Serial.print(millis());
    Serial.print(" ms] SEND to ");
    Serial.print(macToString(tx_info->des_addr));
    Serial.println(" -- FAILED");
  }
}

bool addPeer(const uint8_t *mac) {
  if (esp_now_is_peer_exist(mac)) return true;
  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, mac, 6);
  peerInfo.channel = 0;   // 0 = use current channel
  peerInfo.encrypt = false;
  return esp_now_add_peer(&peerInfo) == ESP_OK;
}

// ---- Registration ----
bool isLaneNodeRegistered(const uint8_t *mac) {
  for (int i = 0; i < registeredLaneNodeCount; i++) {
    if (memcmp(registeredLaneNodes[i], mac, 6) == 0) {
      return true;
    }
  }
  return false;
}

void registerLaneNode(const uint8_t *mac) {
  if (isLaneNodeRegistered(mac)) return;
  if (registeredLaneNodeCount >= MAX_LANE_NODES) {
    Serial.println("Lane node table full, dropping registration");
    return;
  }
  if (!addPeer(mac)) {
    Serial.print("Failed to add fouling node ");
    Serial.print(macToString(mac));
    Serial.println(" as ESP-NOW peer");
    return;
  }

  memcpy(registeredLaneNodes[registeredLaneNodeCount], mac, 6);
  registeredLaneNodeCount++;
  Serial.print("Registered FOULING node ");
  Serial.println(macToString(mac));
}

bool isSpeedNodeRegistered(const uint8_t *mac) {
  for (int i = 0; i < registeredSpeedNodeCount; i++) {
    if (memcmp(registeredSpeedNodes[i], mac, 6) == 0) {
      return true;
    }
  }
  return false;
}

void registerSpeedNode(const uint8_t *mac) {
  if (isSpeedNodeRegistered(mac)) return;
  if (registeredSpeedNodeCount >= MAX_LANE_NODES) {
    Serial.println("Speed node table full, dropping registration");
    return;
  }
  if (!addPeer(mac)) {
    Serial.print("Failed to add speed node ");
    Serial.print(macToString(mac));
    Serial.println(" as ESP-NOW peer");
    return;
  }

  memcpy(registeredSpeedNodes[registeredSpeedNodeCount], mac, 6);
  registeredSpeedNodeCount++;
  Serial.print("Registered SPEED node ");
  Serial.println(macToString(mac));
}

bool isBallDetectNodeRegistered(const uint8_t *mac) {
  for (int i = 0; i < registeredBallDetectNodeCount; i++) {
    if (memcmp(registeredBallDetectNodes[i], mac, 6) == 0) {
      return true;
    }
  }
  return false;
}

void registerBallDetectNode(const uint8_t *mac) {
  if (isBallDetectNodeRegistered(mac)) return;
  if (registeredBallDetectNodeCount >= MAX_LANE_NODES) {
    Serial.println("Ball detect node table full, dropping registration");
    return;
  }
  if (!addPeer(mac)) {
    Serial.print("Failed to add ball detect node ");
    Serial.print(macToString(mac));
    Serial.println(" as ESP-NOW peer");
    return;
  }

  memcpy(registeredBallDetectNodes[registeredBallDetectNodeCount], mac, 6);
  registeredBallDetectNodeCount++;
  Serial.print("Registered BALL DETECT node ");
  Serial.println(macToString(mac));
}

void registerPinsetterNode(const uint8_t *mac) {
  if (pinsetterRegistered && memcmp(pinsetterMac, mac, 6) == 0) return;
  if (!addPeer(mac)) {
    Serial.print("Failed to add pinsetter node ");
    Serial.print(macToString(mac));
    Serial.println(" as ESP-NOW peer");
    return;
  }

  memcpy(pinsetterMac, mac, 6);
  pinsetterRegistered = true;
  Serial.print("Registered PINSETTER node ");
  Serial.println(macToString(mac));
}

void handleRegister(const uint8_t *mac, const NodeMessage &msg) {
  switch (msg.code) {
    case NODE_FOULING:   registerLaneNode(mac); break;
    case NODE_PINSETTER: registerPinsetterNode(mac); break;
    case NODE_SPEED:     registerSpeedNode(mac); break;
    case NODE_BALL_DETECT: registerBallDetectNode(mac); break;
    case NODE_SCORING:
      // Vestigial -- scoring lives on the Pi over UART now, not as an
      // ESP-NOW node. No command path exists for this nodeType.
      Serial.print("Scoring node registered (vestigial, no command path): ");
      Serial.println(macToString(mac));
      break;
    default:
      Serial.print("REGISTER with unknown nodeType ");
      Serial.println(msg.code);
      break;
  }
}

// ---- Downstream sends ----
// MSG_COMMAND and MSG_ACK go out on BOTH ESP-NOW and RS485, unconditionally,
// every time -- always-on redundancy, not failure-detect-then-failover. Each
// transport is gated independently: ESP-NOW on dynamic peer registration,
// RS485 on the hardware simply being present (RS485_ENABLED). See
// PROTOCOL.md's "Dual-send" section.
// cycleCount only matters for CMD_CYCLE/CMD_RERACK (exact solenoid pulse
// count -- see PinsetterCommandFromPi's comment); defaulted to 1 so every
// other CommandCode's call sites don't need to think about it.
void sendPinsetterCommand(CommandCode command, LaneSide side, uint8_t cycleCount = 1) {
  if (!PINSETTER_ENABLED) return;

  NodeMessage msg = {};
  msg.msgType = MSG_COMMAND;
  msg.seq = nextSeq++;
  msg.code = command;
  msg.laneSide = side;
  msg.timestampMs = millis();
  msg.data[0] = cycleCount;

  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] SEND pinsetter MSG_COMMAND { code=");
  Serial.print(commandCodeName(command));
  Serial.print(", side=");
  Serial.print(laneSideName(side));
  if (command == CMD_CYCLE || command == CMD_RERACK) {
    Serial.print(", cycles=");
    Serial.print(cycleCount);
  }
  Serial.println(" }");

  if (pinsetterRegistered) {
    esp_now_send(pinsetterMac, (uint8_t *)&msg, sizeof(msg));
  }
  rs485.enqueue(msg);   // no-op if RS485_ENABLED is false

  if (!pinsetterRegistered && !rs485.enabled()) {
    Serial.println("No transport available for pinsetter command (not ESP-NOW registered, RS485 disabled)");
  }
}

void sendStatusAck(uint8_t seq) {
  NodeMessage ack = {};
  ack.msgType = MSG_ACK;
  ack.seq = seq;
  ack.code = MSG_STATUS;
  ack.laneSide = LaneSide::NONE;   // acks are node-level
  ack.timestampMs = millis();

  if (pinsetterRegistered) {
    esp_now_send(pinsetterMac, (uint8_t *)&ack, sizeof(ack));
  }
  rs485.enqueue(ack);
}

// Handles every msgType that can arrive on EITHER transport -- MSG_REGISTER
// is the one exception (ESP-NOW only, needs a MAC to add as a peer; see
// onDataRecv). Called from onDataRecv (ESP-NOW) and the RS485 poll callback
// alike, so a node's message is handled identically no matter which wire it
// came in on. "Messages between nodes stay uniform, regardless of transport."
//
// The dedupe check is here rather than in either transport's own path
// precisely BECAUSE it has to span both: the whole point is catching the
// second copy of a message whose first copy arrived on the other wire.
void handleIncomingNodeMessage(const NodeMessage &msg, const String &via) {
  if (dedupe.seenBefore(msg)) {
    Serial.print("[");
    Serial.print(millis());
    Serial.print(" ms] RECV via ");
    Serial.print(via);
    Serial.print(" ");
    Serial.print(msgTypeName(msg.msgType));
    Serial.print(" (seq=");
    Serial.print(msg.seq);
    Serial.println(") -- duplicate of the other transport's copy, dropped");
    return;
  }

  switch (msg.msgType) {
    case MSG_LANE_EVENT: {
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV via ");
      Serial.print(via);
      Serial.print(" MSG_LANE_EVENT { code=");
      Serial.print(msg.code == LANE_FOUL ? "FOUL" : "CLEAR");
      Serial.print(", side=");
      Serial.print(laneSideName(msg.laneSide));
      Serial.println(" }");

      // No local action on LANE_FOUL -- forwarded as-is, same as CLEAR. The
      // Pi decides whose ball this is and issues the rerack itself (see
      // this file's header comment and state_machine.py's on_foul()).
      forwardLaneEventToPi(msg);
      break;
    }

    case MSG_BEAM_EVENT: {
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV via ");
      Serial.print(via);
      Serial.print(" MSG_BEAM_EVENT { side=");
      Serial.print(laneSideName(msg.laneSide));
      Serial.print(", role=");
      Serial.print(beamRoleName(msg.data[0]));
      Serial.print(", ");
      Serial.print(msg.code == BEAM_BROKEN ? "BROKEN" : "CLEAR");
      Serial.println(" }");

      // No pairing/interval math here -- just forward the raw event. The Pi
      // side of the bridge does the timing/scheduling.
      forwardBeamEventToPi(msg);
      break;
    }

    case MSG_STATUS: {
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV via ");
      Serial.print(via);
      Serial.print(" MSG_STATUS { code=");
      Serial.print(statusCodeName(msg.code));
      Serial.print(", side=");
      Serial.print(laneSideName(msg.laneSide));
      Serial.print(", relayState=0b");
      Serial.print(msg.data[0], BIN);
      Serial.print(", diState=0b");
      Serial.println(msg.data[1], BIN);
      logMachineRecords(msg.data);

      sendStatusAck(msg.seq);
      forwardStatusToPi(msg);
      break;
    }

    default:
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV via ");
      Serial.print(via);
      Serial.print(" -- unexpected msgType ");
      Serial.println(msgTypeName(msg.msgType));
      break;
  }
}

// Rs485Link::poll() hands verified frames here; the transport label is fixed
// because anything arriving on this port came off the RS485 bus by definition.
void onRs485Message(const NodeMessage &msg) {
  handleIncomingNodeMessage(msg, "RS485");
}

// ---- Pi UART bridge ----
// Framed byte protocol (see firmware/HANDOFF.md):
//   [0xAA START][LEN][PAYLOAD (LEN bytes, payload[0] = UartMsgType)][CHECKSUM]
// CHECKSUM = XOR of LEN and every PAYLOAD byte.

uint8_t frameChecksum(uint8_t len, const uint8_t *payload) {
  uint8_t sum = len;
  for (uint8_t i = 0; i < len; i++) sum ^= payload[i];
  return sum;
}

void sendToPi(UartMsgType msgType, const uint8_t *data, uint8_t dataLen) {
  uint8_t payload[32];
  if (dataLen + 1 > (uint8_t)sizeof(payload)) {
    Serial.println("Pi UART payload too large, dropping");
    return;
  }
  payload[0] = msgType;
  memcpy(payload + 1, data, dataLen);
  uint8_t len = dataLen + 1;

  PiLink.write(UART_FRAME_START);
  PiLink.write(len);
  PiLink.write(payload, len);
  PiLink.write(frameChecksum(len, payload));
}

void forwardLaneEventToPi(const NodeMessage &msg) {
  UartLaneEventPayload p;
  p.eventType = (msg.code == LANE_FOUL) ? 1 : 0;   // uart_bridge/protocol.py EVENT_FOUL/EVENT_CLEAR
  p.laneSide = (uint8_t)msg.laneSide;
  p.timestampMs = msg.timestampMs;
  sendToPi(UART_LANE_EVENT, (const uint8_t *)&p, sizeof(p));
}

void forwardBeamEventToPi(const NodeMessage &msg) {
  UartBeamEventPayload p;
  p.eventType = (msg.code == BEAM_BROKEN) ? 4 : 3;  // uart_bridge/protocol.py EVENT_BEAM_BROKEN/EVENT_BEAM_CLEAR
  p.laneSide = (uint8_t)msg.laneSide;
  p.beamRole = msg.data[0];
  p.timestampMs = msg.timestampMs;
  sendToPi(UART_BEAM_EVENT, (const uint8_t *)&p, sizeof(p));
}

// Every MSG_STATUS carries every machine's MachineRecord (data[2..17], 4
// bytes each: laneSide, flags, cooldownLo, cooldownHi -- see
// lanelink_protocol.h and pinsetter_node.ino's sendStatusEvent()),
// regardless of which one triggered the message, so this always has fresh
// data no matter which statusCode fired. MACHINE_FLAG_BALL2 is the
// pinsetter's own ball counter. Returns 0 (the wire's "unknown/not
// applicable" sentinel, see uart_bridge/protocol.py's StatusEvent) if the
// side has no record here -- a node-level status or a side this pinsetter
// doesn't own.
uint8_t ballForSide(const NodeMessage &msg, LaneSide side) {
  // LaneSide::NONE is the node-level sentinel, and it's ALSO what an unused
  // MachineRecord slot's side byte reads as (zero-filled), so without this
  // guard a node-level status would spuriously "match" the first empty slot
  // instead of correctly finding nothing.
  if (side == LaneSide::NONE) return 0;
  for (int i = 0; i < MAX_MACHINES_PER_MSG; i++) {
    int off = machineRecordOffset(i);
    if (msg.data[off] == (uint8_t)side) {
      return (msg.data[off + 1] & MACHINE_FLAG_BALL2) ? 2 : 1;
    }
  }
  return 0;
}

void forwardStatusToPi(const NodeMessage &msg) {
  UartPinsetterStatusPayload p;
  p.statusCode = msg.code;
  p.laneSide = (uint8_t)msg.laneSide;
  p.ballNumber = ballForSide(msg, msg.laneSide);
  p.timestampMs = msg.timestampMs;
  sendToPi(UART_PINSETTER_STATUS, (const uint8_t *)&p, sizeof(p));
}

void broadcastScoreEvent(LaneSide side, uint8_t ballNumber, uint16_t pinfallMask, uint32_t timestampMs) {
  NodeMessage msg = {};
  msg.msgType = MSG_SCORE_EVENT;
  msg.seq = nextSeq++;
  msg.code = ballNumber;
  msg.laneSide = side;
  msg.timestampMs = timestampMs;
  msg.data[0] = (uint8_t)(pinfallMask & 0xFF);
  msg.data[1] = (uint8_t)(pinfallMask >> 8);

  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] BROADCAST MSG_SCORE_EVENT { side=");
  Serial.print(laneSideName(side));
  Serial.print(", ball=");
  Serial.print(ballNumber);
  Serial.print(", pinfallMask=0b");
  Serial.println(pinfallMask, BIN);

  esp_now_send(BROADCAST_MAC, (const uint8_t *)&msg, sizeof(msg));
  // RS485 is a shared multi-drop bus -- every node on it already receives
  // whatever the gateway sends, so this is broadcast too, not point-to-point.
  // No current node acts on MSG_SCORE_EVENT (see PROTOCOL.md's known gaps),
  // but every receiver's default dispatch case already logs-and-ignores
  // unknown-but-valid msgTypes harmlessly, so there's no reason to withhold
  // it from the one transport that's actually a true broadcast medium.
  rs485.enqueue(msg);
}

void handlePiMessage(uint8_t msgType, const uint8_t *payload, uint8_t len) {
  switch (msgType) {
    case UART_PINSETTER_COMMAND: {
      if (len != sizeof(PinsetterCommandFromPi)) return;
      PinsetterCommandFromPi req;
      memcpy(&req, payload, sizeof(req));
      if (req.command > CMD_STATUS) {
        Serial.print("Unknown CommandCode from Pi: ");
        Serial.println(req.command);
        return;
      }
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV from Pi PinsetterCommandFromPi { command=");
      Serial.print(commandCodeName(req.command));
      Serial.print(", side=");
      Serial.print(laneSideName((LaneSide)req.laneSide));
      Serial.print(", cycles=");
      Serial.print(req.cycleCount);
      Serial.println(" }");
      sendPinsetterCommand((CommandCode)req.command, (LaneSide)req.laneSide, req.cycleCount);
      break;
    }
    case UART_SCORE_EVENT: {
      if (len != sizeof(ScoreEventFromPi)) return;
      ScoreEventFromPi ev;
      memcpy(&ev, payload, sizeof(ev));
      broadcastScoreEvent((LaneSide)ev.laneSide, ev.ballNumber, ev.pinfallMask, ev.timestampMs);
      break;
    }
    default:
      Serial.print("Unknown UART message type from Pi: 0x");
      Serial.println(msgType, HEX);
      break;
  }
}

// Scans for frame start, reads LEN + PAYLOAD, verifies checksum. On a
// checksum mismatch the whole consumed frame is discarded and scanning
// resumes from the next byte (not a byte-by-byte rewind) -- adequate for a
// direct wired point-to-point link, where the main failure mode is a
// mid-message connect, not random bit corruption. A pathological byte
// sequence that happens to contain a stray START byte inside a bad frame's
// span can cost one real frame before resync catches up; harmless here since
// every event is tied to a live sensor/photo, not a one-shot ack.
//
// PILINK_OVER_USB_BENCH_TEST ALSO handles the bench console's line-based
// text commands here (2026-08-07), not via a separate pollSerial() call --
// see loop() below. Framed binary (0xAA-prefixed) and human-typed text
// share the exact same Serial stream in that mode, so having two
// independent readers both draining it was a real bug, not just noise: a
// separately-called pollSerial() runs every loop() iteration and
// unconditionally drains whatever's currently buffered as ASCII text --
// since loop() cycles far faster than bytes arrive at 115200 baud,
// pollSerial() won that race essentially every time, silently eating every
// byte of an inbound Pi-link frame as garbage before this function ever
// saw it. Bench-console-typed commands always worked (they never left this
// function's own dispatch); anything sent FROM the Pi never did. Dispatch
// on the first byte of each new "message" instead: 0xAA means a binary
// frame, anything else is bench-console text.
void pollPiLink() {
  static uint8_t buf[33];   // 1 (msgType) + up to 32 payload bytes
  static uint8_t bufLen = 0;
  static uint8_t expectedLen = 0;
  static bool haveLen = false;
  static bool sawStart = false;
#if PILINK_OVER_USB_BENCH_TEST
  static String cmdBuf = "";
#endif

  while (PiLink.available()) {
    uint8_t b = PiLink.read();

    if (!sawStart) {
      if (b == UART_FRAME_START) {
        sawStart = true; haveLen = false; bufLen = 0;
      }
#if PILINK_OVER_USB_BENCH_TEST
      else {
        char c = (char)b;
        if (c == '\n' || c == '\r') {
          if (cmdBuf.length() > 0) { handleSerialCommand(cmdBuf); cmdBuf = ""; }
        } else {
          cmdBuf += c;
          if (cmdBuf.length() > 80) cmdBuf = "";
        }
      }
#endif
      continue;
    }
    if (!haveLen) {
      expectedLen = b;
      haveLen = true;
      bufLen = 0;
      if (expectedLen == 0 || expectedLen > sizeof(buf)) { sawStart = false; }
      continue;
    }
    if (bufLen < expectedLen) {
      buf[bufLen++] = b;
      continue;
    }

    // b is the checksum byte
    if (b == frameChecksum(expectedLen, buf)) {
      handlePiMessage(buf[0], buf + 1, expectedLen - 1);
    } else {
      Serial.println("Pi UART checksum mismatch, dropping frame");
    }
    sawStart = false;
  }
}

// ---- MSG_STATUS logging ----
void logMachineRecords(const uint8_t *data) {
  for (int i = 0; i < MAX_MACHINES_PER_MSG; i++) {
    int off = machineRecordOffset(i);
    LaneSide side = (LaneSide)data[off];
    if (side == LaneSide::NONE) continue;   // unused slot
    uint8_t flags = data[off + 1];
    Serial.print("    side "); Serial.print(laneSideName(side));
    Serial.print(" on="); Serial.print((flags & MACHINE_FLAG_ON) ? 1 : 0);
    Serial.print(" cycling="); Serial.print((flags & MACHINE_FLAG_CYCLING) ? 1 : 0);
    Serial.print(" ball="); Serial.print((flags & MACHINE_FLAG_BALL2) ? 2 : 1);
    Serial.print(" pendingCycles="); Serial.print((flags >> MACHINE_PENDING_SHIFT) & MACHINE_PENDING_MASK);
    Serial.print(" cooldownMs="); Serial.println(machineRecordCooldownMs(data, i));
  }
}

// ---- ESP-NOW receive ----
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *incomingData, int len) {
  if (len != sizeof(NodeMessage)) {
    Serial.print("[");
    Serial.print(millis());
    Serial.print(" ms] RECV from ");
    Serial.print(macToString(info->src_addr));
    Serial.print(" -- unexpected length ");
    Serial.println(len);
    return;
  }

  NodeMessage msg;
  memcpy(&msg, incomingData, sizeof(msg));

  // MSG_REGISTER is ESP-NOW only (needs a MAC to add as a peer -- no
  // equivalent concept on a raw RS485 bus) so it's handled here, not in the
  // shared handler. It also deliberately skips the dual-send dedupe: it's
  // never dual-sent, and it repeats every 10s by design.
  if (msg.msgType == MSG_REGISTER) {
    // Nodes re-announce every 10s so a gateway reboot re-learns them.
    // Silently ignore re-registrations from nodes we already know.
    bool alreadyKnown =
      (msg.code == NODE_FOULING && isLaneNodeRegistered(info->src_addr)) ||
      (msg.code == NODE_SPEED && isSpeedNodeRegistered(info->src_addr)) ||
      (msg.code == NODE_BALL_DETECT && isBallDetectNodeRegistered(info->src_addr)) ||
      (msg.code == NODE_PINSETTER && pinsetterRegistered &&
       memcmp(pinsetterMac, info->src_addr, 6) == 0);
    if (alreadyKnown) return;

    Serial.print("[");
    Serial.print(millis());
    Serial.print(" ms] RECV from ");
    Serial.print(macToString(info->src_addr));
    Serial.print(" MSG_REGISTER { nodeType=");
    Serial.print(nodeTypeName(msg.code));
    Serial.println(" }");

    handleRegister(info->src_addr, msg);
    return;
  }

  handleIncomingNodeMessage(msg, macToString(info->src_addr));
}

// ---- Serial bench-test console ----
void printStatus() {
  Serial.println("---- gateway status ----");
  Serial.print("Fouling nodes registered: ");
  Serial.println(registeredLaneNodeCount);
  for (int i = 0; i < registeredLaneNodeCount; i++) {
    Serial.print("  "); Serial.println(macToString(registeredLaneNodes[i]));
  }
  Serial.print("Speed nodes registered: ");
  Serial.println(registeredSpeedNodeCount);
  for (int i = 0; i < registeredSpeedNodeCount; i++) {
    Serial.print("  "); Serial.println(macToString(registeredSpeedNodes[i]));
  }
  Serial.print("Ball detect nodes registered: ");
  Serial.println(registeredBallDetectNodeCount);
  for (int i = 0; i < registeredBallDetectNodeCount; i++) {
    Serial.print("  "); Serial.println(macToString(registeredBallDetectNodes[i]));
  }
  Serial.print("Pinsetter node: ");
  Serial.println(pinsetterRegistered ? macToString(pinsetterMac) : "not registered");
  Serial.println("(machine config lives on the pinsetter node -- use pstatus)");
  Serial.println("(this gateway addresses sides A/B only -- it has no lane numbers)");
  Serial.println("------------------------");
}

// Bench console commands take a side (a|b), not a lane number -- this
// gateway has no idea which lanes its pair is. Returns LaneSide::NONE on
// anything unparseable, which every caller reports as a usage error.
LaneSide parseSideArg(String arg) {
  arg.trim();
  if (arg.length() != 1) return LaneSide::NONE;
  return laneSideFromChar(arg.charAt(0));
}

void printUsage() {
  Serial.println("commands: cycle <a|b> | rerack <a|b> | respot <a|b> | power <a|b> on|off | pstatus | status");
}

void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd == "status") {
    printStatus();
    return;
  }
  if (cmd == "pstatus") {
    sendPinsetterCommand(CMD_STATUS, LaneSide::NONE);
    return;
  }

  if (cmd.startsWith("cycle ")) {
    LaneSide side = parseSideArg(cmd.substring(6));
    if (side == LaneSide::NONE) { printUsage(); return; }
    sendPinsetterCommand(CMD_CYCLE, side, 1);
    return;
  }
  if (cmd.startsWith("rerack ")) {
    LaneSide side = parseSideArg(cmd.substring(7));
    if (side == LaneSide::NONE) { printUsage(); return; }
    // No Pi-tracked ball state available from the bench console -- 2 is the
    // safe default (sweep + spot fresh works regardless of the machine's
    // actual current position; see state_machine.py's rerack cycle-count
    // logic for the real Pi-driven decision).
    sendPinsetterCommand(CMD_RERACK, side, 2);
    return;
  }
  if (cmd.startsWith("respot ")) {
    LaneSide side = parseSideArg(cmd.substring(7));
    if (side == LaneSide::NONE) { printUsage(); return; }
    sendPinsetterCommand(CMD_RESPOT, side);
    return;
  }
  if (cmd.startsWith("power ")) {
    String rest = cmd.substring(6);
    int sp = rest.indexOf(' ');
    if (sp == -1) {
      Serial.println("usage: power <a|b> on|off");
      return;
    }
    LaneSide side = parseSideArg(rest.substring(0, sp));
    String action = rest.substring(sp + 1);
    action.trim();
    if (side == LaneSide::NONE || (action != "on" && action != "off")) {
      Serial.println("usage: power <a|b> on|off");
      return;
    }
    sendPinsetterCommand(action == "on" ? CMD_POWER_ON : CMD_POWER_OFF, side);
    return;
  }

  printUsage();
}

void pollSerial() {
  static String buf = "";
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (buf.length() > 0) { handleSerialCommand(buf); buf = ""; }
    } else {
      buf += c;
      if (buf.length() > 80) buf = "";
    }
  }
}

void setup() {
#if PILINK_OVER_USB_BENCH_TEST
  Serial.begin(PI_UART_BAUD);  // PiLink IS Serial in this mode -- one shared baud, see the flag's comment above
#else
  Serial.begin(115200);
#endif
  delay(200);

  Serial.println();
  Serial.println("Gateway node starting");

#if !PILINK_OVER_USB_BENCH_TEST
  PiLink.begin(PI_UART_BAUD, SERIAL_8N1, PI_UART_RX_PIN, PI_UART_TX_PIN);
#endif
  Serial.print("Pi UART link up at ");
  Serial.print(PI_UART_BAUD);
  Serial.println(" baud");

  randomSeed(esp_random());
  rs485.begin(RS485_BAUD, RS485_RX_PIN, RS485_TX_PIN);
  if (rs485.enabled()) Serial.println("RS485 fallback link up");

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // modem sleep makes ESP-NOW receivers miss packets
  delay(100);  // let the STA netif settle before reading its MAC
  Serial.print("Gateway MAC address: ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
    return;
  }

  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  Serial.print("ESP-NOW channel: ");
  Serial.println(ESPNOW_CHANNEL);

  esp_now_register_recv_cb(onDataRecv);
  esp_now_register_send_cb(onDataSent);

  // Broadcast peer for score results the Pi emits -- see broadcastScoreEvent().
  if (!addPeer(BROADCAST_MAC)) {
    Serial.println("Failed to add broadcast address as ESP-NOW peer");
  }

  Serial.println("Waiting for nodes to register...");
  printUsage();
}

void loop() {
#if !PILINK_OVER_USB_BENCH_TEST
  // Only a genuinely separate stream from PiLink in real deployment (UART2
  // vs Serial/UART0) -- in bench-test mode pollPiLink() itself handles
  // bench-console text too, see its comment above.
  pollSerial();
#endif
  pollPiLink();
  rs485.poll(onRs485Message);
  rs485.processQueue();
}
