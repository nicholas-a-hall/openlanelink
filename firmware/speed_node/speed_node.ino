// openlanelink -- SPEED NODE
//
// Covers ONE LANE PAIR, two break-beam sensors per side (4 total), spaced
// apart along the lane in the direction of ball travel ("upstream" beam
// first, "downstream" beam second).
//
// This node does NOT compute speed or track timing state -- it just debounces
// each beam and emits a MSG_BEAM_EVENT (BROKEN/CLEAR) tagged with lane side +
// beam role whenever a sensor changes state, same as foul_node.ino does for
// its own sensors. Pairing the upstream/downstream timestamps into an
// interval, applying a timeout, and converting to mph all happen on the Pi
// side of the gateway<->Pi UART bridge -- nodes stay dumb: emit events,
// accept commands relevant to their own function, know nothing about each
// other. See firmware/HANDOFF.md.
//
// Wiring, each sensor (same as foul_node.ino):
//   Brown -> +12VDC
//   Blue  -> GND (common with ESP32 GND)
//   Black -> signal pin below, INPUT_PULLUP
// Beam clear -> pin HIGH. Beam broken -> pin LOW (NPN open-collector).
//
// GPIO pins below are UNVERIFIED PLACEHOLDERS -- confirm against the actual
// board before wiring. Avoid GPIO34-39 (input-only, no internal pull-up).
//
// THIS SKETCH IS LANE-NUMBER-FREE, and identical on every lane pair in the
// house. Each beam is tagged with the SIDE of the pair it watches
// (LaneSide::A / LaneSide::B), never a lane number -- a gateway's mesh is
// exactly one lane pair, so the side is all the mesh needs, and resolving
// side -> real lane number is the Pi's job (uart_bridge/lane_map.py).
// GATEWAY_MAC is the only per-pair constant left in this file.
//
// This node has NO ESP-NOW receive callback -- it cannot receive anything,
// by design. Pure sensor emitter.
//
// Every MSG_BEAM_EVENT is ALSO sent on RS485 (a shared wired bus with the
// gateway/fouling/ball-detect/pinsetter nodes) -- a fallback to insulate
// delivery against ESP-NOW radio failures. This node ACTS on nothing from
// RS485 (MSG_REGISTER stays ESP-NOW-only -- a raw UART bus has no
// peer/discovery concept), but it does READ the bus every loop
// (rs485.observeBus()): that is what lets its collision avoidance see other
// nodes' traffic rather than only its own transmissions. Its RS485 RX pin is
// therefore required wiring. See firmware/PROTOCOL.md.
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

// Four beams: an upstream/downstream pair per side. SENSOR_SIDE and
// SENSOR_ROLE are parallel to SENSOR_PIN -- index i fully describes beam i,
// with no lookup table in between.
//
// ROLE_BALL_DETECT is never emitted by this node -- it belongs to
// ball_detect_node.ino's single near-pins beam. It's in the shared BeamRole
// enum because the protocol is defined once for the whole mesh, not
// because this node can produce one.
const int NUM_SENSORS = 4;
const int SENSOR_PIN[NUM_SENSORS] = {25, 26, 27, 32};       // placeholder, verify
const LaneSide SENSOR_SIDE[NUM_SENSORS] =
    {LaneSide::A, LaneSide::A, LaneSide::B, LaneSide::B};
const BeamRole SENSOR_ROLE[NUM_SENSORS] =
    {ROLE_UPSTREAM, ROLE_DOWNSTREAM, ROLE_UPSTREAM, ROLE_DOWNSTREAM};

const unsigned long DEBOUNCE_MS = 30;

// The one per-pair constant in this sketch: which gateway this board belongs
// to. Everything else is identical on every lane pair.
uint8_t GATEWAY_MAC[6] = {0x68, 0x25, 0xDD, 0x32, 0x64, 0x7C};

// ---- RS485 (UNVERIFIED -- confirm pins against the board). Wired fallback
// to insulate MSG_BEAM_EVENT delivery against ESP-NOW radio failures -- see
// firmware/PROTOCOL.md. Shared multi-drop bus with the gateway/fouling/
// ball-detect/pinsetter nodes; this node acts on nothing it reads -- but it
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

// ---- Per-sensor debounce state ----
bool lastStable[NUM_SENSORS];
bool lastReading[NUM_SENSORS];
unsigned long lastChangeTime[NUM_SENSORS];

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

void sendRegister() {
  NodeMessage msg = {};
  msg.msgType = MSG_REGISTER;
  msg.code = NODE_SPEED;
  msg.laneSide = LaneSide::NONE;   // registration is node-level, not per-side
  sendMessage(msg);
  Serial.println("Sent REGISTER to gateway");
}

void sendBeamEvent(BeamEventCode code, LaneSide side, BeamRole role) {
  NodeMessage msg = {};
  msg.msgType = MSG_BEAM_EVENT;
  msg.code = code;
  msg.laneSide = side;
  msg.data[0] = role;
  sendMessage(msg);
  rs485.enqueue(msg);   // dual-sent: insulates delivery against ESP-NOW failures

  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] Side ");
  Serial.print(laneSideName(side));
  Serial.print(" ");
  Serial.print(beamRoleName(role));
  Serial.println(code == BEAM_BROKEN ? " BROKEN" : " CLEAR");
}

void setup() {
  Serial.begin(9600);
  delay(200);
  randomSeed(esp_random());

  Serial.println();
  Serial.println("Speed node starting");

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
    lastChangeTime[i] = 0;

    Serial.print("Sensor ");
    Serial.print(i);
    Serial.print(" (GPIO");
    Serial.print(SENSOR_PIN[i]);
    Serial.print(", side ");
    Serial.print(laneSideName(SENSOR_SIDE[i]));
    Serial.print(", ");
    Serial.print(beamRoleName(SENSOR_ROLE[i]));
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

      BeamEventCode code = (lastStable[i] == LOW) ? BEAM_BROKEN : BEAM_CLEAR;
      sendBeamEvent(code, SENSOR_SIDE[i], SENSOR_ROLE[i]);
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
