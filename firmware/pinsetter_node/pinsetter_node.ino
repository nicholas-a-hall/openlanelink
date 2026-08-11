// ============================================================
// openlanelink -- PINSETTER INTERFACE NODE
// Waveshare ESP32-S3-(POE-)ETH-8DI-8RO
//
// Controls up to two Brunswick A2 pinsetters (one lane pair). Each machine
// uses TWO relays: a pulse-only CYCLE relay (fires the cycle solenoid) and a
// latching POWER relay (machine mains). 2 machines = 4 relays; the 8RO board
// covers two lane pairs (4 relays).
//
// THIS NODE owns the machine config (MACHINES[] below) and per-machine state.
// The gateway sends pure semantic MSG_COMMAND{code=CommandCode, laneNumber}:
//   CMD_CYCLE     -- fire the cycle solenoid once, regardless of ball
//   CMD_RERACK    -- cycle through to a fresh full rack: on 2nd ball one cycle,
//                    on 1st ball two cycles (sequenced a machine-cycle apart).
//                    The gateway sends this on foul events.
//   CMD_RESPOT    -- STUB, not implemented: stop at 180 waiting for pins on 2nd
//                    ball; needs manual intervention. Logged + acked only.
//   CMD_POWER_ON / CMD_POWER_OFF -- latch the machine's power relay
//   CMD_STATUS    -- report per-machine {ball, on, cycling, cooldown} via MSG_STATUS
//
// Ball tracking (1st/2nd) is a FIRMWARE COUNTER: each completed machine
// cycle toggles it. It desyncs if someone cycles the machine from its local
// button. FUTURE: the user has a separate optocoupler board to integrate --
// land its ball-state/cycle-complete signal on a DI and sync ballstate in
// processMachines() instead of blind-toggling.
//
// Derived from the tested Waveshare relay firmware. Relay driver details
// (TCA9554 @ 0x20, SDA=42/SCL=41, config reg 0x03, output reg 0x01, readback
// reg 0x00) are CONFIRMED WORKING and carried over unchanged.
//
// TWO TRANSPORTS, ONE MESSAGE FORMAT: this node talks to the gateway over
// ESP-NOW *and* RS485 (a wired fallback specifically to insulate the link
// against ESP-NOW radio failures). Both carry the exact same NodeMessage
// struct -- there is no separate RS485 protocol, no JSON, no text grammar.
// MSG_COMMAND/MSG_STATUS/MSG_ACK are sent on BOTH transports, always,
// unconditionally (always-on redundancy, not failure-detect-then-failover).
// A single ack/retry table is satisfied by an ack arriving on EITHER
// transport. MSG_REGISTER stays ESP-NOW-only -- RS485 is a hardwired
// point-to-point link with no discovery concept, so there's nothing to
// register. See firmware/PROTOCOL.md for the canonical reference.
// ============================================================

#include <Wire.h>

// --- Relay driver (confirmed: TCA9554 @ 0x20, SDA=42, SCL=41) ---
#define SDA_PIN 42
#define SCL_PIN 41
#define RELAY_ADDR    0x20
#define RELAY_CONFIG  0x03
#define RELAY_OUTPUT  0x01
#define RELAY_INPUT_REG 0x00   // readback register, confirms actual driven state
#define RELAY_WRITE_RETRIES 3

// ---- Machine (Brunswick A2) config -- THIS node owns the mapping ----
// TODO(HANDOFF.md "Next" item 9): this compile-time mapping (and whatever
// DI/optocoupler-to-lane mapping eventually joins it) should move to the
// software (Pi) side so reassigning a relay/DI channel to a lane is a
// config change, not a firmware edit+reflash. Not yet designed -- see that
// item for why this isn't a trivial move (it changes who owns lane->channel
// resolution, not just where the array lives).
struct MachineConfig {
  uint8_t laneNumber;
  uint8_t cycleRelay;   // pulse-only: fires the cycle solenoid
  uint8_t powerRelay;   // latching: machine mains power
};

