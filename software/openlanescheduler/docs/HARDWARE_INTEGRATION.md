# Lunar Lanes - Hardware Integration Guide

## Overview

This guide explains how to integrate ESP32/ESP8266 microcontrollers and PLCs into the Lunar Lanes management system using MQTT for real-time bidirectional communication.

**Prerequisites:** MQTT must be enabled in your docker-compose setup. By default, MQTT is disabled to keep the stack simple.

### Enable MQTT

Before following this guide, enable MQTT services:

```bash
# Option 1: Environment variable
COMPOSE_PROFILES=mqtt docker-compose up --build

# Option 2: Create/edit .env file in project root
echo "COMPOSE_PROFILES=mqtt" > .env
docker-compose up --build
```

This starts two additional services:
- **mosquitto** - MQTT broker on port 1883
- **mqtt-bridge** - Protocol translator between MQTT and Socket.IO

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Physical Hardware                       │
│  ESP32/ESP8266 Controllers, Sensors, Buttons, Displays      │
└────────────────────────┬────────────────────────────────────┘
                         │ MQTT
                         ▼
              ┌──────────────────────┐
              │   MQTT Broker        │
              │   (Mosquitto)        │
              │   Port 1883/8883     │
              └──────────┬───────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   Node.js Backend    │
              │   MQTT ↔ WebSocket   │
              │   Bridge Service     │
              └──────────┬───────────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
    Manager UI      Kiosk UIs       Redis
```

## Why MQTT?

### Advantages Over Alternatives:

| Feature | MQTT | HTTP Polling | WebSocket |
|---------|------|--------------|-----------|
| Real-time updates | ✅ Push | ❌ Poll (latency) | ✅ Push |
| Bandwidth efficiency | ✅ Low | ❌ High | ⚠️ Medium |
| ESP32 memory usage | ✅ ~40KB | ✅ ~30KB | ❌ ~80KB (Socket.IO) |
| Offline resilience | ✅ QoS, LWT | ❌ Lost messages | ❌ Disconnects |
| Multi-subscriber | ✅ Native | ❌ N/A | ⚠️ Complex |
| Wildcard topics | ✅ Yes | ❌ No | ❌ No |

**Verdict:** MQTT is the clear winner for IoT integration with bowling lane hardware.

---

## MQTT Topic Structure

### Topic Hierarchy

```
lunarlanes/
├── lane/
│   ├── {1-8}/
│   │   ├── status              # Publish: backend → Subscribe: ESP32
│   │   ├── command             # Publish: backend → Subscribe: ESP32
│   │   ├── service_call        # Publish: ESP32 → Subscribe: backend
│   │   ├── sensor/
│   │   │   ├── ball_return     # Publish: ESP32 → Subscribe: backend
│   │   │   ├── pin_reset       # Publish: ESP32 → Subscribe: backend
│   │   │   └── game_complete   # Publish: ESP32 → Subscribe: backend
│   │   └── display/
│   │       ├── next_reservation # Publish: backend → Subscribe: ESP32
│   │       └── current_time     # Publish: backend → Subscribe: ESP32
├── global/
│   ├── time                    # Publish: backend (every minute)
│   ├── emergency_stop          # Publish: backend (safety)
│   └── system_status           # Publish: backend
└── device/
    └── {device_id}/
        ├── online              # Last Will Testament
        └── heartbeat           # Health check
```

### Message Formats (JSON)

#### Lane Status (Backend → ESP32)
**Topic:** `lunarlanes/lane/3/status`
```json
{
  "lane": 3,
  "status": "active",
  "paid": true,
  "maintenance": false,
  "inService": false,
  "party": "Smith Birthday",
  "endTime": "16:00",
  "color": "#39ff14"
}
```

#### Service Call (ESP32 → Backend)
**Topic:** `lunarlanes/lane/3/service_call`
```json
{
  "lane": 3,
  "timestamp": 1708023456,
  "origin": "physical_button",
  "deviceId": "esp32-lane3"
}
```

#### Ball Return Sensor (ESP32 → Backend)
**Topic:** `lunarlanes/lane/3/sensor/ball_return`
```json
{
  "lane": 3,
  "detected": true,
  "timestamp": 1708023456,
  "count": 15
}
```

#### Next Reservation Display (Backend → ESP32)
**Topic:** `lunarlanes/lane/3/display/next_reservation`
```json
{
  "lane": 3,
  "hasReservation": true,
  "party": "Johnson Party",
  "startTime": "18:00",
  "guests": 12,
  "minutesUntil": 45
}
```

---

## Backend Integration

### 1. Install MQTT Dependencies

```bash
cd backend
npm install mqtt
```

### 2. Add MQTT Client to Backend

Create `backend/mqttClient.js`:

```javascript
const mqtt = require('mqtt');
const EventEmitter = require('events');

