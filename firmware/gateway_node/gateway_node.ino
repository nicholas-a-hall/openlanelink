// openlanelink -- GATEWAY NODE
//
// Downstream nodes (fouling, speed, ball detect, pinsetter) register
// themselves on startup by sending MSG_REGISTER, which this node adds as an
// ESP-NOW peer on the fly -- no MACs are hardcoded here. Registration carries
// a nodeType (in the `code` field) so the gateway knows what it just learned
// about.
//
// WHICH NODES BELONG TO THIS GATEWAY is decided by the Pi, not here: it owns
// an allowlist of {MAC, nodeType} and pushes it down over UART, this board
// caches it in NVS and enforces it on every inbound ESP-NOW frame. Every
// registration attempt -- accepted or refused -- is reported upstream as
// UART_NODE_SEEN so an operator can see a node being turned away instead of
// having to guess why a lane is dead. Until a table has ever been pushed the
// gateway stays UNGOVERNED and accepts anyone, exactly as it did before this
// existed. See the "Peer registry" section below.
//
// ONE GATEWAY == ONE LANE PAIR == ONE MESH. Everything on this mesh is
// addressed by which SIDE of the pair it concerns (LaneSide::A /
// LaneSide::B), never by a lane number -- that's what lets every leaf sketch
// be identical on every pair in the house. This gateway is lane-agnostic in
// the strongest sense: it doesn't know, and never learns, which real lanes
// its pair is. Resolving side -> lane number happens exactly once, in
// software, on the Pi (uart_bridge/lane_map.py). Nothing here needs
// per-installation configuration at all.
//
// Fouling nodes send per-side MSG_LANE_EVENT. The gateway does NOT act on a
// FOUL itself -- it forwards the raw event to the Pi verbatim, same as any
// other sensor event, and the Pi (state_machine.py's on_foul()) decides whose
// ball it is and issues the pinsetter rerack itself via
// UART_PINSETTER_COMMAND. (Earlier version: the gateway auto-reracked
// directly off its own per-lane cooldown timer, independent of the Pi's
// actual game state -- removed 2026-08-07, see firmware/HANDOFF.md and
// state_machine/state_machine.py's FOUL_COOLDOWN_S.)
//
// Speed nodes and ball detection nodes both send per-beam MSG_BEAM_EVENT,
// told apart by data[0]'s BeamRole (0/1 = the speed node's paired beams,
// 2 = the ball detection node's single near-pins beam). This gateway does no
// pairing or interval math itself -- it just forwards raw beam events to the
// Pi regardless of role. Pairing upstream/downstream timestamps into a speed
// reading, and acting on a ball reaching the pins, are both timing/scheduling
// logic that lives on the Pi side of the bridge, not in any node's firmware.
//
// The PINSETTER NODE owns the machine config (side -> relays) and all A2
// state (ball, cycling, cooldown). This gateway sends pure semantic
// MSG_COMMAND{code=CommandCode, laneSide}.
//
// DUAL-SEND DEDUPE: every downstream node sends its operational traffic on
// BOTH ESP-NOW and RS485, so with both transports up this node sees every
// message twice. dedupe (DualSendFilter, lanelink_protocol.h) drops the
// second copy -- without it every foul, every ball-detect trigger, and every
// STATUS_CYCLE_COMPLETE reached the Pi doubled. See PROTOCOL.md's
// "Dual-send".
//
// EVERY openlanelink node -- including this one -- sends the SAME
// NodeMessage struct for every purpose (registration, events, commands,
// status, acks, broadcast score). There is no more JSON and no more
// per-message-type struct. See the shared `lanelink` Arduino library
// (firmware/lib/lanelink, installed via
// firmware/tools/install_lanelink_library.ps1 (Windows) or .sh) for the canonical definitions
// and firmware/PROTOCOL.md for the prose reference.
//
// PI LINK: the scoring compute node is a Raspberry Pi wired directly to this
// board's UART2 (pins below, unverified placeholder). This gateway
// TRANSLATES between the mesh and the Pi's UART framing -- it is not a raw
// byte pass-through. The Pi-facing payload LAYOUTS are unchanged by the
// A/B-side rename (same field sizes and offsets), only the meaning of the
// lane byte changed: it now carries a LaneSide, which uart_bridge resolves
// to a real lane number. See firmware/HANDOFF.md's "Gateway <-> Pi UART
// bridge" section and PROTOCOL.md's "Gateway <-> Pi UART boundary" note.
//
// Bench testing: type commands into this node's serial monitor (9600):
//   cycle a          -- fire side A's cycle solenoid once
//   rerack b         -- cycle side B through to a fresh full rack
//   respot a         -- stub on the node, logged + acked only
//   power a on|off   -- latch/release side A's machine power
//   pstatus          -- ask the pinsetter node for a machine_status report
//   status           -- dump this gateway's registered peers
//
// Every payload this node receives or sends is logged to serial at 9600 baud.
//
// Uses the esp32 core 3.3.x ESP-NOW callback signatures: recv takes
// esp_now_recv_info_t* (sender MAC in ->src_addr), send takes
// wifi_tx_info_t* (destination MAC in ->des_addr). Older cores instead pass
// the MAC directly as `const uint8_t *` for both.

#include <esp_now.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <HardwareSerial.h>
#include <Preferences.h>

#include <lanelink_protocol.h>
#include <lanelink_rs485.h>

const bool PINSETTER_ENABLED = true;

// ---- TEMPORARY BENCH-TEST HACK: reroute PiLink onto the USB/console UART
// (UART0) instead of its real UART2/GPIO16-17 wiring, so the binary PiLink
// protocol is reachable over the same USB cable already used for the bench
// console -- no second USB-serial adapter needed. Framed 0xAA binary and
// human Serial.print() text share the wire; the bridge's frame parser
// discards non-0xAA bytes while hunting for a frame start, so console text
// is (mostly) harmless noise to it, but the human console becomes far
// noisier/less readable and BOTH now run at PI_UART_BAUD, not 9600 -- set
// your serial monitor to that baud while this is on. REVERT (set to 0)
// before any real deployment; this is not how the Pi will actually be wired.
#define PILINK_OVER_USB_BENCH_TEST 1

