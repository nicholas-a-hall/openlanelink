// openlanelink -- GATEWAY NODE
//
// Downstream nodes (fouling, speed, ball detect, pinsetter) register
// themselves on startup by sending MSG_REGISTER, which this node adds as an
// ESP-NOW peer on the fly -- no MACs are hardcoded here. Registration carries
// a nodeType (in the `code` field) so the gateway knows what it just learned
// about.
//
// Fouling nodes send per-lane MSG_LANE_EVENT (one fouling node can cover
// several lanes). The gateway does NOT act on a FOUL itself -- it forwards
// the raw event to the Pi verbatim, same as any other sensor event, and the
// Pi (state_machine.py's on_foul()) decides whose ball it is and issues the
// pinsetter rerack itself via UART_PINSETTER_COMMAND. (Earlier version: the
// gateway auto-reracked directly off its own per-lane cooldown timer,
// independent of the Pi's actual game state -- removed 2026-08-07, see
// firmware/HANDOFF.md and state_machine/state_machine.py's FOUL_COOLDOWN_S.)
//
// Speed nodes and ball detection nodes both send per-beam MSG_BEAM_EVENT,
// told apart by data[0]'s BeamRole (0/1 = the speed node's paired beams,
// 2 = the ball detection node's single near-pins beam). This gateway does no
// pairing or interval math itself -- it just forwards raw beam events to the
// Pi regardless of role. Pairing upstream/downstream timestamps into a speed
// reading, and acting on a ball reaching the pins, are both timing/scheduling
// logic that lives on the Pi side of the bridge, not in any node's firmware.
//
// The PINSETTER NODE owns the machine config (lane -> relays) and all A2
// state (ball, cycling, cooldown). This gateway sends pure semantic
// MSG_COMMAND{code=CommandCode, laneNumber}.
//
// EVERY openlanelink node -- including this one -- sends the SAME
// NodeMessage struct for every purpose (registration, events, commands,
// status, acks, broadcast score). There is no more JSON and no more
// per-message-type struct. See firmware/PROTOCOL.md for the canonical
// reference; this file's local copy of the struct/enums MUST match every
// other node's.
//
// PI LINK: the scoring compute node is a Raspberry Pi wired directly to this
// board's UART2 (pins below, unverified placeholder). This gateway
// TRANSLATES between ESP-NOW and the Pi's UART framing -- it is not a raw
// byte pass-through, so the Pi-facing UART payload shapes are unchanged from
// before the ESP-NOW protocol unification (state_machine/protocol.py needs no
// changes). See firmware/HANDOFF.md's "Gateway <-> Pi UART bridge" section
// and PROTOCOL.md's "Gateway <-> Pi UART boundary" note.
//
// Bench testing: type commands into this node's serial monitor (9600):
//   cycle 7          -- fire lane 7's cycle solenoid once
//   rerack 7         -- cycle lane 7 through to a fresh full rack
//   respot 7         -- stub on the node, logged + acked only
//   power 7 on|off   -- latch/release lane 7's machine power
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

// ---- RS485 (UART1) to the pinsetter -- wired fallback to insulate against
// ESP-NOW failures. Pins UNVERIFIED, confirm against the board. Baud MUST
// match the pinsetter's RS485_BAUD. Gated independently of ESP-NOW peer
// registration -- see PROTOCOL.md's "Dual-send" section. ----
const bool RS485_ENABLED = true;
#define RS485_TX_PIN 4    // placeholder, verify
#define RS485_RX_PIN 5    // placeholder, verify
#define RS485_BAUD 9600
#define RS485_IDLE_MS 15
#define RS485_JITTER_MAX_MS 20
#define RS485_MAX_QUEUE 8
HardwareSerial RS485(1);

uint8_t BROADCAST_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ESP-NOW peers must share a radio channel. This node never joins an AP, so
// it sits here. The pinsetter node pins itself to the same channel (it can
// only do that while on Ethernet -- see the note in pinsetter_node.ino).
#define ESPNOW_CHANNEL 1

// ============================================================
// Wire protocol -- see firmware/PROTOCOL.md. MUST match every other node.
// ============================================================

enum MsgType : uint8_t {
  MSG_REGISTER = 0, MSG_LANE_EVENT = 1, MSG_BEAM_EVENT = 2,
  MSG_COMMAND = 3, MSG_STATUS = 4, MSG_SCORE_EVENT = 5, MSG_ACK = 6,
};

