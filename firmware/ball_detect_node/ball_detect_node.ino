// openlanelink -- BALL DETECTION NODE
//
// Covers ONE LANE PAIR, one Baomain E3F-R2NK break beam sensor per side,
// positioned just BEFORE the pin deck. Its one job is to announce "a ball has
// arrived at the pins on this side" -- that edge is what starts the vision
// capture -> score -> pinsetter cycle sequence on the Pi (see
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
// Sensor A -> GPIO17  (lane side A)
// Sensor B -> GPIO19  (lane side B)
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
// THIS SKETCH IS LANE-NUMBER-FREE, and identical on every lane pair in the
// house. It reports which SIDE of its pair the ball arrived on (LaneSide::A /
// LaneSide::B), never a lane number -- see lanelink_protocol.h's LaneSide and
// firmware/PROTOCOL.md. GATEWAY_MAC is the only per-pair constant left here.
//
// EMITS MSG_BEAM_EVENT WITH data[0] = ROLE_BALL_DETECT (2), not
// ROLE_DOWNSTREAM. The speed node's two beams own roles 0/1 and exist purely
// so the Pi can pair their timestamps into an interval; this node's single
// beam is a position/arrival signal with no pairing partner. Tagging it as a
// third, distinct role is what keeps a side covered by BOTH nodes from
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
// against ESP-NOW radio failures. This node ACTS on nothing from RS485
// (MSG_REGISTER stays ESP-NOW-only -- a raw UART bus has no peer/discovery
// concept), but it does READ the bus every loop (rs485.observeBus()): that
// is what lets its collision avoidance see other nodes' traffic rather than
// only its own transmissions. Its RS485 RX pin is therefore required wiring.
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
const unsigned long DEBOUNCE_MS = 30;

// The one per-pair constant in this sketch: which gateway this board belongs
// to. Everything else is identical on every lane pair.
uint8_t GATEWAY_MAC[6] = {0x68, 0x25, 0xDD, 0x32, 0x64, 0x7C};

// ---- RS485 (UNVERIFIED -- confirm pins against the board). Wired fallback
// to insulate MSG_BEAM_EVENT delivery against ESP-NOW radio failures -- see
// firmware/PROTOCOL.md. Shared multi-drop bus with the gateway/fouling/
// speed/pinsetter nodes; MSG_REGISTER stays ESP-NOW-only (no peer concept on
// a raw UART bus), so this node acts on nothing it reads -- but it DOES read,
// for carrier sense. Bus timing/framing lives in lanelink_rs485.h; only this
// board's own wiring is here. ----
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
unsigned long ballCount[NUM_SENSORS];

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

void sendBeamEvent(BeamEventCode code, LaneSide side) {
  NodeMessage msg = {};
  msg.msgType = MSG_BEAM_EVENT;
  msg.code = code;
  msg.laneSide = side;
  msg.data[0] = ROLE_BALL_DETECT;
  sendMessage(msg);
  rs485.enqueue(msg);   // dual-sent: insulates delivery against ESP-NOW failures
}

// Announce ourselves so the gateway adds us as a peer dynamically.
void sendRegister() {
  NodeMessage msg = {};
  msg.msgType = MSG_REGISTER;
  msg.code = NODE_BALL_DETECT;
  msg.laneSide = LaneSide::NONE;   // registration is node-level, not per-side
  sendMessage(msg);
  Serial.println("Sent REGISTER to gateway");
}

void setup() {
  Serial.begin(9600);
  delay(200);
  randomSeed(esp_random());

  Serial.println();
  Serial.println("Ball detection node starting");

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
    ballCount[i] = 0;
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
      Serial.print(" ms] Side ");
      Serial.print(laneSideName(SENSOR_SIDE[i]));
      if (lastStable[i] == LOW) {
        ballCount[i]++;
        Serial.print(" BALL AT PINS  (count: ");
        Serial.print(ballCount[i]);
        Serial.println(")");
        sendBeamEvent(BEAM_BROKEN, SENSOR_SIDE[i]);
      } else {
        Serial.println(" CLEAR");
        sendBeamEvent(BEAM_CLEAR, SENSOR_SIDE[i]);
      }
    }
  }

  // Re-announce periodically so a rebooted gateway re-learns us as a peer.
  if (millis() - lastRegisterAttempt > REGISTER_RETRY_MS) {
    sendRegister();
    lastRegisterAttempt = millis();
  }

  // Read the bus before deciding it's idle enough to transmit into.
  // This node acts on nothing it hears -- it just needs to HEAR, so its
  // collision avoidance sees other nodes' traffic and not only its own.
  rs485.observeBus();
  rs485.processQueue();
}
