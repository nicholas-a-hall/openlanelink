"""Which ESP-NOW nodes belong to this lane pair's gateway.

THE PI OWNS THIS, THE GATEWAY CACHES IT. Every node hardcodes its
GATEWAY_MAC, so a correctly-flashed node can only ever reach its own gateway
over ESP-NOW unicast -- but a MISflashed one reaches whichever gateway that
MAC names, and the gateway used to accept it permanently and silently. Since
every leaf sketch is now byte-identical across lane pairs (they report side
A/B rather than a lane number -- see lane_map.py), a node bound to the wrong
gateway produces events indistinguishable from the real node's. This registry
is what makes that visible and then stoppable.

Why the Pi and not the gateway: the root of trust in this system is the UART
cable. The Pi is physically wired to exactly one gateway, which is the only
unforgeable "this one is mine" signal available -- every MAC-based claim is
observable by a sniffer and forgeable. So the authoritative list lives here
and is pushed down; the gateway's NVS copy exists only so it can keep
enforcing while the Pi is down.

SCOPE: this governs ESP-NOW only. RS485 frames carry no sender address, so
there is nothing to check them against -- that transport is trusted because
each lane pair has its own physically isolated bus segment. That isolation is
a load-bearing install requirement, not a convention (firmware/PROTOCOL.md,
docs/installation.md).

Two states a MAC can be in:
  - seen but not allowed  -> the operator's work queue (GET /peers/pending)
  - allowed               -> in the table pushed to the gateway
A MAC is never auto-allowed. There is no signal that distinguishes "my
fouling node" from "the neighbouring pair's fouling node" except human
knowledge or physical access, so that call stays with an operator.
"""

import json
import logging
import os
import threading
import time

log = logging.getLogger(__name__)

PEERS_FILE = os.environ.get("UART_BRIDGE_PEERS_FILE", "peers.json")

# Matches the gateway's MAX_PEERS. The whole allowlist is pushed as ONE UART
# frame so applying it is atomic -- there is no way to half-apply a table and
# lock the lane's real nodes out partway through -- and that frame has to fit
# in the gateway's 64-byte payload buffer: 3 + 8*7 = 59 bytes.
MAX_PEERS = 8

# Mirrors gateway_node.ino's NodeSeenStatus.
NODE_UNGOVERNED = 0
NODE_ACCEPTED = 1
NODE_REJECTED_NOT_LISTED = 2
NODE_REJECTED_WRONG_TYPE = 3

STATUS_NAMES = {
    NODE_UNGOVERNED: "ungoverned",
    NODE_ACCEPTED: "accepted",
    NODE_REJECTED_NOT_LISTED: "rejected_not_listed",
    NODE_REJECTED_WRONG_TYPE: "rejected_wrong_type",
}

# Mirrors lanelink_protocol.h's NodeType.
NODE_TYPE_NAMES = {
    0: "fouling",
    1: "pinsetter",
    2: "scoring",
    3: "speed",
    4: "ball_detect",
}


def format_mac(raw: bytes) -> str:
    return ":".join(f"{b:02X}" for b in raw)


def parse_mac(text: str) -> bytes:
    """Accepts AA:BB:CC:DD:EE:FF, with - or no separator, any case."""
    cleaned = text.replace(":", "").replace("-", "").strip()
    if len(cleaned) != 12:
        raise ValueError(f"not a MAC address: {text!r}")
    try:
        return bytes.fromhex(cleaned)
    except ValueError as e:
        raise ValueError(f"not a MAC address: {text!r}") from e