class MQTTClient extends EventEmitter {
  constructor(brokerUrl = 'mqtt://localhost:1883', options = {}) {
    super();

    this.client = mqtt.connect(brokerUrl, {
      clientId: `lunarlanes-backend-${Date.now()}`,
      clean: true,
      reconnectPeriod: 1000,
      ...options
    });

    this.client.on('connect', () => {
      console.log('[MQTT] Connected to broker');
      this.subscribeToHardware();
    });

    this.client.on('message', (topic, message) => {
      this.handleMessage(topic, message);
    });

    this.client.on('error', (error) => {
      console.error('[MQTT] Error:', error);
    });

    this.client.on('offline', () => {
      console.warn('[MQTT] Broker offline');
    });
  }

  subscribeToHardware() {
    // Subscribe to all service calls
    this.client.subscribe('lunarlanes/lane/+/service_call', { qos: 1 });

    // Subscribe to all sensors
    this.client.subscribe('lunarlanes/lane/+/sensor/#', { qos: 0 });

    // Subscribe to device status
    this.client.subscribe('lunarlanes/device/+/online', { qos: 1 });

    console.log('[MQTT] Subscribed to hardware topics');
  }

  handleMessage(topic, message) {
    try {
      const data = JSON.parse(message.toString());
      const parts = topic.split('/');

      // Service call from hardware button
      if (parts[3] === 'service_call') {
        const lane = parseInt(parts[2]);
        this.emit('serviceCall', { lane, ...data });
      }

      // Ball return sensor
      if (parts[3] === 'sensor' && parts[4] === 'ball_return') {
        const lane = parseInt(parts[2]);
        this.emit('ballReturn', { lane, ...data });
      }

      // Device online/offline
      if (parts[1] === 'device' && parts[3] === 'online') {
        this.emit('deviceStatus', { deviceId: parts[2], online: data.online });
      }

    } catch (err) {
      console.error('[MQTT] Failed to parse message:', err);
    }
  }

  // Publish lane status to hardware
  publishLaneStatus(lane, status) {
    const topic = `lunarlanes/lane/${lane}/status`;
    const payload = {
      lane,
      status: status.status || 'open',
      paid: status.paid || false,
      maintenance: status.maintenance || false,
      inService: status.inService || false,
      party: status.party || null,
      endTime: status.endTime || null,
      color: this.getStatusColor(status)
    };

    this.client.publish(topic, JSON.stringify(payload), {
      qos: 0,
      retain: true  // Devices get last state on connect
    });
  }

  // Publish next reservation for LCD displays
  publishNextReservation(lane, reservation) {
    const topic = `lunarlanes/lane/${lane}/display/next_reservation`;
    const payload = reservation ? {
      lane,
      hasReservation: true,
      party: reservation.party,
      startTime: reservation.start,
      guests: reservation.guests,
      minutesUntil: this.calculateMinutesUntil(reservation.start)
    } : {
      lane,
      hasReservation: false
    };

    this.client.publish(topic, JSON.stringify(payload), { qos: 0, retain: true });
  }

  // Emergency stop all lanes
  emergencyStop() {
    this.client.publish('lunarlanes/global/emergency_stop', JSON.stringify({
      timestamp: Date.now(),
      reason: 'manual_trigger'
    }), { qos: 2 });  // Exactly once delivery
  }

