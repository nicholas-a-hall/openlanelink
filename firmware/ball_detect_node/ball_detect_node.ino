// openlanelink -- BALL DETECTION NODE
//
// Covers TWO LANES, one Baomain E3F-R2NK break beam sensor each, positioned
// just BEFORE the pin deck. Its one job is to announce "a ball has arrived at
// the pins on this lane" -- that edge is what starts the vision capture ->
// score -> pinsetter cycle sequence on the Pi (see
// software/lanecompute/backend/vision/bridge_client.py and
// state_machine/state_machine.py's on_ball_detected()).
//
// Same sensor, wiring convention, and debounce as the fouling node; the only
// difference is where the beam physically sits and which role it reports.
//
// Wiring, each sensor:
//   Brown -> +12VDC
//   Blue  -> GND (common with ESP32 GND)
//   Black -> signal pin below, pulled up (internal or external 10k to 3.3V)
//
// Sensor A -> GPIO17
// Sensor B -> GPIO19
//
// Sensor is NPN open-collector, normally open:
//   Beam clear  -> pin reads HIGH
//   Beam broken -> pin reads LOW (transistor sinks to GND)
//
// Neither GPIO17 nor GPIO19 is a strapping pin or input-only, and both have
// internal pull-ups available -- same reasoning as the fouling node's pins.
// Avoid GPIO34-39 if these ever move (input-only, no internal pull-up).
//
// No buzzer: a ball reaching the pins is not an alert condition, unlike the
// fouling node's foul-line trip.
//
// EMITS MSG_BEAM_EVENT WITH data[0] = ROLE_BALL_DETECT (2), not
// ROLE_DOWNSTREAM. The speed node's two beams own roles 0/1 and exist purely
// so the Pi can pair their timestamps into an interval; this node's single
// beam is a position/arrival signal with no pairing partner. Tagging it as a
// third, distinct role is what keeps a lane covered by BOTH nodes from
// feeding a bogus reading into that pairing -- the Pi pops its pending
// upstream timestamp on any downstream edge, so a ball-detect beam
// masquerading as ROLE_DOWNSTREAM would consume it and report a fabricated
// ball speed. See firmware/PROTOCOL.md's MSG_BEAM_EVENT section.
//
// This node does NO timing, counting, or correlation of its own -- it
// debounces each sensor and emits a raw edge, same as the fouling and speed
// nodes. Deciding what a ball arriving means for the game (whose ball it is,
// when to capture a photo, when to cycle) all happens on the Pi. See the
// openlanelink "nodes are dumb" design principle in firmware/HANDOFF.md.
//
// This node has NO ESP-NOW receive callback -- it cannot receive anything,
// by design. It is a pure sensor emitter.
//
// ESP-NOW: registers with the gateway (MAC hardcoded below) once at startup
// by sending MSG_REGISTER{code=NODE_BALL_DETECT}, then re-announces every
// REGISTER_RETRY_MS so a rebooted gateway re-learns it as a peer.
//
// Every MSG_BEAM_EVENT is ALSO sent on RS485 (a shared wired bus with the
// gateway/fouling/speed/pinsetter nodes) -- a fallback to insulate delivery
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

const int NUM_SENSORS = 2;
const int SENSOR_PIN[NUM_SENSORS] = {17, 19};
const int LANE_NUMBER[NUM_SENSORS] = {7, 8};
const unsigned long DEBOUNCE_MS = 30;

uint8_t GATEWAY_MAC[6] = {0x68, 0x25, 0xDD, 0x32, 0x64, 0x7C};

// ---- RS485 (UNVERIFIED -- confirm pins against the board). Wired fallback
// to insulate MSG_BEAM_EVENT delivery against ESP-NOW radio failures -- see
// firmware/PROTOCOL.md. Shared multi-drop bus with the gateway/fouling/
// speed/pinsetter nodes; MSG_REGISTER stays ESP-NOW-only (no peer concept on
// a raw UART bus), so this node only ever TRANSMITS on RS485, never listens. ----
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

// ROLE_UPSTREAM/ROLE_DOWNSTREAM belong to the speed node's beam pair; this
// node only ever emits ROLE_BALL_DETECT (see the header comment above).
enum BeamRole : uint8_t {
  ROLE_UPSTREAM = 0, ROLE_DOWNSTREAM = 1, ROLE_BALL_DETECT = 2,
};

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

bool lastStable[NUM_SENSORS];
bool lastReading[NUM_SENSORS];
unsigned long lastChangeTime[NUM_SENSORS];
unsigned long ballCount[NUM_SENSORS];

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

void sendBeamEvent(BeamEventCode code, uint8_t laneNumber) {
  NodeMessage msg = {};
  msg.msgType = MSG_BEAM_EVENT;
  msg.code = code;
  msg.laneNumber = laneNumber;
  msg.data[0] = ROLE_BALL_DETECT;
  sendMessage(msg);
  rs485Enqueue(msg);   // dual-sent: insulates delivery against ESP-NOW failures
}

// Announce ourselves so the gateway adds us as a peer dynamically.
void sendRegister() {
  NodeMessage msg = {};
  msg.msgType = MSG_REGISTER;
  msg.code = NODE_BALL_DETECT;
  msg.laneNumber = 0;
  sendMessage(msg);
  Serial.println("Sent REGISTER to gateway");
}

void setup() {
  Serial.begin(9600);
  delay(200);
  randomSeed(esp_random());

  Serial.println();
  Serial.println("Ball detection node starting");

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
    ballCount[i] = 0;
    lastChangeTime[i] = 0;

    Serial.print("Sensor ");
    Serial.print(i);
    Serial.print(" (GPIO");
    Serial.print(SENSOR_PIN[i]);
    Serial.print(", lane ");
    Serial.print(LANE_NUMBER[i]);
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

      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] Lane ");
      Serial.print(LANE_NUMBER[i]);
      if (lastStable[i] == LOW) {
        ballCount[i]++;
        Serial.print(" BALL AT PINS  (count: ");
        Serial.print(ballCount[i]);
        Serial.println(")");
        sendBeamEvent(BEAM_BROKEN, LANE_NUMBER[i]);
      } else {
        Serial.println(" CLEAR");
        sendBeamEvent(BEAM_CLEAR, LANE_NUMBER[i]);
      }
    }
  }

  // Re-announce periodically so a rebooted gateway re-learns us as a peer.
  if (millis() - lastRegisterAttempt > REGISTER_RETRY_MS) {
    sendRegister();
    lastRegisterAttempt = millis();
  }

  processRS485Queue();
}
