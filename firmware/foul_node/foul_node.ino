// openlanelink -- FOULING (BREAK-BEAM) NODE
//
// Two Baomain E3F-R2NK break beam sensors on ESP32.
//
// Wiring, each sensor:
//   Brown -> +12VDC
//   Blue  -> GND (common with ESP32 GND)
//   Black -> signal pin below, pulled up (internal or external 10k to 3.3V)
//
// Sensor A -> GPIO17  (lane side A)
// Sensor B -> GPIO19  (lane side B)
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
// board-level alert combining both sides -- independent of the ESP-NOW
// events, which are always per-side.
//
// THIS SKETCH IS LANE-NUMBER-FREE, and identical on every lane pair in the
// house. It reports which SIDE of its pair a foul happened on (LaneSide::A /
// LaneSide::B), never a lane number -- a gateway's mesh is exactly one lane
// pair, so the side is all the mesh needs, and resolving side -> real lane
// number is the Pi's job (uart_bridge/lane_map.py). GATEWAY_MAC is the only
// per-pair constant left in this file.
//
// ESP-NOW: registers with the gateway (MAC hardcoded below) once at startup
// by sending MSG_REGISTER, then re-announces every REGISTER_RETRY_MS. Sends
// a per-side MSG_LANE_EVENT whenever that side's sensor changes state.
//
// This node has NO ESP-NOW receive callback -- it cannot receive anything,
// by design. It is a pure sensor emitter; see the openlanelink "nodes are
// dumb" design principle in firmware/HANDOFF.md.
//
// Every MSG_LANE_EVENT is ALSO sent on RS485 (a shared wired bus with the
// gateway/speed/ball-detect/pinsetter nodes) -- a fallback to insulate
// delivery against ESP-NOW radio failures. This node ACTS on nothing from
// RS485 (MSG_REGISTER, the only thing it might otherwise "receive" a need
// for, stays ESP-NOW-only -- a raw UART bus has no peer/discovery concept),
// but it does READ the bus every loop (rs485.observeBus()): that is what
// lets its collision avoidance see other nodes' traffic rather than only its
// own transmissions. Its RS485 RX pin is therefore required wiring.
// See firmware/PROTOCOL.md.
//
// Wire format: the shared `lanelink` Arduino library
// (firmware/lib/lanelink) -- one definition for every node, installed via
// firmware/tools/install_lanelink_library.ps1 (Windows) or .sh. Send callback uses the esp32 core 3.3.x signature (wifi_tx_info_t *);
// older cores instead pass the destination MAC directly as `const uint8_t *`.

#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <HardwareSerial.h>

#include <lanelink_protocol.h>
#include <lanelink_rs485.h>

const int NUM_SENSORS = 2;
const int SENSOR_PIN[NUM_SENSORS] = {17, 19};
const LaneSide SENSOR_SIDE[NUM_SENSORS] = {LaneSide::A, LaneSide::B};
const int BUZZER_PIN = 4;
const unsigned long DEBOUNCE_MS = 30;

const unsigned int TONE_FREQ_LOW = 700;
const unsigned int TONE_FREQ_HIGH = 1300;
const unsigned long WARBLE_INTERVAL_MS = 150;

const int BUZZER_RESOLUTION_BITS = 8;    // duty range 0-255
const int BUZZER_VOLUME_DUTY = 64;       // ~25% duty ~= half of normal volume

// The one per-pair constant in this sketch: which gateway this board belongs
// to. Everything else is identical on every lane pair.
uint8_t GATEWAY_MAC[6] = {0x68, 0x25, 0xDD, 0x32, 0x64, 0x7C};

// ---- RS485 (UNVERIFIED -- confirm pins against the board). Wired fallback
// to insulate MSG_LANE_EVENT delivery against ESP-NOW radio failures -- see
// firmware/PROTOCOL.md. Shared multi-drop bus with the gateway/speed/
// ball-detect/pinsetter nodes; MSG_REGISTER stays ESP-NOW-only (no peer
// concept on a raw UART bus), so this node acts on nothing it reads -- but it
// DOES read, for carrier sense. Bus timing/framing lives in lanelink_rs485.h;
// only this board's own wiring is here. ----
#define RS485_ENABLED 1
#define RS485_TX_PIN 16   // placeholder, verify
#define RS485_RX_PIN 18   // placeholder, verify -- REQUIRED WIRING: read for bus
                          // carrier sense (rs485.observeBus()), even though this
                          // node acts on nothing it reads
#define RS485_BAUD 9600

HardwareSerial RS485Port(1);
Rs485Link rs485(RS485Port, RS485_ENABLED);

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

void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
    Serial.println("ESP-NOW send failed");
  }
}

void sendMessage(NodeMessage &msg) {
  msg.seq = nextSeq++;
  msg.timestampMs = millis();
  esp_now_send(GATEWAY_MAC, (uint8_t *)&msg, sizeof(msg));
}

void sendLaneEvent(LaneEventCode code, LaneSide side) {
  NodeMessage msg = {};
  msg.msgType = MSG_LANE_EVENT;
  msg.code = code;
  msg.laneSide = side;
  sendMessage(msg);
  rs485.enqueue(msg);   // dual-sent: insulates delivery against ESP-NOW failures
}

// Announce ourselves so the gateway adds us as a peer dynamically.
void sendRegister() {
  NodeMessage msg = {};
  msg.msgType = MSG_REGISTER;
  msg.code = NODE_FOULING;
  msg.laneSide = LaneSide::NONE;   // registration is node-level, not per-side
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
  Serial.println("Fouling node starting");

  rs485.begin(RS485_BAUD, RS485_RX_PIN, RS485_TX_PIN);
  if (rs485.enabled()) Serial.println("RS485 fallback link up");

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
    Serial.print(", side ");
    Serial.print(laneSideName(SENSOR_SIDE[i]));
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
        Serial.print(" ms] Side ");
        Serial.print(laneSideName(SENSOR_SIDE[i]));
        Serial.print(" BLOCKED  (count: ");
        Serial.print(breakCount[i]);
        Serial.println(")");
        sendLaneEvent(LANE_FOUL, SENSOR_SIDE[i]);
      } else {
        Serial.print("[");
        Serial.print(millis());
        Serial.print(" ms] Side ");
        Serial.print(laneSideName(SENSOR_SIDE[i]));
        Serial.println(" CLEAR");
        sendLaneEvent(LANE_CLEAR, SENSOR_SIDE[i]);
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

  // Read the bus before deciding it's idle enough to transmit into.
  // This node acts on nothing it hears -- it just needs to HEAR, so its
  // collision avoidance sees other nodes' traffic and not only its own.
  rs485.observeBus();
  rs485.processQueue();
}