enum NodeType : uint8_t {
  NODE_FOULING = 0, NODE_PINSETTER = 1, NODE_SCORING = 2, NODE_SPEED = 3,
  NODE_BALL_DETECT = 4,
};

enum LaneEventCode : uint8_t { LANE_CLEAR = 0, LANE_FOUL = 1 };
enum BeamEventCode : uint8_t { BEAM_CLEAR = 0, BEAM_BROKEN = 1 };

// 0/1 are the speed node's paired beams; 2 is the ball detection node's
// single near-pins beam, deliberately distinct so the Pi doesn't feed it
// into speed pairing -- see PROTOCOL.md's MSG_BEAM_EVENT section.
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

#define MAX_MACHINES_PER_MSG 4

struct NodeMessage {
  uint8_t msgType;
  uint8_t seq;
  uint8_t code;
  uint8_t laneNumber;
  uint32_t timestampMs;
  uint8_t data[64];
};   // sizeof = 72 bytes, fixed, no padding (see PROTOCOL.md)

// ============================================================
// Pi UART payload shapes -- UNCHANGED from before the ESP-NOW protocol
// unification. These are NOT sent over ESP-NOW, only over the UART link to
// the Pi, so state_machine/protocol.py needs no changes. This gateway translates
// the unified NodeMessage into these on the way to the Pi.
// ============================================================

struct UartLaneEventPayload {   // matches state_machine/protocol.py's LANE_EVENT_FMT
  uint8_t eventType;            // 0 = CLEAR, 1 = FOUL
  uint8_t laneNumber;
  uint32_t timestampMs;
};

struct UartBeamEventPayload {   // matches state_machine/protocol.py's BEAM_EVENT_FMT
  uint8_t eventType;            // 3 = BEAM_CLEAR, 4 = BEAM_BROKEN
  uint8_t laneNumber;
  uint8_t beamRole;
  uint32_t timestampMs;
};

struct UartPinsetterStatusPayload {   // matches state_machine/protocol.py's STATUS_EVENT_FMT
  uint8_t statusCode;                 // StatusCode, see enum above
  uint8_t laneNumber;                 // 0 for node-level status codes, see PROTOCOL.md
  uint8_t ballNumber;                 // pinsetter's own reported ball (1 or 2) for laneNumber; 0 if unknown/not applicable -- see ballNumberForLane()
  uint32_t timestampMs;
};

struct PinsetterCommandFromPi { // Pi -> gateway, any CommandCode (cycle, rerack, ...)
  uint8_t command;
  uint8_t laneNumber;
  uint8_t cycleCount;   // CMD_CYCLE/CMD_RERACK only: exact solenoid pulse count the Pi wants run, computed from its own tracked/reported ball state -- the pinsetter no longer derives this itself (see pinsetter_node.ino's execPinsetterCommand). Ignored by other CommandCodes.
};

