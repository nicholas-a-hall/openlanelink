// ============================================================
// openlanelink -- PINSETTER INTERFACE NODE
// Waveshare ESP32-S3-(POE-)ETH-8DI-8RO
//
// Controls the two Brunswick A2 pinsetters of ONE LANE PAIR. Each machine
// uses TWO relays: a pulse-only CYCLE relay (fires the cycle solenoid) and a
// latching POWER relay (machine mains). 2 machines = 4 relays.
//
// THIS NODE owns the machine config (MACHINES[] below) and per-machine state.
// The gateway sends pure semantic MSG_COMMAND{code=CommandCode, laneSide}:
//   CMD_CYCLE     -- fire the cycle solenoid once, regardless of ball
//   CMD_RERACK    -- cycle through to a fresh full rack: runs exactly the
//                    cycleCount the Pi decided (see execRerack()).
//   CMD_RESPOT    -- STUB, not implemented: stop at 180 waiting for pins on 2nd
//                    ball; needs manual intervention. Logged + acked only.
//   CMD_POWER_ON / CMD_POWER_OFF -- latch the machine's power relay
//   CMD_STATUS    -- report per-machine {ball, on, cycling, cooldown} via MSG_STATUS
//
// THIS SKETCH IS LANE-NUMBER-FREE, and identical on every lane pair in the
// house. Machines are addressed by which SIDE of the pair they sit on
// (LaneSide::A / LaneSide::B), never by lane number -- resolving side -> real
// lane number is the Pi's job (uart_bridge/lane_map.py). gatewayMac is the
// only per-pair constant left in this file.
//
// CONSEQUENCE: the 8RO board's channels 5-8 are spare, NOT "a second lane
// pair". They used to be commented-in-waiting as lanes 9/10, but a lane pair
// is defined by its gateway -- one gateway, one mesh, one ESP-NOW
// registration, two sides. A second pair needs its own gateway and its own
// pinsetter node; it cannot be a third and fourth machine on this one.
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
// transport. MSG_REGISTER stays ESP-NOW-only -- RS485 has no discovery
// concept, so there's nothing to register. See firmware/PROTOCOL.md, and
// the shared `lanelink` Arduino library (firmware/lib/lanelink, installed
// via firmware/tools/install_lanelink_library.ps1 (Windows) or .sh) for the canonical
// struct/enums -- one definition for every node, nothing to keep in sync.
// ============================================================

#include <Wire.h>

#include <lanelink_protocol.h>
#include <lanelink_rs485.h>

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
// DI/optocoupler-to-side mapping eventually joins it) should move to the
// software (Pi) side so reassigning a relay/DI channel to a side is a
// config change, not a firmware edit+reflash. Not yet designed -- see that
// item for why this isn't a trivial move (it changes who owns side->channel
// resolution, not just where the array lives). Note that the A/B-side
// rename already removed the *other* reason this array used to need editing
// per installation: it no longer carries lane numbers.
struct MachineConfig {
  LaneSide laneSide;
  uint8_t cycleRelay;   // pulse-only: fires the cycle solenoid
  uint8_t powerRelay;   // latching: machine mains power
};