// ---- Pi link (UART2) -- pins UNVERIFIED, confirm against the board ----
#define PI_UART_RX_PIN 16
#define PI_UART_TX_PIN 17
#define PI_UART_BAUD 115200
#if PILINK_OVER_USB_BENCH_TEST
  #define PiLink Serial
#else
  HardwareSerial PiLink(2);
#endif

// ---- RS485 (UART1) -- the shared fallback bus every node taps, insulating
// the whole mesh against ESP-NOW failures. Pins UNVERIFIED, confirm against
// the board. Baud MUST match every other node's. Gated independently of
// ESP-NOW peer registration -- see PROTOCOL.md's "Dual-send" section. Bus
// timing/framing lives in lanelink_rs485.h; only this board's wiring is here. ----
#define RS485_ENABLED 1
#define RS485_TX_PIN 4    // placeholder, verify
#define RS485_RX_PIN 5    // placeholder, verify
#define RS485_BAUD 9600

HardwareSerial RS485Port(1);
Rs485Link rs485(RS485Port, RS485_ENABLED);

uint8_t BROADCAST_MAC[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

// ESP-NOW peers must share a radio channel. This node never joins an AP, so
// it sits here. The pinsetter node pins itself to the same channel (it can
// only do that while on Ethernet -- see the note in pinsetter_node.ino).
#define ESPNOW_CHANNEL 1

// Drops the second copy of every dual-sent message -- see the header comment
// and lanelink_protocol.h's DualSendFilter.
DualSendFilter dedupe;

// ============================================================
// Pi UART payload shapes. LAYOUTS are unchanged by the A/B-side rename (same
// field sizes, same offsets, same struct padding), so state_machine/
// uart_bridge protocol.py's struct format strings need no edit -- but the
// lane byte now carries a LaneSide, not a lane number. uart_bridge resolves
// it to a real lane. These are NOT sent over the mesh, only over the UART
// link to the Pi; this gateway translates NodeMessage into them on the way.
// ============================================================

struct UartLaneEventPayload {   // matches uart_bridge/protocol.py's _LANE_EVENT_FMT
  uint8_t eventType;            // 0 = CLEAR, 1 = FOUL
  uint8_t laneSide;             // LaneSide
  uint32_t timestampMs;
};

struct UartBeamEventPayload {   // matches uart_bridge/protocol.py's _BEAM_EVENT_FMT
  uint8_t eventType;            // 3 = BEAM_CLEAR, 4 = BEAM_BROKEN
  uint8_t laneSide;             // LaneSide
  uint8_t beamRole;
  uint32_t timestampMs;
};

struct UartPinsetterStatusPayload {   // matches uart_bridge/protocol.py's _STATUS_EVENT_FMT
  uint8_t statusCode;                 // StatusCode, see lanelink_protocol.h
  uint8_t laneSide;                   // LaneSide; NONE for node-level codes, see PROTOCOL.md
  uint8_t ballNumber;                 // pinsetter's own reported ball (1 or 2) for laneSide; 0 if unknown/not applicable -- see ballForSide()
  uint32_t timestampMs;
};

struct PinsetterCommandFromPi { // Pi -> gateway, any CommandCode (cycle, rerack, ...)
  uint8_t command;
  uint8_t laneSide;     // LaneSide -- the Pi has already mapped its lane number back to a side
  uint8_t cycleCount;   // CMD_CYCLE/CMD_RERACK only: exact solenoid pulse count the Pi wants run, computed from its own tracked/reported ball state -- the pinsetter no longer derives this itself (see pinsetter_node.ino's execPinsetterCommand). Ignored by other CommandCodes.
};

struct ScoreEventFromPi {       // Pi -> gateway, then broadcast onto the mesh as MSG_SCORE_EVENT
  uint8_t laneSide;             // LaneSide
  uint8_t ballNumber;
  uint16_t pinfallMask;
  uint32_t timestampMs;
};

// ---- Gateway <-> Pi UART framing -- see firmware/HANDOFF.md ----
#define UART_FRAME_START 0xAA

enum UartMsgType : uint8_t {
  // Gateway -> Pi
  UART_LANE_EVENT         = 0x01,
  UART_BEAM_EVENT         = 0x02,
  UART_PINSETTER_STATUS   = 0x03,  // forwards a pinsetter MSG_STATUS verbatim (any StatusCode, including STATUS_CYCLE_COMPLETE)
  UART_NODE_SEEN          = 0x04,  // a node tried to register -- see the peer registry section below
  UART_PEER_TABLE_ACK     = 0x05,  // confirms which allowlist generation is actually live here
  // Pi -> Gateway
  UART_PINSETTER_COMMAND = 0x10,  // any CommandCode -- generalized from the old cycle-only message
  UART_SCORE_EVENT       = 0x11,
  UART_PEER_TABLE        = 0x12,  // the Pi's authoritative allowlist, whole table in one frame
};

// What happened when a node tried to register. Reported to the Pi so an
// operator can see rejections, not just successes -- a node silently refused
// is exactly the symptom that's impossible to diagnose from the lane.
enum NodeSeenStatus : uint8_t {
  NODE_UNGOVERNED          = 0,  // no allowlist configured yet: accepted, see allowlistValid
  NODE_ACCEPTED            = 1,
  NODE_REJECTED_NOT_LISTED = 2,
  NODE_REJECTED_WRONG_TYPE = 3,  // listed MAC, but claiming a different NodeType
};

struct UartNodeSeenPayload {   // matches uart_bridge/protocol.py's _NODE_SEEN_FMT
  uint8_t mac[6];
  uint8_t nodeType;            // NodeType
  uint8_t status;              // NodeSeenStatus
  uint32_t timestampMs;        // 4-byte aligned at offset 8 already -- no padding
};

struct UartPeerTableAckPayload {   // matches uart_bridge/protocol.py's _PEER_TABLE_ACK_FMT
  uint16_t generation;
  uint8_t count;
};

// ============================================================
// Peer registry -- WHICH NODES BELONG TO THIS GATEWAY
//
// Every node hardcodes its GATEWAY_MAC, so a correctly-flashed node can only
// ever reach its own gateway over ESP-NOW unicast. A MISflashed one reaches
// whichever gateway that MAC names, and until this existed the gateway
// accepted it permanently and silently -- and since every leaf sketch is now
// byte-identical across lane pairs (they report side A/B, not lane numbers),
// its events are indistinguishable from the real node's. Hence an allowlist.
//
// The Pi owns that allowlist; this table is a cache of it. The root of trust
// is the UART cable: the Pi is physically wired to exactly one gateway, which
// is the only unforgeable "this one is mine" signal in the system.
//
// SCOPE: enforced on ESP-NOW only. RS485 frames carry no sender address at
// all, so there is nothing to check them against -- that transport is trusted
// because each lane pair has its own physically isolated bus segment. That
// isolation is a load-bearing install requirement, not a convention; see
// firmware/PROTOCOL.md and docs/installation.md.
// ============================================================

#define MAX_PEERS 8

// One table replaces the four type-split registration arrays this file used
// to keep (fouling/speed/ball-detect/pinsetter). An allowlist is inherently
// one MAC->NodeType mapping and enforcement needs a MAC lookup across all
// types on every inbound frame, so splitting by type meant maintaining two
// parallel structures for no gain.
struct PeerEntry {
  uint8_t mac[6];
  uint8_t nodeType;
  bool used;
};

PeerEntry peers[MAX_PEERS];          // nodes actually registered right now
PeerEntry allowlist[MAX_PEERS];      // who the Pi says is allowed to
uint8_t allowlistCount = 0;
uint16_t allowlistGeneration = 0;

// FAIL OPEN UNTIL PROVISIONED, FAIL CLOSED AFTER. False means no allowlist
// has ever been pushed or restored from NVS: accept everything and report it
// as NODE_UNGOVERNED, which is exactly the behavior this gateway had before
// the registry existed. A fresh install therefore still comes up on its own,
// and the Pi can watch who appears before locking anything down. Failing
// closed on an empty NVS instead would brick a lane on any
// provisioning-order mistake -- a much worse default than the status quo.
bool allowlistValid = false;

Preferences prefs;

// Rate-limits UART_NODE_SEEN. Nodes re-register every 10s forever; the Pi
// needs first sighting, status changes, and coarse liveness -- not every beat.
// Sized larger than MAX_PEERS because it also has to hold the strangers being
// rejected, which are the whole reason it exists.
#define NODE_SEEN_REFRESH_MS 30000
#define SEEN_REPORT_SLOTS (MAX_PEERS * 2)

struct SeenReport {
  uint8_t mac[6];
  uint8_t status;
  unsigned long at;
  bool used;
};
SeenReport seenReports[SEEN_REPORT_SLOTS];

uint8_t nextSeq = 0;   // for traceability in logs -- this node's outbound MSG_COMMAND/MSG_SCORE_EVENT aren't acked

// Defined further down; declared here so the call order in this file reads
// top-down rather than depending on the Arduino preprocessor's auto-generated
// prototypes.
void forwardLaneEventToPi(const NodeMessage &msg);
void forwardBeamEventToPi(const NodeMessage &msg);
void forwardStatusToPi(const NodeMessage &msg);
void logMachineRecords(const uint8_t *data);
void handleSerialCommand(String cmd);
void sendToPi(UartMsgType msgType, const uint8_t *data, uint8_t dataLen);

String macToString(const uint8_t *mac) {
  char buf[18];
  snprintf(buf, sizeof(buf), "%02X:%02X:%02X:%02X:%02X:%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(buf);
}

void onDataSent(const wifi_tx_info_t *tx_info, esp_now_send_status_t status) {
  if (status != ESP_NOW_SEND_SUCCESS) {
    Serial.print("[");
    Serial.print(millis());
    Serial.print(" ms] SEND to ");
    Serial.print(macToString(tx_info->des_addr));
    Serial.println(" -- FAILED");
  }
}

bool addPeer(const uint8_t *mac) {
  if (esp_now_is_peer_exist(mac)) return true;
  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, mac, 6);
  peerInfo.channel = 0;   // 0 = use current channel
  peerInfo.encrypt = false;
  return esp_now_add_peer(&peerInfo) == ESP_OK;
}

// ---- Peer registry: allowlist, persistence, registration ----
int findPeerSlot(PeerEntry *table, const uint8_t *mac) {
  for (int i = 0; i < MAX_PEERS; i++) {
    if (table[i].used && memcmp(table[i].mac, mac, 6) == 0) return i;
  }
  return -1;
}

// Decides whether this MAC may join, WITHOUT recording anything -- callers
// report the result to the Pi either way, so a rejection is visible instead
// of being a silent no-op on the lane.
NodeSeenStatus judgeRegistration(const uint8_t *mac, uint8_t nodeType) {
  if (!allowlistValid) return NODE_UNGOVERNED;
  int i = findPeerSlot(allowlist, mac);
  if (i < 0) return NODE_REJECTED_NOT_LISTED;
  // A listed MAC claiming a different role means a misflash or a stale
  // entry. Both are worth stopping rather than quietly re-binding the role.
  if (allowlist[i].nodeType != nodeType) return NODE_REJECTED_WRONG_TYPE;
  return NODE_ACCEPTED;
}

bool isAllowedPeer(const uint8_t *mac) {
  if (!allowlistValid) return true;
  return findPeerSlot(allowlist, mac) >= 0;
}

void persistAllowlist() {
  prefs.begin("lanelink", false);
  prefs.putUShort("gen", allowlistGeneration);
  prefs.putUChar("count", allowlistCount);
  prefs.putBytes("list", allowlist, sizeof(allowlist));
  prefs.end();
}

// Restored before ESP-NOW comes up, so a gateway that boots with the Pi down
// still enforces the last table it was given rather than reverting to
// accepting everyone.
void loadAllowlist() {
  prefs.begin("lanelink", true);
  bool present = prefs.isKey("count");
  if (present) {
    allowlistGeneration = prefs.getUShort("gen", 0);
    allowlistCount = prefs.getUChar("count", 0);
    prefs.getBytes("list", allowlist, sizeof(allowlist));
    allowlistValid = true;
  }
  prefs.end();

  if (!allowlistValid) {
    Serial.println("No peer allowlist in NVS -- UNGOVERNED: accepting any node that registers.");
    Serial.println("  (the Pi will see them via UART_NODE_SEEN and can lock this down)");
    return;
  }
  Serial.print("Peer allowlist restored from NVS: gen ");
  Serial.print(allowlistGeneration);
  Serial.print(", ");
  Serial.print(allowlistCount);
  Serial.println(" entries");
  for (int i = 0; i < MAX_PEERS; i++) {
    if (!allowlist[i].used) continue;
    Serial.print("    "); Serial.print(macToString(allowlist[i].mac));
    Serial.print(" "); Serial.println(nodeTypeName(allowlist[i].nodeType));
  }
}

// Drops a peer that is no longer allowed: removes the ESP-NOW peer entry so
// this gateway stops being able to send TO it, alongside the receive-side
// check in onDataRecv() that stops it being heard FROM.
void revokePeer(int slot) {
  Serial.print("Revoking peer ");
  Serial.println(macToString(peers[slot].mac));
  if (esp_now_is_peer_exist(peers[slot].mac)) esp_now_del_peer(peers[slot].mac);
  peers[slot].used = false;
}

// Called after a new allowlist lands: anything registered but no longer
// listed goes immediately, rather than lingering until it happens to reboot.
void reconcilePeersAgainstAllowlist() {
  for (int i = 0; i < MAX_PEERS; i++) {
    if (!peers[i].used) continue;
    if (!isAllowedPeer(peers[i].mac)) revokePeer(i);
  }
}

void registerPeer(const uint8_t *mac, uint8_t nodeType) {
  if (findPeerSlot(peers, mac) >= 0) return;   // already known, silent

  int slot = -1;
  for (int i = 0; i < MAX_PEERS; i++) {
    if (!peers[i].used) { slot = i; break; }
  }
  if (slot < 0) {
    Serial.println("Peer table full, dropping registration");
    return;
  }
  if (!addPeer(mac)) {
    Serial.print("Failed to add ");
    Serial.print(macToString(mac));
    Serial.println(" as ESP-NOW peer");
    return;
  }

  memcpy(peers[slot].mac, mac, 6);
  peers[slot].nodeType = nodeType;
  peers[slot].used = true;

  Serial.print("Registered ");
  Serial.print(nodeTypeName(nodeType));
  Serial.print(" node ");
  Serial.println(macToString(mac));
}

// The pinsetter is the only node this gateway sends unicast TO, so its MAC
// still needs a direct lookup -- but it comes out of the shared table now
// rather than a field maintained beside it.
bool pinsetterMac(uint8_t *out) {
  for (int i = 0; i < MAX_PEERS; i++) {
    if (peers[i].used && peers[i].nodeType == NODE_PINSETTER) {
      memcpy(out, peers[i].mac, 6);
      return true;
    }
  }
  return false;
}

// Reports a registration attempt upstream. Rate-limited per MAC: a node
// re-announces every 10s forever, and the Pi needs first sighting, any status
// change, and coarse liveness -- not every beat. A status CHANGE always goes
// out immediately, since that's the event an operator is waiting on.
void reportNodeSeen(const uint8_t *mac, uint8_t nodeType, NodeSeenStatus status) {
  unsigned long now = millis();

  // Keyed by MAC in its own table rather than piggybacking on peers[],
  // because the MACs that most need rate-limiting are exactly the REJECTED
  // ones -- a neighbouring pair's misflashed node re-announces every 10s and
  // never earns a peers[] slot, so anything indexed off that table would
  // report it forever.
  int slot = -1, free = -1, oldest = 0;
  for (int i = 0; i < SEEN_REPORT_SLOTS; i++) {
    if (seenReports[i].used && memcmp(seenReports[i].mac, mac, 6) == 0) { slot = i; break; }
    if (!seenReports[i].used && free < 0) free = i;
    if (seenReports[i].at < seenReports[oldest].at) oldest = i;
  }

  if (slot >= 0) {
    if (seenReports[slot].status == status &&
        (now - seenReports[slot].at) < NODE_SEEN_REFRESH_MS) {
      return;   // same status, reported recently -- stay quiet
    }
  } else {
    slot = (free >= 0) ? free : oldest;
    memcpy(seenReports[slot].mac, mac, 6);
    seenReports[slot].used = true;
  }
  seenReports[slot].status = status;
  seenReports[slot].at = now;

  UartNodeSeenPayload p;
  memcpy(p.mac, mac, 6);
  p.nodeType = nodeType;
  p.status = status;
  p.timestampMs = now;
  sendToPi(UART_NODE_SEEN, (const uint8_t *)&p, sizeof(p));
}

void sendPeerTableAck() {
  UartPeerTableAckPayload p;
  p.generation = allowlistGeneration;
  p.count = allowlistCount;
  sendToPi(UART_PEER_TABLE_ACK, (const uint8_t *)&p, sizeof(p));
}

void handleRegister(const uint8_t *mac, uint8_t nodeType) {
  NodeSeenStatus status = judgeRegistration(mac, nodeType);

  // Log only on a state change -- a re-announce from a node we already know
  // is a no-op liveness beat and shouldn't spam the console every 10s.
  bool known = findPeerSlot(peers, mac) >= 0;

  if (status == NODE_ACCEPTED || status == NODE_UNGOVERNED) {
    if (!known) {
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV from ");
      Serial.print(macToString(mac));
      Serial.print(" MSG_REGISTER { nodeType=");
      Serial.print(nodeTypeName(nodeType));
      Serial.print(" }");
      Serial.println(status == NODE_UNGOVERNED ? "  (ungoverned -- no allowlist yet)" : "");
      registerPeer(mac, nodeType);
    }
  } else if (!known) {
    Serial.print("[");
    Serial.print(millis());
    Serial.print(" ms] REFUSED registration from ");
    Serial.print(macToString(mac));
    Serial.print(" as ");
    Serial.print(nodeTypeName(nodeType));
    Serial.println(status == NODE_REJECTED_WRONG_TYPE
                     ? " -- listed with a different nodeType"
                     : " -- not on this gateway's allowlist");
  }

  reportNodeSeen(mac, nodeType, status);
}

// Applies a whole allowlist from the Pi. Arriving as ONE frame is what makes
// this atomic: there is no way to half-apply a table and lock out the lane's
// real nodes partway through.
void applyPeerTable(const uint8_t *payload, uint8_t len) {
  if (len < 3) return;
  uint16_t generation = (uint16_t)(payload[0] | (payload[1] << 8));
  uint8_t count = payload[2];
  if (count > MAX_PEERS) {
    Serial.print("Peer table from Pi has too many entries (");
    Serial.print(count);
    Serial.println("), ignoring");
    return;
  }
  if (len != (uint8_t)(3 + count * 7)) {
    Serial.println("Peer table length mismatch, ignoring");
    return;
  }

  memset(allowlist, 0, sizeof(allowlist));
  for (int i = 0; i < count; i++) {
    const uint8_t *e = payload + 3 + i * 7;
    memcpy(allowlist[i].mac, e, 6);
    allowlist[i].nodeType = e[6];
    allowlist[i].used = true;
  }
  allowlistCount = count;
  allowlistGeneration = generation;
  allowlistValid = true;
  persistAllowlist();

  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] Peer allowlist updated from Pi: generation ");
  Serial.print(generation);
  Serial.print(", ");
  Serial.print(count);
  Serial.println(" entries");

  reconcilePeersAgainstAllowlist();
  sendPeerTableAck();
}