  getStatusColor(status) {
    if (status.maintenance) return '#6b7ea6';
    if (status.inService) return '#ff9500';
    if (status.status === 'active' && status.paid) return '#39ff14';
    if (status.status === 'active' && !status.paid) return '#ff2a2a';
    return '#00b4ff';
  }

  calculateMinutesUntil(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    return Math.floor((target - now) / 60000);
  }

  disconnect() {
    this.client.end();
  }
}

module.exports = MQTTClient;
```

### 3. Integrate with Server

In `backend/server.js`:

```javascript
const MQTTClient = require('./mqttClient');

// Initialize MQTT (add after Redis setup)
const mqttBrokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const mqttClient = new MQTTClient(mqttBrokerUrl);

// Listen for hardware service calls
mqttClient.on('serviceCall', (data) => {
  console.log(`[MQTT] Service call from lane ${data.lane}`);

  // Trigger same handler as kiosk/manager service calls
  handlers.MANAGER_SERVICE_CALL({ lane: data.lane });
});

// Listen for ball return sensors
mqttClient.on('ballReturn', (data) => {
  console.log(`[MQTT] Ball return detected on lane ${data.lane}`);
  // Could auto-increment game count for per-game walk-ins
});

// Listen for device status
mqttClient.on('deviceStatus', (data) => {
  console.log(`[MQTT] Device ${data.deviceId} is ${data.online ? 'online' : 'offline'}`);
});

// Broadcast lane status changes to MQTT
function broadcastLaneStatusToMQTT(lane) {
  const walkIn = getWalkIn(lane);
  const reservation = getCurrentReservation(lane);

  const status = {
    status: walkIn || reservation ? 'active' : 'open',
    paid: walkIn ? walkIn.paid : reservation ? reservation.paid : false,
    maintenance: maint[lane] || false,
    inService: !!serviceCalls[lane],
    party: reservation ? reservation.party : null,
    endTime: reservation ? reservation.end : null
  };

  mqttClient.publishLaneStatus(lane, status);
}

// Call after every state change
function broadcastUpdate(type, data) {
  console.log(`[Broadcast] ${type}:`, JSON.stringify(data).substring(0, 200));
  io.emit('stateUpdate', { type, data, timestamp: Date.now() });

  // Update MQTT if lane-related
  if (data.lane) {
    broadcastLaneStatusToMQTT(data.lane);
  }
}
```

### 4. Add to Docker Compose

Update `docker-compose.yml`:

```yaml
services:
  mosquitto:
    image: eclipse-mosquitto:2
    ports:
      - "1883:1883"
      - "9001:9001"
    volumes:
      - mosquitto-data:/mosquitto/data
      - mosquitto-logs:/mosquitto/log
      - ./mosquitto.conf:/mosquitto/config/mosquitto.conf
    restart: unless-stopped

  backend:
    # ... existing config
    environment:
      # ... existing vars
      - MQTT_BROKER_URL=mqtt://mosquitto:1883
    depends_on:
      - redis
      - mosquitto

volumes:
  mosquitto-data:
  mosquitto-logs:
  # ... existing volumes
```

Create `mosquitto.conf`:

```conf
listener 1883
allow_anonymous true

# WebSocket support (optional, for browser-based MQTT clients)
listener 9001
protocol websockets
```

---

## ESP32/ESP8266 Examples

### Hardware Requirements

**Recommended Development Boards:**
- **ESP32 DevKit V1** - $6-8, dual-core, WiFi + Bluetooth
- **ESP8266 NodeMCU** - $4-6, single-core, WiFi only
- **ESP32-S3** - $10-12, newer, better WiFi

**Common Components:**
- Push buttons (service call) - $0.10 each
- WS2812B RGB LEDs (status indicators) - $0.30 each
- 16x2 LCD display with I2C - $3-5
- IR sensors (ball return detection) - $1-2
- Relay modules (access control) - $2-3

### Example 1: Physical Service Call Button

**Hardware:** ESP32 + Push Button + Pull-down resistor

**Wiring:**
```
ESP32 GPIO 13 ──────┬─── Button ─── 3.3V
                    │
                   10kΩ
                    │
                   GND