// Channels 5-8 are spare, not a second pair -- see the header comment.
const MachineConfig MACHINES[] = {
  {LaneSide::A, 1, 2},
  {LaneSide::B, 3, 4},
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
// to the gateway -- see PROTOCOL.md. Baud MUST match the gateway's. Bus
// timing/framing lives in lanelink_rs485.h; only this board's wiring is here. ---
#define RS485_ENABLED 1
#define RS485_TX_PIN  17     // placeholder, verify
#define RS485_RX_PIN  18     // placeholder, verify
#define RS485_BAUD    9600

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
// The one per-pair constant in this sketch. NODE_ID is a human label for
// logs only; nothing on the wire carries it.
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

HardwareSerial RS485Port(1);
Rs485Link rs485(RS485Port, RS485_ENABLED);

uint8_t relayState = 0x00;
unsigned long pulseEndTime[8] = {0};
uint8_t diState = 0x00;

// The gateway dual-sends every MSG_COMMAND and MSG_ACK on both ESP-NOW and
// RS485, unconditionally, so the command survives either transport failing
// (see PROTOCOL.md's "Dual-send") -- both copies are byte-identical. With
// both transports actually up this node would otherwise execute every
// command twice: a double pinsetter cycle per foul.
//
// This replaced a single-slot "was that the last seq I saw" check, which
// caught the common back-to-back pair but not interleaved delivery --
// espnow(A), espnow(B), rs485(A) left A looking new again and re-ran it. The
// ring keys on the whole message, so ordering doesn't matter.
DualSendFilter dedupe;

unsigned long lastHeartbeat = 0;
unsigned long lastRegisterAttempt = 0;
uint8_t lastSentDiState = 0xFF;

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

bool isPoweredOn(int mi) {
  return (relayState >> (MACHINES[mi].powerRelay - 1)) & 0x01;
}

// ---- MSG_STATUS -- dual-sent on ESP-NOW + RS485, ack/retry-tracked ----
LaneSide sideForRelayChannel(int ch) {
  for (int i = 0; i < MACHINE_COUNT; i++) {
    if (MACHINES[i].cycleRelay == ch || MACHINES[i].powerRelay == ch) {
      return MACHINES[i].laneSide;
    }
  }
  return LaneSide::NONE;
}

void sendStatusEvent(StatusCode code, LaneSide side) {
  uint8_t seq = nextSeq++;

  NodeMessage msg = {};
  msg.msgType = MSG_STATUS;
  msg.seq = seq;
  msg.code = code;
  msg.laneSide = side;
  msg.timestampMs = millis();
  msg.data[0] = relayState;
  msg.data[1] = diState;

  // Every MSG_STATUS carries EVERY machine's record regardless of `code`, so
  // the gateway/Pi always has fresh per-machine data no matter which
  // StatusCode triggered this message. See lanelink_protocol.h.
  unsigned long now = millis();
  int n = 0;
  for (int i = 0; i < MACHINE_COUNT && n < MAX_MACHINES_PER_MSG; i++, n++) {
    MachineState &m = machineState[i];
    uint16_t cooldownMs = (m.cycleInProgress && m.busyUntil > now)
                              ? (uint16_t)(m.busyUntil - now) : 0;
    uint8_t flags = 0;
    if (isPoweredOn(i))    flags |= MACHINE_FLAG_ON;
    if (m.cycleInProgress) flags |= MACHINE_FLAG_CYCLING;
    if (m.ball == 2)       flags |= MACHINE_FLAG_BALL2;
    flags |= (uint8_t)((m.pendingCycles & MACHINE_PENDING_MASK) << MACHINE_PENDING_SHIFT);

    int off = machineRecordOffset(n);
    msg.data[off + 0] = (uint8_t)MACHINES[i].laneSide;
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
  rs485.enqueue(msg);
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
      rs485.enqueue(pending[i].msg);
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
  msg.laneSide = LaneSide::NONE;   // registration is node-level, not per-side
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
  sendStatusEvent(STATUS_RELAY_FAULT, LaneSide::NONE);
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
    sendStatusEvent(STATUS_REFUSED_PULSE_ONLY, sideForRelayChannel(ch));
    return;
  }

  uint8_t prevState = relayState;
  pulseEndTime[ch - 1] = 0;
  if (on) relayState |= (1 << (ch - 1));
  else    relayState &= ~(1 << (ch - 1));

  if (applyState()) {
    sendStatusEvent(STATUS_RELAY_ACK, sideForRelayChannel(ch));
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
    sendStatusEvent(STATUS_PULSE_ACK, sideForRelayChannel(ch));
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
    sendStatusEvent(STATUS_ALL_ACK, LaneSide::NONE);
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
        sendStatusEvent(STATUS_PULSE_COMPLETE, sideForRelayChannel(i + 1));
      } else {
        relayState = prevState; // retry next loop pass
      }
    }
  }
}