// ---- Downstream sends ----
// MSG_COMMAND and MSG_ACK go out on BOTH ESP-NOW and RS485, unconditionally,
// every time -- always-on redundancy, not failure-detect-then-failover. Each
// transport is gated independently: ESP-NOW on dynamic peer registration,
// RS485 on the hardware simply being present (RS485_ENABLED). See
// PROTOCOL.md's "Dual-send" section.
// cycleCount only matters for CMD_CYCLE/CMD_RERACK (exact solenoid pulse
// count -- see PinsetterCommandFromPi's comment); defaulted to 1 so every
// other CommandCode's call sites don't need to think about it.
void sendPinsetterCommand(CommandCode command, LaneSide side, uint8_t cycleCount = 1) {
  if (!PINSETTER_ENABLED) return;

  NodeMessage msg = {};
  msg.msgType = MSG_COMMAND;
  msg.seq = nextSeq++;
  msg.code = command;
  msg.laneSide = side;
  msg.timestampMs = millis();
  msg.data[0] = cycleCount;

  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] SEND pinsetter MSG_COMMAND { code=");
  Serial.print(commandCodeName(command));
  Serial.print(", side=");
  Serial.print(laneSideName(side));
  if (command == CMD_CYCLE || command == CMD_RERACK) {
    Serial.print(", cycles=");
    Serial.print(cycleCount);
  }
  Serial.println(" }");

  uint8_t mac[6];
  bool haveEspNow = pinsetterMac(mac);
  if (haveEspNow) {
    esp_now_send(mac, (uint8_t *)&msg, sizeof(msg));
  }
  rs485.enqueue(msg);   // no-op if RS485_ENABLED is false

  if (!haveEspNow && !rs485.enabled()) {
    Serial.println("No transport available for pinsetter command (not ESP-NOW registered, RS485 disabled)");
  }
}