```

**Code:**

```cpp
#include <WiFi.h>
#include <PubSubClient.h>

// WiFi credentials
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// MQTT broker
const char* mqtt_server = "192.168.1.100";  // Your backend server IP
const int mqtt_port = 1883;

// Lane configuration
const int LANE_NUMBER = 3;
const char* DEVICE_ID = "esp32-lane3";

// Hardware
const int BUTTON_PIN = 13;
const int LED_PIN = 2;  // Built-in LED

WiFiClient espClient;
PubSubClient client(espClient);

unsigned long lastButtonPress = 0;
const unsigned long debounceDelay = 500;

void setup() {
  Serial.begin(115200);

  pinMode(BUTTON_PIN, INPUT);
  pinMode(LED_PIN, OUTPUT);

  setupWiFi();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);
}

void loop() {
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop();

  // Check service call button
  if (digitalRead(BUTTON_PIN) == HIGH) {
    unsigned long now = millis();
    if (now - lastButtonPress > debounceDelay) {
      lastButtonPress = now;
      sendServiceCall();
    }
  }
}

void setupWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\nWiFi connected");
  Serial.println(WiFi.localIP());
}

void reconnectMQTT() {
  while (!client.connected()) {
    Serial.print("Connecting to MQTT...");

    // Last Will Testament - notify if device goes offline
    String lwt_topic = "lunarlanes/device/" + String(DEVICE_ID) + "/online";
    String lwt_message = "{\"online\":false}";

    if (client.connect(DEVICE_ID, lwt_topic.c_str(), 1, true, lwt_message.c_str())) {
      Serial.println("connected");

      // Publish online status
      client.publish(lwt_topic.c_str(), "{\"online\":true}", true);

      // Subscribe to lane status updates
      String status_topic = "lunarlanes/lane/" + String(LANE_NUMBER) + "/status";
      client.subscribe(status_topic.c_str());

      Serial.println("Subscribed to: " + status_topic);
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" retrying in 5 seconds");
      delay(5000);
    }
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message on topic: ");
  Serial.println(topic);

  // Parse JSON and update local state if needed
  // For example, flash LED when service call is acknowledged
}

void sendServiceCall() {
  String topic = "lunarlanes/lane/" + String(LANE_NUMBER) + "/service_call";

  String payload = "{";
  payload += "\"lane\":" + String(LANE_NUMBER) + ",";
  payload += "\"timestamp\":" + String(millis()) + ",";
  payload += "\"origin\":\"physical_button\",";
  payload += "\"deviceId\":\"" + String(DEVICE_ID) + "\"";
  payload += "}";

  if (client.publish(topic.c_str(), payload.c_str(), false)) {
    Serial.println("Service call sent!");
    flashLED();
  } else {
    Serial.println("Service call failed");
  }
}

void flashLED() {
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_PIN, HIGH);
    delay(100);
    digitalWrite(LED_PIN, LOW);
    delay(100);
  }
}
```

### Example 2: RGB LED Status Indicator

**Hardware:** ESP32 + WS2812B RGB LED

**Code:**

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>

// ... (WiFi and MQTT setup same as Example 1)

// LED Configuration
#define LED_PIN 5
#define NUM_LEDS 1
Adafruit_NeoPixel strip(NUM_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);

// Lane status
struct LaneStatus {
  String status;
  bool paid;
  bool maintenance;
  bool inService;
  uint32_t color;
} laneStatus;

void setup() {
  Serial.begin(115200);
  strip.begin();
  strip.show();

  setupWiFi();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  // Parse lane status JSON
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, payload, length);

  if (error) {
    Serial.println("JSON parse failed");
    return;
  }

  // Update lane status
  laneStatus.status = doc["status"].as<String>();
  laneStatus.paid = doc["paid"];
  laneStatus.maintenance = doc["maintenance"];
  laneStatus.inService = doc["inService"];

  // Convert hex color to RGB
  String colorHex = doc["color"].as<String>();
  laneStatus.color = hexToRGB(colorHex);

  updateLED();
}

uint32_t hexToRGB(String hex) {
  // Remove # if present
  if (hex.startsWith("#")) hex = hex.substring(1);

  long number = strtol(hex.c_str(), NULL, 16);
  int r = (number >> 16) & 0xFF;
  int g = (number >> 8) & 0xFF;
  int b = number & 0xFF;

  return strip.Color(r, g, b);
}

void updateLED() {
  if (laneStatus.inService) {
    // Pulsing amber for service calls
    pulseLED(strip.Color(255, 149, 0), 1000);
  } else {
    // Solid color based on status
    strip.setPixelColor(0, laneStatus.color);
    strip.show();
  }
}

void pulseLED(uint32_t color, int duration) {
  // Breathing effect
  for (int i = 0; i < 255; i += 5) {
    strip.setPixelColor(0, strip.gamma32(strip.Color(
      (color >> 16 & 0xFF) * i / 255,
      (color >> 8 & 0xFF) * i / 255,
      (color & 0xFF) * i / 255
    )));
    strip.show();
    delay(duration / 100);
  }
}
```