// ---- A2 machine sequencing ----
int machineIndexForSide(LaneSide side) {
  if (side == LaneSide::NONE) return -1;   // node-level, not a machine
  for (int i = 0; i < MACHINE_COUNT; i++) {
    if (MACHINES[i].laneSide == side) return i;
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
    Serial.print("Re-rack ignored, side ");
    Serial.print(laneSideName(MACHINES[mi].laneSide));
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
      sendStatusEvent(STATUS_CYCLE_COMPLETE, MACHINES[i].laneSide);
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
  Serial.print(commandCodeName(msg.code));
  Serial.print(", side=");
  Serial.print(laneSideName(msg.laneSide));
  Serial.println(" }");

  if (msg.code == CMD_STATUS) {
    sendStatusEvent(STATUS_MACHINE_STATUS, LaneSide::NONE);
    return;
  }

  int mi = machineIndexForSide(msg.laneSide);
  if (mi < 0) {
    Serial.print("No machine configured for side ");
    Serial.println(laneSideName(msg.laneSide));
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
      sendStatusEvent(STATUS_RESPOT_STUB, MACHINES[mi].laneSide);
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
  // Checked before the dispatch below, and spanning both transports, because
  // the duplicate arrives on the OTHER wire from the original -- see
  // dedupe's declaration above.
  if (dedupe.seenBefore(msg)) {
    Serial.print("Duplicate ");
    Serial.print(msgTypeName(msg.msgType));
    Serial.print(" (seq=");
    Serial.print(msg.seq);
    Serial.print(") via ");
    Serial.print(via);
    Serial.println(" -- already handled via the other transport, skipped");
    return;
  }

  switch (msg.msgType) {
    case MSG_COMMAND:
      execPinsetterCommand(msg);
      break;
    case MSG_ACK:
      if (msg.code == MSG_STATUS) handleIncomingAck(msg.seq);
      break;

    // Bus traffic this node has no part in, ignored SILENTLY and on purpose.
    // RS485 is one shared multi-drop bus, so every fouling/speed/ball-detect
    // event reaches this board too, and MSG_SCORE_EVENT arrives on both the
    // ESP-NOW broadcast address and the bus. Letting these fall through to
    // the default case below printed a line per beam break, per foul, and
    // per ball, forever -- drowning the log this node's real faults appear
    // in. `default` stays reserved for a genuinely unrecognized msgType,
    // which IS worth seeing.
    case MSG_LANE_EVENT:
    case MSG_BEAM_EVENT:
    case MSG_SCORE_EVENT:
      break;

    default:
      Serial.print("Unexpected msgType via ");
      Serial.print(via);
      Serial.print(": ");
      Serial.println(msgTypeName(msg.msgType));
      break;
  }
}

// Rs485Link::poll() hands verified frames here; the transport label is fixed
// because anything arriving on this port came off the RS485 bus by
// definition.
void onRs485Message(const NodeMessage &msg) {
  handleIncomingNodeMessage(msg, "RS485");
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
  Serial.println("Pinsetter interface node starting (" NODE_ID ")");

  // Build the pulse-only guard mask and init per-machine state.
  for (int i = 0; i < MACHINE_COUNT; i++) {
    pulseOnlyMask |= (1 << (MACHINES[i].cycleRelay - 1));
    machineState[i] = {1, 0, false, 0};  // assume 1st ball at boot
    Serial.print("Machine: side ");
    Serial.print(laneSideName(MACHINES[i].laneSide));
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

  rs485.begin(RS485_BAUD, RS485_RX_PIN, RS485_TX_PIN);
  if (rs485.enabled()) Serial.println("RS485 fallback link up");

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
  rs485.poll(onRs485Message);
  rs485.processQueue();
  processRetries();

  static unsigned long lastDiPoll = 0;
  if (millis() - lastDiPoll > 100) {
    diState = diRead();
    if (diState != lastSentDiState) {
      sendStatusEvent(STATUS_DI_CHANGE, LaneSide::NONE);
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
    sendStatusEvent(STATUS_HEARTBEAT, LaneSide::NONE);
    lastHeartbeat = millis();
  }
}
