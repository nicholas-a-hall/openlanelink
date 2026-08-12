// openlanelink -- SPEED NODE
//
// Covers ONE LANE PAIR, two break-beam sensors per lane (4 total), spaced
// apart along the lane in the direction of ball travel ("upstream" beam
// first, "downstream" beam second).
//
// This node does NOT compute speed or track timing state -- it just debounces
// each beam and emits a MSG_BEAM_EVENT (BROKEN/CLEAR) tagged with lane + beam
// role whenever a sensor changes state, same as break_beam_test.ino does for
// its own sensors. Pairing the upstream/downstream timestamps into an
// interval, applying a timeout, and converting to mph all happen on the Pi
// side of the gateway<->Pi UART bridge -- nodes stay dumb: emit events,
// accept commands relevant to their own function, know nothing about each
// other. See firmware/HANDOFF.md.
//
// Wiring, each sensor (same as break_beam_test.ino):
//   Brown -> +12VDC
//   Blue  -> GND (common with ESP32 GND)
//   Black -> signal pin below, INPUT_PULLUP
// Beam clear -> pin HIGH. Beam broken -> pin LOW (NPN open-collector).
//
// GPIO pins below are UNVERIFIED PLACEHOLDERS -- confirm against the actual
// board before wiring. Avoid GPIO34-39 (input-only, no internal pull-up).
//
// Per the openlanelink lane-preset design principle: this node hardcodes its
// own lane numbers (LANE_NUMBER[]) and its target gateway's MAC (GATEWAY_MAC)
// at compile time, same as break_beam_test.ino / pinsetter_node.ino.
//
// This node has NO ESP-NOW receive callback -- it cannot receive anything,
// by design. Pure sensor emitter.
//
// Every MSG_BEAM_EVENT is ALSO sent on RS485 (a shared wired bus with the
// gateway/fouling/pinsetter nodes) -- a fallback to insulate delivery
// against ESP-NOW radio failures. This node only ever transmits on RS485,
// never listens (MSG_REGISTER stays ESP-NOW-only -- a raw UART bus has no
// peer/discovery concept). See firmware/PROTOCOL.md.
//
// Wire format: see firmware/PROTOCOL.md -- every openlanelink node sends the
// same NodeMessage struct for every purpose, on every transport it has. Send
// callback uses the esp32 core 3.3.x signature (wifi_tx_info_t *); older
// cores instead pass the destination MAC directly as `const uint8_t *`.

#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <HardwareSerial.h>

const int NUM_LANES = 2;
const int LANE_NUMBER[NUM_LANES] = {7, 8};

// ROLE_BALL_DETECT is never emitted by this node -- it belongs to
// ball_detect_node.ino's single near-pins beam. Carried here only to keep
// the canonical BeamRole enum identical across every sketch (see
// PROTOCOL.md).
enum BeamRole : uint8_t {
  ROLE_UPSTREAM = 0, ROLE_DOWNSTREAM = 1, ROLE_BALL_DETECT = 2,
};

const int NUM_SENSORS = 4;
const int SENSOR_PIN[NUM_SENSORS]  = {25, 26, 27, 32};       // placeholder, verify
const int SENSOR_LANE[NUM_SENSORS] = {0, 0, 1, 1};           // index into LANE_NUMBER[]
const BeamRole SENSOR_ROLE[NUM_SENSORS] =
    {ROLE_UPSTREAM, ROLE_DOWNSTREAM, ROLE_UPSTREAM, ROLE_DOWNSTREAM};

const unsigned long DEBOUNCE_MS = 30;

uint8_t GATEWAY_MAC[6] = {0x68, 0x25, 0xDD, 0x32, 0x64, 0x7C};

// ---- RS485 (UNVERIFIED -- confirm pins against the board). Wired fallback
// to insulate MSG_BEAM_EVENT delivery against ESP-NOW radio failures -- see
// firmware/PROTOCOL.md. Shared multi-drop bus with the gateway/fouling/
// pinsetter nodes; this node only ever transmits, never listens. ----
#define RS485_ENABLED 1
#define RS485_TX_PIN 16   // placeholder, verify
#define RS485_RX_PIN 18   // placeholder, verify (unused -- this node never receives)
#define RS485_BAUD 9600
#define RS485_IDLE_MS 15
#define RS485_JITTER_MAX_MS 20
#define RS485_MAX_QUEUE 8

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

enum BeamEventCode : uint8_t { BEAM_CLEAR = 0, BEAM_BROKEN = 1 };

struct NodeMessage {
  uint8_t msgType;
  uint8_t seq;
  uint8_t code;
  uint8_t laneNumber;
  uint32_t timestampMs;
  uint8_t data[64];
};   // sizeof = 72 bytes, fixed, no padding (see PROTOCOL.md)

// RS485 frame: [0xAA START][LEN][PAYLOAD = raw NodeMessage bytes][CHECKSUM].
#define RS485_FRAME_START 0xAA
#define RS485_FRAME_SIZE (sizeof(NodeMessage) + 3)