const MachineConfig MACHINES[] = {
  {7, 1, 2},
  {8, 3, 4},
  // {9,  5, 6},   // second lane pair, when wired
  // {10, 7, 8},
};
const int MACHINE_COUNT = sizeof(MACHINES) / sizeof(MACHINES[0]);

// How long to energize the cycle solenoid per cycle command.
#define SOLENOID_PULSE_MS 500

// Full A2 machine cycle time: sweep, spot/respot, table return. The machine
// is "cycling" (busy, in cooldown) for this window after each solenoid pulse;
// the second re-rack cycle is sequenced after it. TUNE ON REAL HARDWARE.
#define A2_CYCLE_TIME_MS 8000

// Built in setup() from MACHINES[].cycleRelay -- channels that must NEVER be
// latched ON (a held cycle solenoid can jam or damage the machine).
uint8_t pulseOnlyMask = 0;

// --- Digital input expander (UNVERIFIED -- confirm addr with I2C scanner) ---
#define DI_ADDR       0x24   // placeholder, verify
#define DI_CONFIG     0x03
#define DI_INPUT_REG  0x00

// --- RS485 (UNVERIFIED -- confirm TX/RX against silkscreen). Wired fallback
// to the gateway -- see PROTOCOL.md. Baud MUST match the gateway's. ---
#define RS485_ENABLED 1
#define RS485_TX_PIN  17     // placeholder, verify
#define RS485_RX_PIN  18     // placeholder, verify
#define RS485_BAUD    9600
#define RS485_IDLE_MS       15
#define RS485_JITTER_MAX_MS 20
#define RS485_MAX_QUEUE     8

// --- Ethernet (confirmed) ---
#define ETH_ENABLED 1
#if ETH_ENABLED
  #define ETH_SPI_SCK  15
  #define ETH_SPI_MISO 14
  #define ETH_SPI_MOSI 13
  #define ETH_PHY_CS   16
  #define ETH_PHY_IRQ  12
  #define ETH_PHY_RST  -1
#endif

// --- WiFi (fallback only; Ethernet is preferred) ---
const char* ssid = "";
const char* password = "";

// --- OTA ---
const char* otaPassword = "";  // set a real one

// --- Node identity / gateway ---
#define NODE_ID "pinsetter-01"
uint8_t gatewayMac[] = {0x68, 0x25, 0xDD, 0x32, 0x64, 0x7C};

// ESP-NOW channel. IMPORTANT: ESP-NOW peers must share a radio channel.
// The gateway is not joined to an AP, so it sits on this channel. When this
// node runs on ETHERNET the radio is free and we pin it here to match.
// If this node falls back to WIFI, the radio is forced to the AP's channel --
// if that isn't ESPNOW_CHANNEL, ESP-NOW to the gateway WILL silently fail.
// Either put the AP on this channel, or keep this node on Ethernet.
#define ESPNOW_CHANNEL 1

#define HEARTBEAT_INTERVAL_MS 5000
#define REGISTER_RETRY_MS     10000

// WiFi fallback is best-effort and time-boxed. ESP-NOW is this node's core
// job and must come up even with no network at all -- never block on WiFi.
#define WIFI_CONNECT_TIMEOUT_MS 15000

// --- Ack / retry. Tracks MSG_STATUS across BOTH transports -- an ack
// arriving via either ESP-NOW or RS485 satisfies the same pending entry. ---
#define ACK_TIMEOUT_MS   300
#define ACK_MAX_RETRIES  3
#define PENDING_MAX      8

// ============================================================
// Wire protocol -- see firmware/PROTOCOL.md. MUST match every other node.
// ============================================================

enum MsgType : uint8_t {
  MSG_REGISTER = 0, MSG_LANE_EVENT = 1, MSG_BEAM_EVENT = 2,
  MSG_COMMAND = 3, MSG_STATUS = 4, MSG_SCORE_EVENT = 5, MSG_ACK = 6,
};