### Example 3: LCD Display for Next Reservation

**Hardware:** ESP32 + 16x2 I2C LCD

**Code:**

```cpp
#include <WiFi.h>
#include <PubSubClient.h>
#include <LiquidCrystal_I2C.h>
#include <ArduinoJson.h>

// ... (WiFi and MQTT setup)

LiquidCrystal_I2C lcd(0x27, 16, 2);  // I2C address 0x27, 16 cols, 2 rows

void setup() {
  Serial.begin(115200);

  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Lane " + String(LANE_NUMBER));

  setupWiFi();
  client.setServer(mqtt_server, mqtt_port);
  client.setCallback(mqttCallback);
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String topicStr = String(topic);

  if (topicStr.endsWith("/display/next_reservation")) {
    StaticJsonDocument<512> doc;
    deserializeJson(doc, payload, length);

    lcd.clear();

    if (doc["hasReservation"]) {
      // Line 1: Party name
      lcd.setCursor(0, 0);
      String party = doc["party"].as<String>();
      if (party.length() > 16) party = party.substring(0, 13) + "...";
      lcd.print(party);

      // Line 2: Start time and countdown
      lcd.setCursor(0, 1);
      String startTime = doc["startTime"].as<String>();
      int minutesUntil = doc["minutesUntil"];
      lcd.print(startTime + " (" + String(minutesUntil) + "m)");
    } else {
      lcd.setCursor(0, 0);
      lcd.print("No upcoming");
      lcd.setCursor(0, 1);
      lcd.print("reservations");
    }
  }
}
```

### Example 4: Ball Return Sensor

**Hardware:** ESP32 + IR Break Beam Sensor

**Code:**

```cpp
#include <WiFi.h>
#include <PubSubClient.h>

// ... (WiFi and MQTT setup)

const int IR_SENSOR_PIN = 14;
volatile int ballCount = 0;
unsigned long lastDetection = 0;

void setup() {
  Serial.begin(115200);
  pinMode(IR_SENSOR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(IR_SENSOR_PIN), ballDetected, FALLING);

  setupWiFi();
  client.setServer(mqtt_server, mqtt_port);
}

void ballDetected() {
  unsigned long now = millis();
  if (now - lastDetection > 1000) {  // Debounce 1 second
    lastDetection = now;
    ballCount++;

    publishBallReturn();
  }
}

void publishBallReturn() {
  String topic = "lunarlanes/lane/" + String(LANE_NUMBER) + "/sensor/ball_return";

  String payload = "{";
  payload += "\"lane\":" + String(LANE_NUMBER) + ",";
  payload += "\"detected\":true,";
  payload += "\"timestamp\":" + String(millis()) + ",";
  payload += "\"count\":" + String(ballCount);
  payload += "}";

  client.publish(topic.c_str(), payload.c_str());
  Serial.println("Ball return detected. Count: " + String(ballCount));
}
```

---

## PLC Integration

For industrial PLCs (Allen-Bradley, Siemens, etc.), use their native MQTT clients or OPC UA to MQTT gateways.

### Siemens S7-1200/1500

Use the built-in MQTT client:

