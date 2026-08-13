// ============================================================================
// openlanelink -- RS485 SHARED-BUS LINK
//
// The wired fallback that insulates the WHOLE mesh against ESP-NOW radio
// failures -- one shared multi-drop bus, not point-to-point links (the ESP32
// only has one spare HardwareSerial on the gateway after the Pi link, so a
// star of individual runs isn't physically possible). Carries the exact same
// NodeMessage struct ESP-NOW does, framed per lanelink_protocol.h.
//
// ONE COPY, SHARED BY EVERY SKETCH -- same rule as lanelink_protocol.h. See
// that file's header comment for the install step.
//
// Per-board wiring (RS485_ENABLED, TX/RX pins, baud) stays in each sketch:
// those are hardware facts about one board. Everything here is bus behavior,
// which must be identical on every node sharing the wire.
// ============================================================================

#pragma once

#include <Arduino.h>
#include <HardwareSerial.h>

#include "lanelink_protocol.h"   // same library folder -- quoted include is correct here

// Bus timing. RS485 is half-duplex with no arbitration, so a transmitter
// waits for the bus to look idle and then adds random jitter, so two nodes
// that started waiting at the same moment don't collide again on retry.
#define RS485_IDLE_MS       15
#define RS485_JITTER_MAX_MS 20
#define RS485_MAX_QUEUE     8

inline uint8_t rs485Checksum(uint8_t len, const uint8_t *payload) {
  uint8_t sum = len;
  for (uint8_t i = 0; i < len; i++) sum ^= payload[i];
  return sum;
}

// One node's endpoint on the bus. Construct with the board's HardwareSerial
// and whether the transceiver is actually populated; every method is a no-op
// when it isn't, so a node with no RS485 hardware needs no #if guards.
class Rs485Link {
 public:
  Rs485Link(HardwareSerial &port, bool enabled) : _port(port), _enabled(enabled) {}

  bool enabled() const { return _enabled; }

  void begin(unsigned long baud, int rxPin, int txPin) {
    if (!_enabled) return;
    _port.begin(baud, SERIAL_8N1, rxPin, txPin);
  }

  // Queues a message for transmission. Never writes to the port directly --
  // processQueue() owns that, so collision avoidance can't be bypassed by a
  // caller sending from inside an interrupt or a tight loop. Drops the
  // OLDEST frame when full: on a bus carrying live sensor edges, a stale
  // queued event is worth less than the one that just happened.
  void enqueue(const NodeMessage &msg) {
    if (!_enabled) return;
    if (_count >= RS485_MAX_QUEUE) {
      _head = (_head + 1) % RS485_MAX_QUEUE;
      _count--;
    }
    uint8_t *frame = _queue[_tail];
    frame[0] = RS485_FRAME_START;
    frame[1] = sizeof(NodeMessage);
    memcpy(frame + 2, &msg, sizeof(NodeMessage));
    frame[2 + sizeof(NodeMessage)] = rs485Checksum(sizeof(NodeMessage), frame + 2);
    _queueLen[_tail] = RS485_FRAME_SIZE;

    _tail = (_tail + 1) % RS485_MAX_QUEUE;
    _count++;
  }

  // Call every loop(). Sends at most one queued frame per pass, and only
  // when the bus has been quiet for RS485_IDLE_MS.
  void processQueue() {
    if (!_enabled || _count == 0) return;
    unsigned long now = millis();
    bool idle = (now - _lastActivity) > RS485_IDLE_MS;
    if (idle && now >= _nextAttempt) {
      _port.write(_queue[_head], _queueLen[_head]);
      _lastActivity = now;
      _head = (_head + 1) % RS485_MAX_QUEUE;
      _count--;
    } else if (!idle) {
      _nextAttempt = now + RS485_IDLE_MS + random(0, RS485_JITTER_MAX_MS);
    }
  }

  // Call every loop() on EVERY node -- receiver or not. Drains the port,
  // reassembles frames, and hands each verified NodeMessage to onMessage
  // (which may be null; see observeBus() below).
  //
  // This does two jobs, and the second is why even transmit-only nodes must
  // call it: reading the port is the ONLY thing that observes other nodes'
  // traffic, and that observation is what makes processQueue()'s idle
  // detection mean anything on a shared bus. A node that never reads sees
  // only its own transmissions, concludes the bus is quiet whenever it
  // personally hasn't spoken recently, and transmits straight over whatever
  // someone else is sending -- on a half-duplex bus with no arbitration,
  // that corrupts both frames.
  void poll(void (*onMessage)(const NodeMessage &msg) = nullptr) {
    if (!_enabled) return;

    while (_port.available()) {
      _lastActivity = millis();
      uint8_t b = _port.read();

      if (!_sawStart) {
        if (b == RS485_FRAME_START) { _sawStart = true; _haveLen = false; _bufLen = 0; }
        continue;
      }
      if (!_haveLen) {
        _expectedLen = b;
        _haveLen = true;
        _bufLen = 0;
        if (_expectedLen != sizeof(NodeMessage)) { _sawStart = false; }
        continue;
      }
      if (_bufLen < _expectedLen) {
        _buf[_bufLen++] = b;
        continue;
      }

      // b is the checksum byte. On mismatch the whole consumed frame is
      // discarded and scanning resumes from the next byte (not a
      // byte-by-byte rewind) -- same resync tradeoff as the Pi UART link.
      if (b == rs485Checksum(_expectedLen, _buf)) {
        NodeMessage msg;
        memcpy(&msg, _buf, sizeof(msg));
        if (onMessage) onMessage(msg);
      } else {
        Serial.println("RS485 checksum mismatch, dropping frame");
      }
      _sawStart = false;
    }
  }

  // For transmit-only nodes (fouling, speed, ball detect): read the bus
  // purely to keep collision avoidance honest, discarding whatever decodes.
  //
  // Those nodes have no receive path by design -- "nodes are dumb," they
  // emit sensor edges and act on nothing (firmware/HANDOFF.md). But "acts on
  // no messages" and "cannot hear the wire" are different properties, and
  // only the first was ever intended. This gives them the second without the
  // first.
  //
  // CONSEQUENCE FOR WIRING: each of those boards' RS485 RX pin is now
  // REQUIRED, not optional -- it must actually be connected to the
  // transceiver's receiver output. Leaving it floating puts the node right
  // back to transmitting blind (and floating RX may inject noise besides).
  void observeBus() { poll(nullptr); }

 private:
  HardwareSerial &_port;
  bool _enabled;

  // Outbound queue
  uint8_t _queue[RS485_MAX_QUEUE][RS485_FRAME_SIZE];
  uint8_t _queueLen[RS485_MAX_QUEUE] = {};
  int _head = 0, _tail = 0, _count = 0;
  unsigned long _lastActivity = 0;
  unsigned long _nextAttempt = 0;

  // Inbound framer
  uint8_t _buf[sizeof(NodeMessage)];
  uint8_t _bufLen = 0;
  uint8_t _expectedLen = 0;
  bool _haveLen = false;
  bool _sawStart = false;
};