enum NodeType : uint8_t {
  NODE_FOULING = 0, NODE_PINSETTER = 1, NODE_SCORING = 2, NODE_SPEED = 3,
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

// RS485 frame: [0xAA START][LEN][PAYLOAD = raw NodeMessage bytes][CHECKSUM].
// No message-type wrapper byte -- msgType is already NodeMessage's first field.
#define RS485_FRAME_START 0xAA
#define RS485_FRAME_SIZE (sizeof(NodeMessage) + 3)   // 1 start + 1 len + payload + 1 checksum

// ---- Per-machine state (parallel to MACHINES[]) ----
struct MachineState {
  uint8_t ball;              // 1 or 2 -- firmware counter; reported to the Pi
                              // every MSG_STATUS (see sendStatusEvent()'s
                              // MachineRecord flags) as ground truth for the
                              // Pi's own rerack cycle-count decision (see
                              // state_machine.py) -- this node no longer
                              // consults it locally for that (see
                              // execRerack()). Still just a blind toggle,
                              // still desyncs if the machine is cycled from
                              // its local button; optocoupler sync later.
  uint8_t pendingCycles;     // cycles queued (re-rack sequencing)
  bool cycleInProgress;      // machine mid-cycle (busy/cooldown window)
  unsigned long busyUntil;   // millis when the current cycle window ends
};
MachineState machineState[8];  // sized generously; only MACHINE_COUNT used

// ============================================================

#if ETH_ENABLED
  #include <ETH.h>
#endif
#include <WiFi.h>
#include <esp_wifi.h>
#include <ArduinoOTA.h>
#include <esp_now.h>
#include <HardwareSerial.h>

#if ETH_ENABLED
SPIClass ethSPI(HSPI);
bool ethConnected = false;
#endif

HardwareSerial RS485(1);

uint8_t relayState = 0x00;
unsigned long pulseEndTime[8] = {0};
uint8_t diState = 0x00;

// The gateway dual-sends every MSG_COMMAND on both ESP-NOW and RS485,
// unconditionally, so it can survive either transport failing (see
// PROTOCOL.md's "Dual-send" section) -- both copies carry the SAME seq.
// When both transports are actually up, this node would otherwise execute
// the same command twice (e.g. a double pinsetter cycle per foul). Track
// the last-processed command seq and skip an immediate repeat.
uint8_t lastCommandSeq = 0;
bool haveLastCommandSeq = false;

unsigned long lastHeartbeat = 0;
unsigned long lastRegisterAttempt = 0;
uint8_t lastSentDiState = 0xFF;

// ---- RS485 outbound queue (collision avoidance -- half-duplex bus) ----
uint8_t rs485Queue[RS485_MAX_QUEUE][RS485_FRAME_SIZE];
uint8_t rs485QueueLen[RS485_MAX_QUEUE];
int rs485QueueHead = 0, rs485QueueTail = 0, rs485QueueCount = 0;
unsigned long lastRS485Activity = 0;
unsigned long rs485NextAttempt = 0;

// ---- Ack/retry tracking (shared across both transports) ----
struct PendingMsg {
  uint8_t seq;
  NodeMessage msg;        // resent verbatim (binary, both transports) on retry
  unsigned long lastSentTime;
  uint8_t retries;
  bool active;
};
PendingMsg pending[PENDING_MAX];
uint8_t nextSeq = 0;

// ---- Relay I2C (confirmed working -- do not change) ----
void relayWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(RELAY_ADDR);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

uint8_t relayReadback() {
  Wire.beginTransmission(RELAY_ADDR);
  Wire.write(RELAY_INPUT_REG);
  Wire.endTransmission();
  Wire.requestFrom((int)RELAY_ADDR, 1);
  if (Wire.available()) return Wire.read();
  return 0xFF; // read failure sentinel
}

// ---- StatusCode -> human-readable name, for Serial logging only ----
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

// ---- RS485 (wired fallback) -- same framing as gateway_node.ino ----
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

bool isPoweredOn(int mi) {
  return (relayState >> (MACHINES[mi].powerRelay - 1)) & 0x01;
}

// ---- MSG_STATUS -- dual-sent on ESP-NOW + RS485, ack/retry-tracked ----
uint8_t laneForRelayChannel(int ch) {
  for (int i = 0; i < MACHINE_COUNT; i++) {
    if (MACHINES[i].cycleRelay == ch || MACHINES[i].powerRelay == ch) {
      return MACHINES[i].laneNumber;
    }
  }
  return 0;
}

void sendStatusEvent(StatusCode code, uint8_t laneNumber) {
  uint8_t seq = nextSeq++;

  NodeMessage msg = {};
  msg.msgType = MSG_STATUS;
  msg.seq = seq;
  msg.code = code;
  msg.laneNumber = laneNumber;
  msg.timestampMs = millis();
  msg.data[0] = relayState;
  msg.data[1] = diState;

  unsigned long now = millis();
  int n = 0;
  for (int i = 0; i < MACHINE_COUNT && n < MAX_MACHINES_PER_MSG; i++, n++) {
    MachineState &m = machineState[i];
    uint16_t cooldownMs = (m.cycleInProgress && m.busyUntil > now)
                              ? (uint16_t)(m.busyUntil - now) : 0;
    uint8_t flags = 0;
    if (isPoweredOn(i))    flags |= 0x01;
    if (m.cycleInProgress) flags |= 0x02;
    if (m.ball == 2)       flags |= 0x04;
    flags |= (uint8_t)((m.pendingCycles & 0x03) << 3);

    int off = 2 + n * 4;
    msg.data[off + 0] = MACHINES[i].laneNumber;
    msg.data[off + 1] = flags;
    msg.data[off + 2] = (uint8_t)(cooldownMs & 0xFF);
    msg.data[off + 3] = (uint8_t)(cooldownMs >> 8);
  }

  int slot = -1;
  for (int i = 0; i < PENDING_MAX; i++) {
    if (!pending[i].active) { slot = i; break; }
  }
  if (slot == -1) slot = 0; // overwrite oldest as last resort

  pending[slot] = { seq, msg, millis(), 0, true };

  esp_now_send(gatewayMac, (uint8_t *)&msg, sizeof(msg));
  rs485Enqueue(msg);
}

void processRetries() {
  unsigned long now = millis();
  for (int i = 0; i < PENDING_MAX; i++) {
    if (!pending[i].active) continue;
    unsigned long backoff = ACK_TIMEOUT_MS * (1UL << pending[i].retries);
    if (now - pending[i].lastSentTime > backoff) {
      if (pending[i].retries >= ACK_MAX_RETRIES) {
        Serial.print("Giving up on seq "); Serial.println(pending[i].seq);
        pending[i].active = false;
        continue;
      }
      pending[i].retries++;
      pending[i].lastSentTime = now;
      esp_now_send(gatewayMac, (uint8_t *)&pending[i].msg, sizeof(pending[i].msg));
      rs485Enqueue(pending[i].msg);
    }
  }
}

void handleIncomingAck(uint8_t seq) {
  for (int i = 0; i < PENDING_MAX; i++) {
    if (pending[i].active && pending[i].seq == seq) {
      pending[i].active = false;
      return;
    }
  }
}

// ---- DI I2C ----
uint8_t diRead() {
  Wire.beginTransmission(DI_ADDR);
  Wire.write(DI_INPUT_REG);
  Wire.endTransmission();
  Wire.requestFrom((int)DI_ADDR, 1);
  if (Wire.available()) return Wire.read();
  return 0xFF;
}

// ---- Registration with the gateway -- ESP-NOW only, see header comment ----
void sendRegister() {
  NodeMessage msg = {};
  msg.msgType = MSG_REGISTER;
  msg.code = NODE_PINSETTER;
  msg.laneNumber = 0;
  msg.timestampMs = millis();
  esp_now_send(gatewayMac, (uint8_t *)&msg, sizeof(msg));
  Serial.println("Sent REGISTER to gateway");
}

bool applyState() {
  for (int attempt = 0; attempt < RELAY_WRITE_RETRIES; attempt++) {
    relayWrite(RELAY_OUTPUT, relayState);
    delay(2);
    uint8_t actual = relayReadback();
    if (actual == relayState) {
      return true;
    }
    Serial.print("Relay write mismatch, attempt ");
    Serial.println(attempt + 1);
  }
  Serial.println("Relay write FAILED after retries -- hardware fault");
  sendStatusEvent(STATUS_RELAY_FAULT, 0);
  return false;
}

// ---- Relay command execution ----
bool isPulseOnly(int ch) {
  return (pulseOnlyMask >> (ch - 1)) & 0x01;
}

void execToggle(int ch, bool on) {
  if (ch < 1 || ch > 8) return;

  // Safety: never latch a pulse-only cycle solenoid ON.
  if (on && isPulseOnly(ch)) {
    Serial.print("REFUSED: ch ");
    Serial.print(ch);
    Serial.println(" is pulse-only (cycle solenoid), cannot be latched on");
    sendStatusEvent(STATUS_REFUSED_PULSE_ONLY, laneForRelayChannel(ch));
    return;
  }

  uint8_t prevState = relayState;
  pulseEndTime[ch - 1] = 0;
  if (on) relayState |= (1 << (ch - 1));
  else    relayState &= ~(1 << (ch - 1));

  if (applyState()) {
    sendStatusEvent(STATUS_RELAY_ACK, laneForRelayChannel(ch));
  } else {
    relayState = prevState;
    pulseEndTime[ch - 1] = 0;
  }
}

void execPulse(int ch, unsigned long ms) {
  if (ch < 1 || ch > 8 || ms == 0) return;
  uint8_t prevState = relayState;
  relayState |= (1 << (ch - 1));

  if (applyState()) {
    pulseEndTime[ch - 1] = millis() + ms;
    sendStatusEvent(STATUS_PULSE_ACK, laneForRelayChannel(ch));
  } else {
    relayState = prevState;
  }
}

void execAll(bool on) {
  uint8_t prevState = relayState;
  unsigned long prevPulses[8];
  memcpy(prevPulses, pulseEndTime, sizeof(prevPulses));

  for (int i = 0; i < 8; i++) pulseEndTime[i] = 0;
  // Safety: "all on" must not energize pulse-only cycle solenoids.
  relayState = on ? (uint8_t)(0xFF & ~pulseOnlyMask) : 0x00;

  if (applyState()) {
    sendStatusEvent(STATUS_ALL_ACK, 0);
  } else {
    relayState = prevState;
    memcpy(pulseEndTime, prevPulses, sizeof(pulseEndTime));
  }
}

void checkPulses() {
  unsigned long now = millis();
  for (int i = 0; i < 8; i++) {
    if (pulseEndTime[i] != 0 && now >= pulseEndTime[i]) {
      uint8_t prevState = relayState;
      relayState &= ~(1 << i);

      if (applyState()) {
        pulseEndTime[i] = 0;
        sendStatusEvent(STATUS_PULSE_COMPLETE, laneForRelayChannel(i + 1));
      } else {
        relayState = prevState; // retry next loop pass
      }
    }
  }
}

// ---- A2 machine sequencing ----
int machineIndexForLane(uint8_t laneNumber) {
  for (int i = 0; i < MACHINE_COUNT; i++) {
    if (MACHINES[i].laneNumber == laneNumber) return i;
  }
  return -1;
}

// Queue n solenoid cycles for a machine; processMachines() fires them one
// machine-cycle apart. Capped so a command flurry can't wind up the queue.
void requestCycles(int mi, uint8_t n) {
  MachineState &m = machineState[mi];
  uint8_t total = m.pendingCycles + n;
  if (total > 3) total = 3;
  m.pendingCycles = total;
}

// Re-rack: runs exactly cycleCount solenoid pulses, as decided by the Pi
// (see state_machine.py's rerack cycle-count logic) -- typically 1 if the
// pinsetter last reported ball 2, 2 if ball 1 ("sweep the standing rack,
// then spot fresh"), using this node's OWN reported ball state as ground
// truth rather than this node re-deciding it locally from a counter that
// can desync (see MachineState.ball's comment). Falls back to 2 (the safe,
// always-gets-to-fresh option) if the Pi/gateway sent 0. Ignored if the
// machine is already mid-cycle/queued, same as before.
void execRerack(int mi, uint8_t cycleCount) {
  MachineState &m = machineState[mi];
  if (m.cycleInProgress || m.pendingCycles > 0) {
    Serial.print("Re-rack ignored, lane ");
    Serial.print(MACHINES[mi].laneNumber);
    Serial.println(" is already cycling/queued");
    return;
  }
  requestCycles(mi, cycleCount > 0 ? cycleCount : 2);
}

// Runs from loop(): starts queued cycles when a machine is idle, and marks
// cycles complete (ball toggles) when the busy window expires.
// FUTURE (optocoupler board): replace the blind ball toggle + fixed
// A2_CYCLE_TIME_MS window with the real ball-state / cycle-complete signal.
void processMachines() {
  unsigned long now = millis();
  for (int i = 0; i < MACHINE_COUNT; i++) {
    MachineState &m = machineState[i];

    if (m.cycleInProgress && now >= m.busyUntil) {
      m.cycleInProgress = false;
      m.ball = (m.ball == 1) ? 2 : 1;  // 2nd-ball cycle spots a fresh rack
      sendStatusEvent(STATUS_CYCLE_COMPLETE, MACHINES[i].laneNumber);
    }

    if (!m.cycleInProgress && m.pendingCycles > 0) {
      m.pendingCycles--;
      m.cycleInProgress = true;
      m.busyUntil = now + A2_CYCLE_TIME_MS;
      execPulse(MACHINES[i].cycleRelay, SOLENOID_PULSE_MS);
    }
  }
}

// ---- Command from the gateway ----
void execPinsetterCommand(const NodeMessage &msg) {
  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] RECV MSG_COMMAND { code=");
  switch (msg.code) {
    case CMD_CYCLE:     Serial.print("CYCLE"); break;
    case CMD_POWER_ON:  Serial.print("POWER_ON"); break;
    case CMD_POWER_OFF: Serial.print("POWER_OFF"); break;
    case CMD_RERACK:    Serial.print("RERACK"); break;
    case CMD_RESPOT:    Serial.print("RESPOT"); break;
    case CMD_STATUS:    Serial.print("STATUS"); break;
    default:            Serial.print("UNKNOWN"); break;
  }
  Serial.print(", lane=");
  Serial.print(msg.laneNumber);
  Serial.println(" }");

  if (msg.code == CMD_STATUS) {
    sendStatusEvent(STATUS_MACHINE_STATUS, 0);
    return;
  }

  int mi = machineIndexForLane(msg.laneNumber);
  if (mi < 0) {
    Serial.print("No machine configured for lane ");
    Serial.println(msg.laneNumber);
    return;
  }

  switch (msg.code) {
    case CMD_CYCLE:
      requestCycles(mi, msg.data[0] > 0 ? msg.data[0] : 1);
      break;
    case CMD_RERACK:
      execRerack(mi, msg.data[0]);
      break;
    case CMD_RESPOT:
      // STUB: stop at 180 waiting for pins on 2nd ball, manual completion.
      Serial.println("RESPOT is a stub -- not implemented yet");
      sendStatusEvent(STATUS_RESPOT_STUB, MACHINES[mi].laneNumber);
      break;
    case CMD_POWER_ON:
      execToggle(MACHINES[mi].powerRelay, true);
      break;
    case CMD_POWER_OFF:
      execToggle(MACHINES[mi].powerRelay, false);
      break;
    default:
      Serial.println("Unknown command byte, ignoring");
      break;
  }
}

// ---- Unified message dispatch -- shared by BOTH transports ----
// "Messages between nodes stay uniform, regardless of transport." Whether a
// NodeMessage arrived over ESP-NOW or RS485, it's handled identically here.
void handleIncomingNodeMessage(const NodeMessage &msg, const char *via) {
  switch (msg.msgType) {
    case MSG_COMMAND:
      // Same seq as the last command we ran == the other transport's copy
      // of the message we already executed, not a new command -- see
      // lastCommandSeq's declaration above.
      if (haveLastCommandSeq && msg.seq == lastCommandSeq) {
        Serial.print("Duplicate MSG_COMMAND (seq=");
        Serial.print(msg.seq);
        Serial.print(") via ");
        Serial.print(via);
        Serial.println(", already executed via the other transport -- skipped");
        break;
      }
      lastCommandSeq = msg.seq;
      haveLastCommandSeq = true;
      execPinsetterCommand(msg);
      break;
    case MSG_ACK:
      if (msg.code == MSG_STATUS) handleIncomingAck(msg.seq);
      break;
    default:
      Serial.print("Unexpected msgType via ");
      Serial.print(via);
      Serial.print(": ");
      Serial.println(msg.msgType);
      break;
  }
}

// ---- RS485 poll (carrier-sense tracking + inbound framing) ----
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

// ---- ESP-NOW receive ----
// Every ESP-NOW payload from the gateway is exactly sizeof(NodeMessage).
void onEspNowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  if (len != sizeof(NodeMessage)) {
    Serial.print("Unexpected ESP-NOW payload length: ");
    Serial.println(len);
    return;
  }