void sendStatusAck(uint8_t seq) {
  NodeMessage ack = {};
  ack.msgType = MSG_ACK;
  ack.seq = seq;
  ack.code = MSG_STATUS;
  ack.laneSide = LaneSide::NONE;   // acks are node-level
  ack.timestampMs = millis();

  uint8_t mac[6];
  if (pinsetterMac(mac)) {
    esp_now_send(mac, (uint8_t *)&ack, sizeof(ack));
  }
  rs485.enqueue(ack);
}

// Handles every msgType that can arrive on EITHER transport -- MSG_REGISTER
// is the one exception (ESP-NOW only, needs a MAC to add as a peer; see
// onDataRecv). Called from onDataRecv (ESP-NOW) and the RS485 poll callback
// alike, so a node's message is handled identically no matter which wire it
// came in on. "Messages between nodes stay uniform, regardless of transport."
//
// The dedupe check is here rather than in either transport's own path
// precisely BECAUSE it has to span both: the whole point is catching the
// second copy of a message whose first copy arrived on the other wire.
void handleIncomingNodeMessage(const NodeMessage &msg, const String &via) {
  if (dedupe.seenBefore(msg)) {
    Serial.print("[");
    Serial.print(millis());
    Serial.print(" ms] RECV via ");
    Serial.print(via);
    Serial.print(" ");
    Serial.print(msgTypeName(msg.msgType));
    Serial.print(" (seq=");
    Serial.print(msg.seq);
    Serial.println(") -- duplicate of the other transport's copy, dropped");
    return;
  }

  switch (msg.msgType) {
    case MSG_LANE_EVENT: {
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV via ");
      Serial.print(via);
      Serial.print(" MSG_LANE_EVENT { code=");
      Serial.print(msg.code == LANE_FOUL ? "FOUL" : "CLEAR");
      Serial.print(", side=");
      Serial.print(laneSideName(msg.laneSide));
      Serial.println(" }");

      // No local action on LANE_FOUL -- forwarded as-is, same as CLEAR. The
      // Pi decides whose ball this is and issues the rerack itself (see
      // this file's header comment and state_machine.py's on_foul()).
      forwardLaneEventToPi(msg);
      break;
    }

    case MSG_BEAM_EVENT: {
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV via ");
      Serial.print(via);
      Serial.print(" MSG_BEAM_EVENT { side=");
      Serial.print(laneSideName(msg.laneSide));
      Serial.print(", role=");
      Serial.print(beamRoleName(msg.data[0]));
      Serial.print(", ");
      Serial.print(msg.code == BEAM_BROKEN ? "BROKEN" : "CLEAR");
      Serial.println(" }");

      // No pairing/interval math here -- just forward the raw event. The Pi
      // side of the bridge does the timing/scheduling.
      forwardBeamEventToPi(msg);
      break;
    }

    case MSG_STATUS: {
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV via ");
      Serial.print(via);
      Serial.print(" MSG_STATUS { code=");
      Serial.print(statusCodeName(msg.code));
      Serial.print(", side=");
      Serial.print(laneSideName(msg.laneSide));
      Serial.print(", relayState=0b");
      Serial.print(msg.data[0], BIN);
      Serial.print(", diState=0b");
      Serial.println(msg.data[1], BIN);
      logMachineRecords(msg.data);

      sendStatusAck(msg.seq);
      forwardStatusToPi(msg);
      break;
    }

    default:
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV via ");
      Serial.print(via);
      Serial.print(" -- unexpected msgType ");
      Serial.println(msgTypeName(msg.msgType));
      break;
  }
}