struct ScoreEventFromPi {       // Pi -> gateway, then broadcast onto ESP-NOW as MSG_SCORE_EVENT
  uint8_t laneNumber;
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

// RS485 frame: [0xAA START][LEN][PAYLOAD = raw NodeMessage bytes][CHECKSUM].
// No message-type wrapper byte -- NodeMessage's own msgType is already the
// first payload byte, since the whole struct is framed directly.
#define RS485_FRAME_START 0xAA
#define RS485_FRAME_SIZE (sizeof(NodeMessage) + 3)   // 1 start + 1 len + payload + 1 checksum
uint8_t rs485Queue[RS485_MAX_QUEUE][RS485_FRAME_SIZE];
uint8_t rs485QueueLen[RS485_MAX_QUEUE];
int rs485QueueHead = 0, rs485QueueTail = 0, rs485QueueCount = 0;
unsigned long lastRS485Activity = 0;
unsigned long rs485NextAttempt = 0;

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
void sendPinsetterCommand(CommandCode command, uint8_t laneNumber, uint8_t cycleCount = 1) {
  if (!PINSETTER_ENABLED) return;

  NodeMessage msg = {};
  msg.msgType = MSG_COMMAND;
  msg.seq = nextSeq++;
  msg.code = command;
  msg.laneNumber = laneNumber;
  msg.timestampMs = millis();
  msg.data[0] = cycleCount;

  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] SEND pinsetter MSG_COMMAND { code=");
  switch (command) {
    case CMD_CYCLE:     Serial.print("CYCLE"); break;
    case CMD_POWER_ON:  Serial.print("POWER_ON"); break;
    case CMD_POWER_OFF: Serial.print("POWER_OFF"); break;
    case CMD_RERACK:    Serial.print("RERACK"); break;
    case CMD_RESPOT:    Serial.print("RESPOT"); break;
    case CMD_STATUS:    Serial.print("STATUS"); break;
    default:            Serial.print("UNKNOWN"); break;
  }
  Serial.print(", lane=");
  Serial.print(laneNumber);
  if (command == CMD_CYCLE || command == CMD_RERACK) {
    Serial.print(", cycles=");
    Serial.print(cycleCount);
  }
  Serial.println(" }");

  if (pinsetterRegistered) {
    esp_now_send(pinsetterMac, (uint8_t *)&msg, sizeof(msg));
  }
  rs485Enqueue(msg);   // no-op if RS485_ENABLED is false

  if (!pinsetterRegistered && !RS485_ENABLED) {
    Serial.println("No transport available for pinsetter command (not ESP-NOW registered, RS485 disabled)");
  }
}

void sendStatusAck(uint8_t seq) {
  NodeMessage ack = {};
  ack.msgType = MSG_ACK;
  ack.seq = seq;
  ack.code = MSG_STATUS;
  ack.timestampMs = millis();

  if (pinsetterRegistered) {
    esp_now_send(pinsetterMac, (uint8_t *)&ack, sizeof(ack));
  }
  rs485Enqueue(ack);
}

// ---- RS485 (wired fallback to insulate against ESP-NOW failures) ----
// Same framing pattern as the Pi UART link (below), but carries the raw
// NodeMessage struct directly -- no message-type wrapper byte needed since
// msgType is already NodeMessage's first field. Point-to-point (this gateway
// <-> its own pinsetter), no addressing. Idle-detection + jitter before
// transmitting since RS485 is typically half-duplex. See PROTOCOL.md.

uint8_t rs485Checksum(uint8_t len, const uint8_t *payload) {
  uint8_t sum = len;
  for (uint8_t i = 0; i < len; i++) sum ^= payload[i];
  return sum;
}

void rs485Enqueue(const NodeMessage &msg) {
  if (!RS485_ENABLED) return;
  if (rs485QueueCount >= RS485_MAX_QUEUE) {
    rs485QueueHead = (rs485QueueHead + 1) % RS485_MAX_QUEUE;
    rs485QueueCount--;
  }
  uint8_t *frame = rs485Queue[rs485QueueTail];
  frame[0] = RS485_FRAME_START;
  frame[1] = sizeof(NodeMessage);
  memcpy(frame + 2, &msg, sizeof(NodeMessage));
  frame[2 + sizeof(NodeMessage)] = rs485Checksum(sizeof(NodeMessage), frame + 2);
  rs485QueueLen[rs485QueueTail] = RS485_FRAME_SIZE;

  rs485QueueTail = (rs485QueueTail + 1) % RS485_MAX_QUEUE;
  rs485QueueCount++;
}

void processRS485Queue() {
  if (rs485QueueCount == 0) return;
  unsigned long now = millis();
  bool idle = (now - lastRS485Activity) > RS485_IDLE_MS;
  if (idle && now >= rs485NextAttempt) {
    RS485.write(rs485Queue[rs485QueueHead], rs485QueueLen[rs485QueueHead]);
    lastRS485Activity = now;
    rs485QueueHead = (rs485QueueHead + 1) % RS485_MAX_QUEUE;
    rs485QueueCount--;
  } else if (!idle) {
    rs485NextAttempt = now + RS485_IDLE_MS + random(0, RS485_JITTER_MAX_MS);
  }
}

const char *beamRoleName(uint8_t role) {
  switch (role) {
    case ROLE_UPSTREAM:    return "upstream";
    case ROLE_DOWNSTREAM:  return "downstream";
    case ROLE_BALL_DETECT: return "ball_detect";
    default:               return "UNKNOWN";
  }
}

// Handles every msgType that can arrive on EITHER transport -- MSG_REGISTER
// is the one exception (ESP-NOW only, needs a MAC to add as a peer; see
// onDataRecv). Called from onDataRecv (ESP-NOW) and pollRS485 (RS485) alike,
// so a fouling/speed/pinsetter node's message is handled identically no
// matter which wire it came in on. "Messages between nodes stay uniform,
// regardless of transport."
void handleIncomingNodeMessage(const NodeMessage &msg, const String &via) {
  switch (msg.msgType) {
    case MSG_LANE_EVENT: {
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV via ");
      Serial.print(via);
      Serial.print(" MSG_LANE_EVENT { code=");
      Serial.print(msg.code == LANE_FOUL ? "FOUL" : "CLEAR");
      Serial.print(", laneNumber=");
      Serial.print(msg.laneNumber);
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
      Serial.print(" MSG_BEAM_EVENT { lane=");
      Serial.print(msg.laneNumber);
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
      Serial.println(msg.msgType);
      break;
  }
}

void pollRS485() {
  static uint8_t buf[sizeof(NodeMessage)];
  static uint8_t bufLen = 0;
  static uint8_t expectedLen = 0;
  static bool haveLen = false;
  static bool sawStart = false;

  while (RS485.available()) {
    lastRS485Activity = millis();
    uint8_t b = RS485.read();

    if (!sawStart) {
      if (b == RS485_FRAME_START) { sawStart = true; haveLen = false; bufLen = 0; }
      continue;
    }
    if (!haveLen) {
      expectedLen = b;
      haveLen = true;
      bufLen = 0;
      if (expectedLen != sizeof(NodeMessage)) { sawStart = false; }
      continue;
    }
    if (bufLen < expectedLen) {
      buf[bufLen++] = b;
      continue;
    }

    if (b == rs485Checksum(expectedLen, buf)) {
      NodeMessage msg;
      memcpy(&msg, buf, sizeof(msg));
      handleIncomingNodeMessage(msg, "RS485");
    } else {
      Serial.println("RS485 checksum mismatch, dropping frame");
    }
    sawStart = false;
  }
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
  p.eventType = (msg.code == LANE_FOUL) ? 1 : 0;   // state_machine/protocol.py EVENT_FOUL/EVENT_CLEAR
  p.laneNumber = msg.laneNumber;
  p.timestampMs = msg.timestampMs;
  sendToPi(UART_LANE_EVENT, (const uint8_t *)&p, sizeof(p));
}

void forwardBeamEventToPi(const NodeMessage &msg) {
  UartBeamEventPayload p;
  p.eventType = (msg.code == BEAM_BROKEN) ? 4 : 3;  // state_machine/protocol.py EVENT_BEAM_BROKEN/EVENT_BEAM_CLEAR
  p.laneNumber = msg.laneNumber;
  p.beamRole = msg.data[0];
  p.timestampMs = msg.timestampMs;
  sendToPi(UART_BEAM_EVENT, (const uint8_t *)&p, sizeof(p));
}

// Every MSG_STATUS carries every machine's MachineRecord (data[2..17], 4
// bytes each: laneNumber, flags, cooldownLo, cooldownHi -- see
// pinsetter_node.ino's sendStatusEvent()), regardless of which one
// triggered the message, so this always has fresh data no matter which
// statusCode fired. flags bit 0x04 is the pinsetter's own ball counter (set
// = ball 2). Returns 0 (the wire's "unknown/not applicable" sentinel, see
// protocol.py's StatusEvent) if laneNumber has no record here -- a
// node-level status (laneNumber=0) or a lane this pinsetter doesn't own.
uint8_t ballNumberForLane(const NodeMessage &msg, uint8_t laneNumber) {
  // 0 is never a real lane -- it's the node-level sentinel -- and it's ALSO
  // what an unused MachineRecord slot's laneNumber reads as (zero-filled),
  // so without this guard a node-level status would spuriously "match" the
  // first empty slot instead of correctly finding nothing.
  if (laneNumber == 0) return 0;
  for (int i = 0; i < MAX_MACHINES_PER_MSG; i++) {
    int off = 2 + i * 4;
    if (msg.data[off] == laneNumber) {
      return (msg.data[off + 1] & 0x04) ? 2 : 1;
    }
  }
  return 0;
}

void forwardStatusToPi(const NodeMessage &msg) {
  UartPinsetterStatusPayload p;
  p.statusCode = msg.code;
  p.laneNumber = msg.laneNumber;
  p.ballNumber = ballNumberForLane(msg, msg.laneNumber);
  p.timestampMs = msg.timestampMs;
  sendToPi(UART_PINSETTER_STATUS, (const uint8_t *)&p, sizeof(p));
}

void broadcastScoreEvent(uint8_t laneNumber, uint8_t ballNumber, uint16_t pinfallMask, uint32_t timestampMs) {
  NodeMessage msg = {};
  msg.msgType = MSG_SCORE_EVENT;
  msg.seq = nextSeq++;
  msg.code = ballNumber;
  msg.laneNumber = laneNumber;
  msg.timestampMs = timestampMs;
  msg.data[0] = (uint8_t)(pinfallMask & 0xFF);
  msg.data[1] = (uint8_t)(pinfallMask >> 8);

  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] BROADCAST MSG_SCORE_EVENT { lane=");
  Serial.print(laneNumber);
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
  rs485Enqueue(msg);
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
      Serial.print(req.command);
      Serial.print(", lane=");
      Serial.print(req.laneNumber);
      Serial.print(", cycles=");
      Serial.print(req.cycleCount);
      Serial.println(" }");
      sendPinsetterCommand((CommandCode)req.command, req.laneNumber, req.cycleCount);
      break;
    }
    case UART_SCORE_EVENT: {
      if (len != sizeof(ScoreEventFromPi)) return;
      ScoreEventFromPi ev;
      memcpy(&ev, payload, sizeof(ev));
      broadcastScoreEvent(ev.laneNumber, ev.ballNumber, ev.pinfallMask, ev.timestampMs);
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
const char *statusCodeName(uint8_t code) {
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

void logMachineRecords(const uint8_t *data) {
  for (int i = 0; i < MAX_MACHINES_PER_MSG; i++) {
    int off = 2 + i * 4;
    uint8_t lane = data[off];
    if (lane == 0) continue;   // unused slot
    uint8_t flags = data[off + 1];
    uint16_t cooldownMs = data[off + 2] | (data[off + 3] << 8);
    Serial.print("    lane "); Serial.print(lane);
    Serial.print(" on="); Serial.print((flags & 0x01) ? 1 : 0);
    Serial.print(" cycling="); Serial.print((flags & 0x02) ? 1 : 0);
    Serial.print(" ball="); Serial.print((flags & 0x04) ? 2 : 1);
    Serial.print(" pendingCycles="); Serial.print((flags >> 3) & 0x03);
    Serial.print(" cooldownMs="); Serial.println(cooldownMs);
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
  // shared handler. Everything else goes through handleIncomingNodeMessage,
  // shared with pollRS485, so behavior is identical regardless of transport.
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
    Serial.print(msg.code);
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
  Serial.println("------------------------");
}

void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd == "status") {
    printStatus();
  } else if (cmd == "pstatus") {
    sendPinsetterCommand(CMD_STATUS, 0);
  } else if (cmd.startsWith("cycle ")) {
    sendPinsetterCommand(CMD_CYCLE, cmd.substring(6).toInt(), 1);
  } else if (cmd.startsWith("rerack ")) {
    // No Pi-tracked ball state available from the bench console -- 2 is the
    // safe default (sweep + spot fresh works regardless of the machine's
    // actual current position; see state_machine.py's rerack cycle-count
    // logic for the real Pi-driven decision).
    sendPinsetterCommand(CMD_RERACK, cmd.substring(7).toInt(), 2);
  } else if (cmd.startsWith("respot ")) {
    sendPinsetterCommand(CMD_RESPOT, cmd.substring(7).toInt());
  } else if (cmd.startsWith("power ")) {
    String rest = cmd.substring(6);
    int sp = rest.indexOf(' ');
    if (sp == -1) {
      Serial.println("usage: power <lane> on|off");
      return;
    }
    uint8_t lane = rest.substring(0, sp).toInt();
    String action = rest.substring(sp + 1);
    action.trim();
    if (action == "on")       sendPinsetterCommand(CMD_POWER_ON, lane);
    else if (action == "off") sendPinsetterCommand(CMD_POWER_OFF, lane);
    else Serial.println("usage: power <lane> on|off");
  } else {
    Serial.println("commands: cycle <lane> | rerack <lane> | respot <lane> | power <lane> on|off | pstatus | status");
  }
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

  if (RS485_ENABLED) {
    RS485.begin(RS485_BAUD, SERIAL_8N1, RS485_RX_PIN, RS485_TX_PIN);
    randomSeed(esp_random());
    Serial.println("RS485 fallback link up");
  }

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
  Serial.println("commands: cycle <lane> | power <lane> on|off | status");
}

void loop() {
#if !PILINK_OVER_USB_BENCH_TEST
  // Only a genuinely separate stream from PiLink in real deployment (UART2
  // vs Serial/UART0) -- in bench-test mode pollPiLink() itself handles
  // bench-console text too, see its comment above.
  pollSerial();
#endif
  pollPiLink();
  pollRS485();
  processRS485Queue();
}