  NodeMessage msg;
  memcpy(&msg, data, sizeof(msg));
  handleIncomingNodeMessage(msg, "ESP-NOW");
}

#if ETH_ENABLED
void onEthEvent(arduino_event_id_t event) {
  switch (event) {
    case ARDUINO_EVENT_ETH_GOT_IP:
      ethConnected = true;
      Serial.print("Ethernet IP: "); Serial.println(ETH.localIP());
      break;
    case ARDUINO_EVENT_ETH_DISCONNECTED:
      ethConnected = false;
      break;
    default: break;
  }
}
#endif

void setup() {
  Serial.begin(9600);
  Wire.begin(SDA_PIN, SCL_PIN);
  randomSeed(esp_random());

  Serial.println();
  Serial.println("Pinsetter interface node starting");

  // Build the pulse-only guard mask and init per-machine state.
  for (int i = 0; i < MACHINE_COUNT; i++) {
    pulseOnlyMask |= (1 << (MACHINES[i].cycleRelay - 1));
    machineState[i] = {1, 0, false, 0};  // assume 1st ball at boot
    Serial.print("Machine: lane ");
    Serial.print(MACHINES[i].laneNumber);
    Serial.print(" cycle=ch");
    Serial.print(MACHINES[i].cycleRelay);
    Serial.print(" power=ch");
    Serial.println(MACHINES[i].powerRelay);
  }

  // All relays outputs, all off. Cycle solenoids must boot de-energized.
  relayWrite(RELAY_CONFIG, 0x00);
  relayWrite(RELAY_OUTPUT, 0x00);

  Wire.beginTransmission(DI_ADDR);
  Wire.write(DI_CONFIG);
  Wire.write(0xFF); // all 8 pins input
  Wire.endTransmission();

  if (RS485_ENABLED) {
    RS485.begin(RS485_BAUD, SERIAL_8N1, RS485_RX_PIN, RS485_TX_PIN);
    Serial.println("RS485 fallback link up");
  }

  // Radio up front, power save OFF unconditionally -- modem sleep makes
  // ESP-NOW receivers silently miss packets.
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);

  // wifiAssociated == joined an AP, which forces the radio onto the AP's
  // channel and prevents pinning it to ESPNOW_CHANNEL.
  bool wifiAssociated = false;