// ============================================================
// ESP-NOW peers must share a radio channel. This node never joins an AP, so
// pin it to the gateway's channel explicitly.
#define ESPNOW_CHANNEL 1

// Re-announce periodically so a rebooted gateway re-learns us as a peer.
#define REGISTER_RETRY_MS 10000

// ---- Per-sensor debounce state ----
bool lastStable[NUM_SENSORS];
bool lastReading[NUM_SENSORS];
unsigned long lastChangeTime[NUM_SENSORS];

unsigned long lastRegisterAttempt = 0;
uint8_t nextSeq = 0;   // for traceability in logs only -- this node's messages are never acked

HardwareSerial RS485(1);
uint8_t rs485Queue[RS485_MAX_QUEUE][RS485_FRAME_SIZE];
uint8_t rs485QueueLen[RS485_MAX_QUEUE];
int rs485QueueHead = 0, rs485QueueTail = 0, rs485QueueCount = 0;
unsigned long lastRS485Activity = 0;
unsigned long rs485NextAttempt = 0;

void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
    Serial.println("ESP-NOW send failed");
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

void sendMessage(NodeMessage &msg) {
  msg.seq = nextSeq++;
  msg.timestampMs = millis();
  esp_now_send(GATEWAY_MAC, (uint8_t *)&msg, sizeof(msg));
}

void sendRegister() {
  NodeMessage msg = {};
  msg.msgType = MSG_REGISTER;
  msg.code = NODE_SPEED;
  msg.laneNumber = 0;
  sendMessage(msg);
  Serial.println("Sent REGISTER to gateway");
}

void sendBeamEvent(BeamEventCode code, uint8_t laneNumber, BeamRole role) {
  NodeMessage msg = {};
  msg.msgType = MSG_BEAM_EVENT;
  msg.code = code;
  msg.laneNumber = laneNumber;
  msg.data[0] = role;
  sendMessage(msg);
  rs485Enqueue(msg);   // dual-sent: insulates delivery against ESP-NOW failures

  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] Lane ");
  Serial.print(laneNumber);
  Serial.print(" ");
  Serial.print(role == ROLE_UPSTREAM ? "upstream" : "downstream");
  Serial.println(code == BEAM_BROKEN ? " BROKEN" : " CLEAR");
}

void setup() {
  Serial.begin(9600);
  delay(200);
  randomSeed(esp_random());

  Serial.println();
  Serial.println("Speed node starting");

  if (RS485_ENABLED) {
    RS485.begin(RS485_BAUD, SERIAL_8N1, RS485_RX_PIN, RS485_TX_PIN);
    Serial.println("RS485 fallback link up");
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // modem sleep makes ESP-NOW receivers miss packets
  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
  } else {
    esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
    esp_now_register_send_cb(onDataSent);

    esp_now_peer_info_t peerInfo = {};
    memcpy(peerInfo.peer_addr, GATEWAY_MAC, 6);
    peerInfo.channel = 0;   // 0 = use current channel
    peerInfo.encrypt = false;
    if (esp_now_add_peer(&peerInfo) != ESP_OK) {
      Serial.println("Failed to add gateway as ESP-NOW peer");
    }

    sendRegister();
    lastRegisterAttempt = millis();
  }

  for (int i = 0; i < NUM_SENSORS; i++) {
    pinMode(SENSOR_PIN[i], INPUT_PULLUP);
    lastStable[i] = digitalRead(SENSOR_PIN[i]);
    lastReading[i] = lastStable[i];
    lastChangeTime[i] = 0;

    Serial.print("Sensor ");
    Serial.print(i);
    Serial.print(" (GPIO");
    Serial.print(SENSOR_PIN[i]);
    Serial.print(", lane ");
    Serial.print(LANE_NUMBER[SENSOR_LANE[i]]);
    Serial.print(", ");
    Serial.print(SENSOR_ROLE[i] == ROLE_UPSTREAM ? "upstream" : "downstream");
    Serial.print(") initial state: ");
    Serial.println(lastStable[i] == HIGH ? "CLEAR" : "BLOCKED");
  }
}

void loop() {
  for (int i = 0; i < NUM_SENSORS; i++) {
    bool reading = digitalRead(SENSOR_PIN[i]);

    if (reading != lastReading[i]) {
      lastChangeTime[i] = millis();
      lastReading[i] = reading;
    }

    if ((millis() - lastChangeTime[i]) > DEBOUNCE_MS && reading != lastStable[i]) {
      lastStable[i] = reading;

      uint8_t lane = LANE_NUMBER[SENSOR_LANE[i]];
      BeamEventCode code = (lastStable[i] == LOW) ? BEAM_BROKEN : BEAM_CLEAR;
      sendBeamEvent(code, lane, SENSOR_ROLE[i]);
    }
  }

  // Re-announce periodically so a rebooted gateway re-learns us as a peer.
  if (millis() - lastRegisterAttempt > REGISTER_RETRY_MS) {
    sendRegister();
    lastRegisterAttempt = millis();
  }

  processRS485Queue();
}