class PeerRegistry:
    """Thread-safe: sightings arrive on SerialLink's background read thread
    while REST handlers mutate the allowlist on the event loop."""

    def __init__(self, path: str = PEERS_FILE):
        self._path = path
        self._lock = threading.Lock()
        self._peers: dict[str, dict] = {}
        self._generation = 0
        # What the gateway last confirmed it applied, from UART_PEER_TABLE_ACK.
        # Divergence from _generation means a push didn't land -- worth
        # surfacing, since the symptom otherwise is a node mysteriously still
        # being refused after an operator allowed it.
        self.gateway_generation: int | None = None
        self.gateway_count: int | None = None
        self._load()

    # ---- persistence ----
    def _load(self) -> None:
        if not os.path.exists(self._path):
            return
        try:
            with open(self._path, encoding="utf-8") as f:
                data = json.load(f)
            self._peers = data.get("peers", {})
            self._generation = data.get("generation", 0)
            log.info("peer registry loaded from %s: %d known, %d allowed, generation %d",
                     self._path, len(self._peers), len(self.allowed()), self._generation)
        except (OSError, json.JSONDecodeError, AttributeError) as e:
            # A corrupt file must not take the bridge down -- losing the
            # allowlist degrades to "ungoverned", which is survivable, whereas
            # refusing to start strands the whole lane pair.
            log.warning("could not read peer registry %s (%s) -- starting empty", self._path, e)
            self._peers = {}

    def _save_locked(self) -> None:
        tmp = f"{self._path}.tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"generation": self._generation, "peers": self._peers}, f, indent=2)
            os.replace(tmp, self._path)   # atomic, so a crash mid-write can't corrupt it
        except OSError as e:
            log.warning("could not persist peer registry to %s: %s", self._path, e)

    # ---- inbound sightings ----
    def record_sighting(self, mac: str, node_type: int, status: int, timestamp_ms: int) -> bool:
        """Called for every UART_NODE_SEEN. Returns True if this was new or
        changed status, i.e. worth an operator's attention."""
        now = time.time()
        with self._lock:
            entry = self._peers.get(mac)
            changed = entry is None or entry.get("lastStatus") != status
            if entry is None:
                entry = {
                    "nodeType": node_type,
                    "allowed": False,
                    "firstSeen": now,
                }
                self._peers[mac] = entry
                log.info("new node on the mesh: %s (%s) -- %s", mac,
                         NODE_TYPE_NAMES.get(node_type, node_type), STATUS_NAMES.get(status, status))
            elif changed:
                log.info("node %s status -> %s", mac, STATUS_NAMES.get(status, status))
            entry["nodeType"] = node_type
            entry["lastStatus"] = status
            entry["lastSeen"] = now
            entry["lastTimestampMs"] = timestamp_ms
            if changed:
                self._save_locked()
        return changed

    def record_gateway_ack(self, generation: int, count: int) -> None:
        self.gateway_generation = generation
        self.gateway_count = count
        if generation != self._generation:
            log.warning("gateway applied allowlist generation %d but ours is %d -- out of sync",
                        generation, self._generation)

    # ---- operator decisions ----
    def allow(self, mac: str, node_type: int | None = None) -> dict:
        with self._lock:
            entry = self._peers.get(mac)
            if entry is None:
                if node_type is None:
                    raise KeyError(mac)   # never seen, and no type given to bind it to
                entry = {"nodeType": node_type, "firstSeen": time.time()}
                self._peers[mac] = entry
            if node_type is not None:
                entry["nodeType"] = node_type
            if not entry.get("allowed"):
                allowed_now = sum(1 for e in self._peers.values() if e.get("allowed"))
                if allowed_now >= MAX_PEERS:
                    raise ValueError(
                        f"allowlist is full ({MAX_PEERS}) -- the whole table must fit in one UART frame"
                    )
            entry["allowed"] = True
            self._generation += 1
            self._save_locked()
            return dict(entry)

    def deny(self, mac: str) -> dict:
        with self._lock:
            entry = self._peers.get(mac)
            if entry is None:
                raise KeyError(mac)
            entry["allowed"] = False
            self._generation += 1
            self._save_locked()
            return dict(entry)

    def forget(self, mac: str) -> None:
        """Drops a MAC entirely. Only meaningful for a node that is gone for
        good -- if it is still powered on it will simply reappear on its next
        10s re-announce, which is the intended behaviour, not a bug."""
        with self._lock:
            if self._peers.pop(mac, None) is None:
                raise KeyError(mac)
            self._generation += 1
            self._save_locked()

    # ---- views ----
    @property
    def generation(self) -> int:
        return self._generation

    def allowed(self) -> list[tuple[str, int]]:
        """The table pushed to the gateway: (mac, nodeType), stable order so a
        no-op re-push doesn't churn the generation the gateway reports back."""
        with self._lock:
            return sorted(
                ((mac, e.get("nodeType", 0)) for mac, e in self._peers.items() if e.get("allowed")),
                key=lambda pair: pair[0],
            )

    def snapshot(self) -> dict:
        with self._lock:
            peers = []
            for mac, e in sorted(self._peers.items()):
                peers.append({
                    "mac": mac,
                    "nodeType": e.get("nodeType"),
                    "nodeTypeName": NODE_TYPE_NAMES.get(e.get("nodeType"), "unknown"),
                    "allowed": bool(e.get("allowed")),
                    "lastStatus": e.get("lastStatus"),
                    "lastStatusName": STATUS_NAMES.get(e.get("lastStatus"), "never_seen"),
                    "firstSeen": e.get("firstSeen"),
                    "lastSeen": e.get("lastSeen"),
                })
            return {
                "generation": self._generation,
                "gatewayGeneration": self.gateway_generation,
                "inSync": self.gateway_generation == self._generation,
                "peers": peers,
            }

    def pending(self) -> list[dict]:
        """Seen on the mesh but not allowed -- the operator's work queue."""
        return [p for p in self.snapshot()["peers"] if not p["allowed"] and p["lastSeen"]]