#if ETH_ENABLED
  WiFi.onEvent(onEthEvent);
  ethSPI.begin(ETH_SPI_SCK, ETH_SPI_MISO, ETH_SPI_MOSI, ETH_PHY_CS);
  ETH.begin(ETH_PHY_W5500, 0, ETH_PHY_CS, ETH_PHY_IRQ, ETH_PHY_RST, ethSPI);

  unsigned long start = millis();
  while (!ethConnected && millis() - start < 5000) delay(100);

  if (!ethConnected) {
    Serial.println("Ethernet down, trying WiFi (time-boxed)");
    WiFi.begin(ssid, password);
    unsigned long wifiStart = millis();
    while (WiFi.status() != WL_CONNECTED &&
           millis() - wifiStart < WIFI_CONNECT_TIMEOUT_MS) {
      delay(300);
      Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
      wifiAssociated = true;
      Serial.print("WiFi IP: "); Serial.println(WiFi.localIP());
    } else {
      // Stop the STA from scanning/re-associating -- that hops channels and
      // would break ESP-NOW. Radio stays up for ESP-NOW without any network.
      WiFi.disconnect();
      Serial.println("WiFi failed -- continuing with ESP-NOW only (no IP network)");
    }
  }
#else
  WiFi.begin(ssid, password);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED &&
         millis() - wifiStart < WIFI_CONNECT_TIMEOUT_MS) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    wifiAssociated = true;
    Serial.print("WiFi IP: "); Serial.println(WiFi.localIP());
  } else {
    WiFi.disconnect();
    Serial.println("WiFi failed -- continuing with ESP-NOW only (no IP network)");
  }