1. Add MQTT client library in TIA Portal
2. Configure connection to broker
3. Subscribe to `lunarlanes/lane/+/command`
4. Publish to `lunarlanes/lane/{X}/sensor/#`

### Allen-Bradley CompactLogix

Use a Node-RED gateway:

```
PLC (EtherNet/IP) ←→ Node-RED ←→ MQTT Broker
```

---

## Security Considerations

### 1. Enable MQTT Authentication

Update `mosquitto.conf`:

```conf
allow_anonymous false
password_file /mosquitto/config/passwd
```

Create password file:

```bash
mosquitto_passwd -c /path/to/passwd lunarlanes_backend
mosquitto_passwd /path/to/passwd esp32_device
```

### 2. Use TLS/SSL

```conf
listener 8883
cafile /mosquitto/config/ca.crt
certfile /mosquitto/config/server.crt
keyfile /mosquitto/config/server.key
require_certificate false
```

### 3. Access Control Lists (ACL)

Create `acl.conf`:

```conf
# Backend can publish/subscribe to everything
user lunarlanes_backend
topic readwrite #

# ESP32 devices can only publish sensors and subscribe to their lane
user esp32_lane3
topic write lunarlanes/lane/3/service_call
topic write lunarlanes/lane/3/sensor/#
topic read lunarlanes/lane/3/status
topic read lunarlanes/lane/3/display/#
```

### 4. Network Isolation

- Put ESP32 devices on separate VLAN
- Firewall rules: Allow only 1883 → broker
- No internet access for IoT VLAN

---

## Deployment Checklist

- [ ] **Enable MQTT profile** in docker-compose (`COMPOSE_PROFILES=mqtt`)
- [ ] MQTT broker running and accessible
- [ ] MQTT bridge connected to both broker and backend
- [ ] Test service call from MQTT client (mosquitto_pub)
- [ ] Verify lane status published on state changes
- [ ] ESP32 devices can connect and authenticate
- [ ] Test physical button → service call → dashboard
- [ ] Test dashboard action → MQTT → LED update
- [ ] Set up device monitoring/alerts
- [ ] Document all device IDs and locations
- [ ] Create backup/restore procedure for MQTT config

---

## Troubleshooting

### ESP32 Can't Connect to Broker

```bash
# Test broker accessibility
mosquitto_sub -h <broker_ip> -t lunarlanes/# -v

# Check broker logs
docker logs -f <mosquitto_container>
```

### Messages Not Appearing

- Check topic subscriptions match publish topics
- Verify QoS levels (use QoS 1 for critical messages)
- Check retained flag for status messages

### High Latency

- Reduce message frequency
- Use smaller JSON payloads
- Increase `keepalive` interval

---

## Next Steps

1. **Start with one lane** - Proof of concept
2. **Add service call button** - Immediate value
3. **Add LED status indicator** - Visual feedback
4. **Scale to all 8 lanes** - Roll out gradually
5. **Add sensors** - Ball return, scoring
6. **Integrate with scoring system** - Auto-game detection

---

## Cost Estimate

| Item | Quantity | Unit Cost | Total |
|------|----------|-----------|-------|
| ESP32 DevKit | 8 | $7 | $56 |
| Service call buttons | 8 | $0.10 | $0.80 |
| WS2812B RGB LEDs | 8 | $0.30 | $2.40 |
| 16x2 LCD displays (optional) | 8 | $4 | $32 |
| IR sensors (optional) | 8 | $1.50 | $12 |
| Power supplies (5V 2A) | 8 | $3 | $24 |
| Enclosures | 8 | $5 | $40 |
| Wiring/connectors | - | - | $20 |
| **Total** | | | **$187.20** |

**ROI:** Improved customer experience, reduced staff workload, real-time lane monitoring.

---

## Support

For questions or issues with hardware integration:
- Check backend logs: `docker logs -f lunarlanes-backend`
- Check MQTT logs: `docker logs -f lunarlanes-mosquitto`
- Monitor MQTT traffic: `mosquitto_sub -h localhost -t lunarlanes/# -v`

---

**Document Version:** 1.0
**Last Updated:** 2026-02-15