// Rs485Link::poll() hands verified frames here; the transport label is fixed
// because anything arriving on this port came off the RS485 bus by definition.
void onRs485Message(const NodeMessage &msg) {
  handleIncomingNodeMessage(msg, "RS485");
}

// ---- Pi UART bridge ----
// Framed byte protocol (see firmware/HANDOFF.md):
//   [0xAA START][LEN][PAYLOAD (LEN bytes, payload[0] = UartMsgType)][CHECKSUM]
// CHECKSUM = XOR of LEN and every PAYLOAD byte.

uint8_t frameChecksum(uint8_t len, const uint8_t *payload) {
  uint8_t sum = len;
  for (uint8_t i = 0; i < len; i++) sum ^= payload[i];
  return sum;
}

void sendToPi(UartMsgType msgType, const uint8_t *data, uint8_t dataLen) {
  // 64, not 32: a full 8-entry peer table is 3 + 8*7 = 59 payload bytes, and
  // sending the allowlist as ONE frame is what makes applying it atomic.
  uint8_t payload[64];
  if (dataLen + 1 > (uint8_t)sizeof(payload)) {
    Serial.println("Pi UART payload too large, dropping");
    return;
  }
  payload[0] = msgType;
  memcpy(payload + 1, data, dataLen);
  uint8_t len = dataLen + 1;

  PiLink.write(UART_FRAME_START);
  PiLink.write(len);
  PiLink.write(payload, len);
  PiLink.write(frameChecksum(len, payload));
}