#endif

  // ---- ESP-NOW init ----
  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
  } else {
    esp_now_register_recv_cb(onEspNowRecv);
    Serial.print("ESP-NOW ready, MAC: ");
    Serial.println(WiFi.macAddress());

    // Pin the radio to the gateway's channel. Only possible when we are NOT
    // joined to an AP -- an AP association forces the radio to its channel.
    if (!wifiAssociated) {
      esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
      Serial.print("ESP-NOW channel pinned to ");
      Serial.println(ESPNOW_CHANNEL);
    } else {
      Serial.println("WARNING: associated to WiFi AP -- radio is on the AP's channel.");
      Serial.println("ESP-NOW to the gateway only works if the AP is on channel "
                     + String(ESPNOW_CHANNEL));
    }

    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, gatewayMac, 6);
    peerInfo.channel = 0;   // 0 = use current channel
    peerInfo.encrypt = false;
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
      Serial.println("Failed to add gateway as ESP-NOW peer");
    }

    sendRegister();
    lastRegisterAttempt = millis();
  }

  // ---- OTA init ----
  ArduinoOTA.setPassword(otaPassword);
  ArduinoOTA.onStart([]() { Serial.println("OTA update starting"); });
  ArduinoOTA.onEnd([]() { Serial.println("OTA update complete"); });
  ArduinoOTA.onError([](ota_error_t error) { Serial.printf("OTA error [%u]\n", error); });
  ArduinoOTA.begin();
}

void loop() {
  ArduinoOTA.handle();
  checkPulses();
  processMachines();
  pollRS485();
  processRS485Queue();
  processRetries();

  static unsigned long lastDiPoll = 0;
  if (millis() - lastDiPoll > 100) {
    diState = diRead();
    if (diState != lastSentDiState) {
      sendStatusEvent(STATUS_DI_CHANGE, 0);
      lastSentDiState = diState;
    }
    lastDiPoll = millis();
  }

  // Re-announce periodically so a rebooted gateway re-learns us as a peer.
  // ESP-NOW only -- see header comment.
  if (millis() - lastRegisterAttempt > REGISTER_RETRY_MS) {
    sendRegister();
    lastRegisterAttempt = millis();
  }

  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
    sendStatusEvent(STATUS_HEARTBEAT, 0);
    lastHeartbeat = millis();
  }
}
