// openlanelink -- FOULING (BREAK-BEAM) NODE
//
// Two Baomain E3F-R2NK break beam sensors on ESP32.
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
//   Beam broken -> transistor sinks to GND -> pin reads LOW
//
// Neither GPIO17 nor GPIO19 is a strapping pin or input-only, both have
// internal pull-ups available.
//
// Buzzer: passive piezo buzzer, + lead -> GPIO4, - lead -> GND.
// Warbles between two distinct tones while either sensor is blocked, at
// roughly half volume (see BUZZER_VOLUME_DUTY below). This is a LOCAL,
// board-level alert combining both lanes -- independent of the ESP-NOW
// events, which are always per-lane.
//
// ESP-NOW: registers with the gateway (MAC hardcoded below) once at startup
// by sending MSG_REGISTER, then re-announces every REGISTER_RETRY_MS. Sends
// a per-lane MSG_LANE_EVENT whenever that lane's sensor changes state. This
// board covers two lanes, one sensor each -- see LANE_NUMBER below.
//
// This node has NO ESP-NOW receive callback -- it cannot receive anything,
// by design. It is a pure sensor emitter; see the openlanelink "nodes are
// dumb" design principle in firmware/HANDOFF.md.
//
// Every MSG_LANE_EVENT is ALSO sent on RS485 (a shared wired bus with the
// gateway/speed/pinsetter nodes) -- a fallback to insulate delivery against
// ESP-NOW radio failures. This node only ever transmits on RS485, never
// listens (MSG_REGISTER, the only thing it might otherwise "receive" a need
// for, stays ESP-NOW-only -- a raw UART bus has no peer/discovery concept).
// See firmware/PROTOCOL.md.
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
const int BUZZER_PIN = 4;
const unsigned long DEBOUNCE_MS = 30;

const unsigned int TONE_FREQ_LOW = 700;
const unsigned int TONE_FREQ_HIGH = 1300;
const unsigned long WARBLE_INTERVAL_MS = 150;

const int BUZZER_RESOLUTION_BITS = 8;    // duty range 0-255
const int BUZZER_VOLUME_DUTY = 64;       // ~25% duty ~= half of normal volume

uint8_t GATEWAY_MAC[6] = {0x68, 0x25, 0xDD, 0x32, 0x64, 0x7C};

// ---- RS485 (UNVERIFIED -- confirm pins against the board). Wired fallback
// to insulate MSG_LANE_EVENT delivery against ESP-NOW radio failures -- see
// firmware/PROTOCOL.md. Shared multi-drop bus with the gateway/speed/
// pinsetter nodes; MSG_REGISTER stays ESP-NOW-only (no peer concept on a
// raw UART bus), so this node only ever TRANSMITS on RS485, never listens. ----
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
};

enum LaneEventCode : uint8_t { LANE_CLEAR = 0, LANE_FOUL = 1 };

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
unsigned long breakCount[NUM_SENSORS];

bool warbleHigh = false;
unsigned long lastWarbleTime = 0;
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

void sendLaneEvent(LaneEventCode code, uint8_t laneNumber) {
  NodeMessage msg = {};
  msg.msgType = MSG_LANE_EVENT;
  msg.code = code;
  msg.laneNumber = laneNumber;
  sendMessage(msg);
  rs485Enqueue(msg);   // dual-sent: insulates delivery against ESP-NOW failures
}

// Announce ourselves so the gateway adds us as a peer dynamically.
void sendRegister() {
  NodeMessage msg = {};
  msg.msgType = MSG_REGISTER;
  msg.code = NODE_FOULING;
  msg.laneNumber = 0;
  sendMessage(msg);
  Serial.println("Sent REGISTER to gateway");
}

void setup() {
  Serial.begin(9600);
  delay(200);
  randomSeed(esp_random());

  ledcAttach(BUZZER_PIN, TONE_FREQ_LOW, BUZZER_RESOLUTION_BITS);
  ledcWrite(BUZZER_PIN, 0);

  Serial.println();
  Serial.println("Break beam test starting");

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
    breakCount[i] = 0;
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
  bool anyBlocked = false;

  for (int i = 0; i < NUM_SENSORS; i++) {
    bool reading = digitalRead(SENSOR_PIN[i]);

    if (reading != lastReading[i]) {
      lastChangeTime[i] = millis();
      lastReading[i] = reading;
    }

    if ((millis() - lastChangeTime[i]) > DEBOUNCE_MS && reading != lastStable[i]) {
      lastStable[i] = reading;

      if (lastStable[i] == LOW) {
        breakCount[i]++;
        Serial.print("[");
        Serial.print(millis());
        Serial.print(" ms] Lane ");
        Serial.print(LANE_NUMBER[i]);
        Serial.print(" BLOCKED  (count: ");
        Serial.print(breakCount[i]);
        Serial.println(")");
        sendLaneEvent(LANE_FOUL, LANE_NUMBER[i]);
      } else {
        Serial.print("[");
        Serial.print(millis());
        Serial.print(" ms] Lane ");
        Serial.print(LANE_NUMBER[i]);
        Serial.println(" CLEAR");
        sendLaneEvent(LANE_CLEAR, LANE_NUMBER[i]);
      }
    }

    if (lastStable[i] == LOW) {
      anyBlocked = true;
    }
  }

  // Re-announce periodically so a rebooted gateway re-learns us as a peer.
  if (millis() - lastRegisterAttempt > REGISTER_RETRY_MS) {
    sendRegister();
    lastRegisterAttempt = millis();
  }

  if (anyBlocked) {
    if (millis() - lastWarbleTime >= WARBLE_INTERVAL_MS) {
      warbleHigh = !warbleHigh;
      ledcWriteTone(BUZZER_PIN, warbleHigh ? TONE_FREQ_HIGH : TONE_FREQ_LOW);
      ledcWrite(BUZZER_PIN, BUZZER_VOLUME_DUTY);
      lastWarbleTime = millis();
    }
  } else {
    ledcWrite(BUZZER_PIN, 0);
    warbleHigh = false;
  }

  processRS485Queue();
}