void forwardLaneEventToPi(const NodeMessage &msg) {
  UartLaneEventPayload p;
  p.eventType = (msg.code == LANE_FOUL) ? 1 : 0;   // uart_bridge/protocol.py EVENT_FOUL/EVENT_CLEAR
  p.laneSide = (uint8_t)msg.laneSide;
  p.timestampMs = msg.timestampMs;
  sendToPi(UART_LANE_EVENT, (const uint8_t *)&p, sizeof(p));
}

void forwardBeamEventToPi(const NodeMessage &msg) {
  UartBeamEventPayload p;
  p.eventType = (msg.code == BEAM_BROKEN) ? 4 : 3;  // uart_bridge/protocol.py EVENT_BEAM_BROKEN/EVENT_BEAM_CLEAR
  p.laneSide = (uint8_t)msg.laneSide;
  p.beamRole = msg.data[0];
  p.timestampMs = msg.timestampMs;
  sendToPi(UART_BEAM_EVENT, (const uint8_t *)&p, sizeof(p));
}

// Every MSG_STATUS carries every machine's MachineRecord (data[2..17], 4
// bytes each: laneSide, flags, cooldownLo, cooldownHi -- see
// lanelink_protocol.h and pinsetter_node.ino's sendStatusEvent()),
// regardless of which one triggered the message, so this always has fresh
// data no matter which statusCode fired. MACHINE_FLAG_BALL2 is the
// pinsetter's own ball counter. Returns 0 (the wire's "unknown/not
// applicable" sentinel, see uart_bridge/protocol.py's StatusEvent) if the
// side has no record here -- a node-level status or a side this pinsetter
// doesn't own.
uint8_t ballForSide(const NodeMessage &msg, LaneSide side) {
  // LaneSide::NONE is the node-level sentinel, and it's ALSO what an unused
  // MachineRecord slot's side byte reads as (zero-filled), so without this
  // guard a node-level status would spuriously "match" the first empty slot
  // instead of correctly finding nothing.
  if (side == LaneSide::NONE) return 0;
  for (int i = 0; i < MAX_MACHINES_PER_MSG; i++) {
    int off = machineRecordOffset(i);
    if (msg.data[off] == (uint8_t)side) {
      return (msg.data[off + 1] & MACHINE_FLAG_BALL2) ? 2 : 1;
    }
  }
  return 0;
}

void forwardStatusToPi(const NodeMessage &msg) {
  UartPinsetterStatusPayload p;
  p.statusCode = msg.code;
  p.laneSide = (uint8_t)msg.laneSide;
  p.ballNumber = ballForSide(msg, msg.laneSide);
  p.timestampMs = msg.timestampMs;
  sendToPi(UART_PINSETTER_STATUS, (const uint8_t *)&p, sizeof(p));
}

void broadcastScoreEvent(LaneSide side, uint8_t ballNumber, uint16_t pinfallMask, uint32_t timestampMs) {
  NodeMessage msg = {};
  msg.msgType = MSG_SCORE_EVENT;
  msg.seq = nextSeq++;
  msg.code = ballNumber;
  msg.laneSide = side;
  msg.timestampMs = timestampMs;
  msg.data[0] = (uint8_t)(pinfallMask & 0xFF);
  msg.data[1] = (uint8_t)(pinfallMask >> 8);

  Serial.print("[");
  Serial.print(millis());
  Serial.print(" ms] BROADCAST MSG_SCORE_EVENT { side=");
  Serial.print(laneSideName(side));
  Serial.print(", ball=");
  Serial.print(ballNumber);
  Serial.print(", pinfallMask=0b");
  Serial.println(pinfallMask, BIN);

  esp_now_send(BROADCAST_MAC, (const uint8_t *)&msg, sizeof(msg));
  // RS485 is a shared multi-drop bus -- every node on it already receives
  // whatever the gateway sends, so this is broadcast too, not point-to-point.
  // No current node acts on MSG_SCORE_EVENT (see PROTOCOL.md's known gaps),
  // but every receiver's default dispatch case already logs-and-ignores
  // unknown-but-valid msgTypes harmlessly, so there's no reason to withhold
  // it from the one transport that's actually a true broadcast medium.
  rs485.enqueue(msg);
}

void handlePiMessage(uint8_t msgType, const uint8_t *payload, uint8_t len) {
  switch (msgType) {
    case UART_PINSETTER_COMMAND: {
      if (len != sizeof(PinsetterCommandFromPi)) return;
      PinsetterCommandFromPi req;
      memcpy(&req, payload, sizeof(req));
      if (req.command > CMD_STATUS) {
        Serial.print("Unknown CommandCode from Pi: ");
        Serial.println(req.command);
        return;
      }
      Serial.print("[");
      Serial.print(millis());
      Serial.print(" ms] RECV from Pi PinsetterCommandFromPi { command=");
      Serial.print(commandCodeName(req.command));
      Serial.print(", side=");
      Serial.print(laneSideName((LaneSide)req.laneSide));
      Serial.print(", cycles=");
      Serial.print(req.cycleCount);
      Serial.println(" }");
      sendPinsetterCommand((CommandCode)req.command, (LaneSide)req.laneSide, req.cycleCount);
      break;
    }
    case UART_SCORE_EVENT: {
      if (len != sizeof(ScoreEventFromPi)) return;
      ScoreEventFromPi ev;
      memcpy(&ev, payload, sizeof(ev));
      broadcastScoreEvent((LaneSide)ev.laneSide, ev.ballNumber, ev.pinfallMask, ev.timestampMs);
      break;
    }
    case UART_PEER_TABLE: {
      applyPeerTable(payload, len);
      break;
    }
    default:
      Serial.print("Unknown UART message type from Pi: 0x");
      Serial.println(msgType, HEX);
      break;
  }
}

