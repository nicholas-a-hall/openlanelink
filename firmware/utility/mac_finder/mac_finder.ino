// Flash this on the gateway ESP32 to print the MAC address break-beam nodes
// should target when adding it as an ESP-NOW peer.

#include <WiFi.h>

void setup() {
  Serial.begin(9600);
  delay(200);
  WiFi.mode(WIFI_STA);
  Serial.println();
  Serial.print("Gateway MAC address: ");
  Serial.println(WiFi.macAddress());
}

void loop() {}