// Scans for frame start, reads LEN + PAYLOAD, verifies checksum. On a
// checksum mismatch the whole consumed frame is discarded and scanning
// resumes from the next byte (not a byte-by-byte rewind) -- adequate for a
// direct wired point-to-point link, where the main failure mode is a
// mid-message connect, not random bit corruption. A pathological byte
// sequence that happens to contain a stray START byte inside a bad frame's
// span can cost one real frame before resync catches up; harmless here since
// every event is tied to a live sensor/photo, not a one-shot ack.
//
// PILINK_OVER_USB_BENCH_TEST ALSO handles the bench console's line-based
// text commands here (2026-08-07), not via a separate pollSerial() call --
// see loop() below. Framed binary (0xAA-prefixed) and human-typed text
// share the exact same Serial stream in that mode, so having two
// independent readers both draining it was a real bug, not just noise: a
// separately-called pollSerial() runs every loop() iteration and
// unconditionally drains whatever's currently buffered as ASCII text --
// since loop() cycles far faster than bytes arrive at 115200 baud,
// pollSerial() won that race essentially every time, silently eating every
// byte of an inbound Pi-link frame as garbage before this function ever
// saw it. Bench-console-typed commands always worked (they never left this
// function's own dispatch); anything sent FROM the Pi never did. Dispatch
// on the first byte of each new "message" instead: 0xAA means a binary
// frame, anything else is bench-console text.
void pollPiLink() {
  static uint8_t buf[65];   // 1 (msgType) + up to 64 payload bytes -- see sendToPi
  static uint8_t bufLen = 0;
  static uint8_t expectedLen = 0;
  static bool haveLen = false;
  static bool sawStart = false;
#if PILINK_OVER_USB_BENCH_TEST
  static String cmdBuf = "";
#endif

  while (PiLink.available()) {
    uint8_t b = PiLink.read();

    if (!sawStart) {
      if (b == UART_FRAME_START) {
        sawStart = true; haveLen = false; bufLen = 0;
      }
#if PILINK_OVER_USB_BENCH_TEST
      else {
        char c = (char)b;
        if (c == '\n' || c == '\r') {
          if (cmdBuf.length() > 0) { handleSerialCommand(cmdBuf); cmdBuf = ""; }
        } else {
          cmdBuf += c;
          if (cmdBuf.length() > 80) cmdBuf = "";
        }
      }
#endif
      continue;
    }
    if (!haveLen) {
      expectedLen = b;
      haveLen = true;
      bufLen = 0;
      if (expectedLen == 0 || expectedLen > sizeof(buf)) { sawStart = false; }
      continue;
    }
    if (bufLen < expectedLen) {
      buf[bufLen++] = b;
      continue;
    }

    // b is the checksum byte
    if (b == frameChecksum(expectedLen, buf)) {
      handlePiMessage(buf[0], buf + 1, expectedLen - 1);
    } else {
      Serial.println("Pi UART checksum mismatch, dropping frame");
    }
    sawStart = false;
  }
}

// ---- MSG_STATUS logging ----
void logMachineRecords(const uint8_t *data) {
  for (int i = 0; i < MAX_MACHINES_PER_MSG; i++) {
    int off = machineRecordOffset(i);
    LaneSide side = (LaneSide)data[off];
    if (side == LaneSide::NONE) continue;   // unused slot
    uint8_t flags = data[off + 1];
    Serial.print("    side "); Serial.print(laneSideName(side));
    Serial.print(" on="); Serial.print((flags & MACHINE_FLAG_ON) ? 1 : 0);
    Serial.print(" cycling="); Serial.print((flags & MACHINE_FLAG_CYCLING) ? 1 : 0);
    Serial.print(" ball="); Serial.print((flags & MACHINE_FLAG_BALL2) ? 2 : 1);
    Serial.print(" pendingCycles="); Serial.print((flags >> MACHINE_PENDING_SHIFT) & MACHINE_PENDING_MASK);
    Serial.print(" cooldownMs="); Serial.println(machineRecordCooldownMs(data, i));
  }
}

// ---- ESP-NOW receive ----
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *incomingData, int len) {
  if (len != sizeof(NodeMessage)) {
    Serial.print("[");
    Serial.print(millis());
    Serial.print(" ms] RECV from ");
    Serial.print(macToString(info->src_addr));
    Serial.print(" -- unexpected length ");
    Serial.println(len);
    return;
  }

  NodeMessage msg;
  memcpy(&msg, incomingData, sizeof(msg));

  // MSG_REGISTER is ESP-NOW only (needs a MAC to add as a peer -- no
  // equivalent concept on a raw RS485 bus) so it's handled here, not in the
  // shared handler. It also deliberately skips the dual-send dedupe: it's
  // never dual-sent, and it repeats every 10s by design.
  if (msg.msgType == MSG_REGISTER) {
    handleRegister(info->src_addr, msg.code);
    return;
  }

  // Enforcement has to happen HERE, not only at registration: ESP-NOW's
  // receive callback fires for any unicast addressed to this board whether or
  // not the sender is in our peer table, so a node that was accepted once and
  // later denied would otherwise keep delivering events forever. Checking
  // every inbound frame is what makes a deny actually take effect.
  //
  // Note there is no equivalent check on the RS485 path: those frames carry
  // no sender address at all, so there is nothing to check. That transport is
  // trusted because each lane pair has its own physically isolated bus
  // segment -- see the peer registry comment near the top of this file.
  if (!isAllowedPeer(info->src_addr)) {
    Serial.print("[");
    Serial.print(millis());
    Serial.print(" ms] DROPPED ");
    Serial.print(msgTypeName(msg.msgType));
    Serial.print(" from unlisted ");
    Serial.println(macToString(info->src_addr));
    return;
  }

  handleIncomingNodeMessage(msg, macToString(info->src_addr));
}

// ---- Serial bench-test console ----
void printStatus() {
  Serial.println("---- gateway status ----");
  Serial.print("Peer allowlist: ");
  if (!allowlistValid) {
    Serial.println("NONE -- UNGOVERNED, any node that registers is accepted");
  } else {
    Serial.print("generation ");
    Serial.print(allowlistGeneration);
    Serial.print(", ");
    Serial.print(allowlistCount);
    Serial.println(" entries");
    for (int i = 0; i < MAX_PEERS; i++) {
      if (!allowlist[i].used) continue;
      Serial.print("    "); Serial.print(macToString(allowlist[i].mac));
      Serial.print("  "); Serial.println(nodeTypeName(allowlist[i].nodeType));
    }
  }
  Serial.println("Registered nodes:");
  int registered = 0;
  for (int i = 0; i < MAX_PEERS; i++) {
    if (!peers[i].used) continue;
    registered++;
    Serial.print("    "); Serial.print(macToString(peers[i].mac));
    Serial.print("  "); Serial.println(nodeTypeName(peers[i].nodeType));
  }
  if (registered == 0) Serial.println("    (none yet)");
  Serial.println("(machine config lives on the pinsetter node -- use pstatus)");
  Serial.println("(this gateway addresses sides A/B only -- it has no lane numbers)");
  Serial.println("------------------------");
}

// Bench console commands take a side (a|b), not a lane number -- this
// gateway has no idea which lanes its pair is. Returns LaneSide::NONE on
// anything unparseable, which every caller reports as a usage error.
LaneSide parseSideArg(String arg) {
  arg.trim();
  if (arg.length() != 1) return LaneSide::NONE;
  return laneSideFromChar(arg.charAt(0));
}

void printUsage() {
  Serial.println("commands: cycle <a|b> | rerack <a|b> | respot <a|b> | power <a|b> on|off | pstatus | status");
}

void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd.length() == 0) return;

  if (cmd == "status") {
    printStatus();
    return;
  }
  if (cmd == "pstatus") {
    sendPinsetterCommand(CMD_STATUS, LaneSide::NONE);
    return;
  }

  if (cmd.startsWith("cycle ")) {
    LaneSide side = parseSideArg(cmd.substring(6));
    if (side == LaneSide::NONE) { printUsage(); return; }
    sendPinsetterCommand(CMD_CYCLE, side, 1);
    return;
  }
  if (cmd.startsWith("rerack ")) {
    LaneSide side = parseSideArg(cmd.substring(7));
    if (side == LaneSide::NONE) { printUsage(); return; }
    // No Pi-tracked ball state available from the bench console -- 2 is the
    // safe default (sweep + spot fresh works regardless of the machine's
    // actual current position; see state_machine.py's rerack cycle-count
    // logic for the real Pi-driven decision).
    sendPinsetterCommand(CMD_RERACK, side, 2);
    return;
  }
  if (cmd.startsWith("respot ")) {
    LaneSide side = parseSideArg(cmd.substring(7));
    if (side == LaneSide::NONE) { printUsage(); return; }
    sendPinsetterCommand(CMD_RESPOT, side);
    return;
  }
  if (cmd.startsWith("power ")) {
    String rest = cmd.substring(6);
    int sp = rest.indexOf(' ');
    if (sp == -1) {
      Serial.println("usage: power <a|b> on|off");
      return;
    }
    LaneSide side = parseSideArg(rest.substring(0, sp));
    String action = rest.substring(sp + 1);
    action.trim();
    if (side == LaneSide::NONE || (action != "on" && action != "off")) {
      Serial.println("usage: power <a|b> on|off");
      return;
    }
    sendPinsetterCommand(action == "on" ? CMD_POWER_ON : CMD_POWER_OFF, side);
    return;
  }

  printUsage();
}

void pollSerial() {
  static String buf = "";
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (buf.length() > 0) { handleSerialCommand(buf); buf = ""; }
    } else {
      buf += c;
      if (buf.length() > 80) buf = "";
    }
  }
}

void setup() {
#if PILINK_OVER_USB_BENCH_TEST
  Serial.begin(PI_UART_BAUD);  // PiLink IS Serial in this mode -- one shared baud, see the flag's comment above
#else
  Serial.begin(115200);
#endif
  delay(200);

  Serial.println();
  Serial.println("Gateway node starting");

#if !PILINK_OVER_USB_BENCH_TEST
  PiLink.begin(PI_UART_BAUD, SERIAL_8N1, PI_UART_RX_PIN, PI_UART_TX_PIN);
#endif
  Serial.print("Pi UART link up at ");
  Serial.print(PI_UART_BAUD);
  Serial.println(" baud");

  randomSeed(esp_random());
  rs485.begin(RS485_BAUD, RS485_RX_PIN, RS485_TX_PIN);
  if (rs485.enabled()) Serial.println("RS485 fallback link up");

  // Before the radio: a gateway booting with the Pi down must still enforce
  // the last allowlist it was given rather than reverting to open.
  loadAllowlist();

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // modem sleep makes ESP-NOW receivers miss packets
  delay(100);  // let the STA netif settle before reading its MAC
  Serial.print("Gateway MAC address: ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init failed");
    return;
  }

  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  Serial.print("ESP-NOW channel: ");
  Serial.println(ESPNOW_CHANNEL);

  esp_now_register_recv_cb(onDataRecv);
  esp_now_register_send_cb(onDataSent);

  // Broadcast peer for score results the Pi emits -- see broadcastScoreEvent().
  if (!addPeer(BROADCAST_MAC)) {
    Serial.println("Failed to add broadcast address as ESP-NOW peer");
  }

  Serial.println("Waiting for nodes to register...");
  printUsage();
}

void loop() {
#if !PILINK_OVER_USB_BENCH_TEST
  // Only a genuinely separate stream from PiLink in real deployment (UART2
  // vs Serial/UART0) -- in bench-test mode pollPiLink() itself handles
  // bench-console text too, see its comment above.
  pollSerial();
#endif
  pollPiLink();
  rs485.poll(onRs485Message);
  rs485.processQueue();
}
