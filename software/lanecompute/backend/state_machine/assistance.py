"""Staff/maintenance assistance requests.

Deliberately isolated from game_state.py -- this is not game data, it's a
summon-a-human signal. Wired to openlanescheduler ("OpenLane Scheduler"), the
venue's existing scheduling/lane-status system -- a separate project
(dev/GitHub/openlanescheduler), not part of openlanelink. See
../DEVELOPING.md for how the two systems relate: two separate systems,
integrating only at edges like this one.

Publishes to openlanescheduler's EXISTING MQTT service_call topic and
message shape (see its HARDWARE_INTEGRATION.md) rather than inventing a new
integration -- it already has a complete service-call pipeline (Mechanics
module, MongoDB history, staff dashboard) built for exactly this. Its
mqtt-bridge only reads the `lane` field out of this payload today
(everything else is ignored, not an error) -- see its README's message
format table if that ever changes.

Two kinds, because the bowler terminal offers two buttons and they mean
different things to the lane:
- KIND_PROBLEM ("call for problems") -- something is wrong and the party
  can't bowl. This HOLDS the session clock (see session.py) until it's
  resolved, so a party isn't billed for time spent waiting on a jam.
- KIND_SERVICE ("call for a server") -- someone wants food, drinks, or a
  question answered. Staff are summoned exactly the same way, but the lane
  keeps running; nobody stopped bowling.

Resolution is local: a request stays open until something POSTs
.../assistance/{id}/resolve on this service. openlanescheduler's own
service-call state is deliberately NOT read back here -- that would make a
lane's clock depend on a second system being reachable, and this compute
node is meant to keep working with the scheduler down (same reasoning as
session.py owning the clock at all). Resolving there and resolving here are
two separate acts today; see ../DEVELOPING.md.
"""

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass

import paho.mqtt.client as mqtt  # pinned <2.0 in requirements.txt -- v2 requires an
                                    # explicit callback_api_version and changed callback
                                    # signatures; these callbacks match the 1.x API.

log = logging.getLogger(__name__)

MQTT_BROKER_HOST = os.environ.get("MQTT_BROKER_HOST", "localhost")
MQTT_BROKER_PORT = int(os.environ.get("MQTT_BROKER_PORT", "1883"))
DEVICE_ID = "openlanelink-scoring"

KIND_PROBLEM = "problem"
KIND_SERVICE = "service"
KINDS = (KIND_PROBLEM, KIND_SERVICE)

_client = mqtt.Client(client_id=f"openlanelink-scoring-{uuid.uuid4().hex[:6]}")
_connected = False


def _on_connect(client, userdata, flags, rc):
    global _connected
    _connected = rc == 0
    if _connected:
        log.info("Connected to MQTT broker at %s:%d", MQTT_BROKER_HOST, MQTT_BROKER_PORT)
    else:
        log.warning("MQTT connect failed, rc=%s", rc)


def _on_disconnect(client, userdata, rc):
    global _connected
    _connected = False
    log.warning("MQTT disconnected (rc=%s) -- paho will attempt to reconnect", rc)


_client.on_connect = _on_connect
_client.on_disconnect = _on_disconnect


def _ensure_connected() -> bool:
    if _connected:
        return True
    try:
        _client.connect(MQTT_BROKER_HOST, MQTT_BROKER_PORT, keepalive=30)
        _client.loop_start()  # background thread; also handles auto-reconnect after a successful first connect
    except OSError as e:
        log.warning("could not reach MQTT broker at %s:%d: %s", MQTT_BROKER_HOST, MQTT_BROKER_PORT, e)
        return False
    return _connected


class UnknownRequestError(KeyError):
    pass


@dataclass
class AssistanceRequest:
    id: str
    lane_number: int
    kind: str
    reason: str | None
    requested_at_ms: int
    resolved_at_ms: int | None = None

    @property
    def open(self) -> bool:
        return self.resolved_at_ms is None

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "reason": self.reason,
            "requestedAtMs": self.requested_at_ms,
            "resolvedAtMs": self.resolved_at_ms,
            "open": self.open,
        }


# In-memory only -- openlanescheduler's MongoDB service_history is the
# durable record once this reaches it; this is just enough state to drive
# the lane's own clock (see has_open_problem) and show the terminal what
# it's still waiting on.
_requests: dict[int, list[AssistanceRequest]] = {}


def request_assistance(lane_number: int, kind: str = KIND_PROBLEM, reason: str | None = None) -> AssistanceRequest:
    if kind not in KINDS:
        raise ValueError(f"unknown assistance kind {kind!r}, expected one of {'/'.join(KINDS)}")
    req = AssistanceRequest(
        id=uuid.uuid4().hex[:8],
        lane_number=lane_number,
        kind=kind,
        reason=reason,
        requested_at_ms=int(time.time() * 1000),
    )
    _requests.setdefault(lane_number, []).append(req)
    log.warning("ASSISTANCE REQUESTED (%s): lane %s%s", kind, lane_number, f" ({reason})" if reason else "")

    # Told, not awaited. _notify_dashboard() reaches another system's MQTT
    # broker, and paho's connect() is synchronous -- called inline from an
    # async request handler it blocks the whole event loop, not just this
    # request, so EVERY lane this compute node serves stalls while one lane
    # tries to reach a broker that might not be there. Measured at ~4.4s
    # against a refused connection, which is 4.4s of a bowler standing at
    # the terminal with no acknowledgement that their call for help
    # registered, on the one button where that matters most.
    #
    # Whether the dashboard hears about it has no bearing on whether the
    # lane's own state is correct: the request is recorded above, the clock
    # is already held, and this service is meant to keep working with
    # openlanescheduler unreachable (see the module docstring). So the
    # notification goes to a background thread and the caller returns
    # immediately. Failures are logged there, same as before.
    threading.Thread(target=_notify_dashboard, args=(req,), daemon=True).start()
    return req


def resolve(lane_number: int, request_id: str) -> AssistanceRequest:
    """Mark one request handled. Resolving an already-resolved request is a
    no-op rather than an error -- staff and the terminal can both clear the
    same call, and the second one through shouldn't see a failure for doing
    what was already done."""
    for req in _requests.get(lane_number, []):
        if req.id == request_id:
            if req.open:
                req.resolved_at_ms = int(time.time() * 1000)
                log.info("ASSISTANCE RESOLVED (%s): lane %s", req.kind, lane_number)
            return req
    raise UnknownRequestError(request_id)


def resolve_all(lane_number: int) -> list[AssistanceRequest]:
    """Clear everything still open on a lane -- what deactivating a lane
    does, so a party leaving mid-call doesn't strand an open request (and,
    for a problem, a paused clock) on the next party's session."""
    now_ms = int(time.time() * 1000)
    cleared = [req for req in _requests.get(lane_number, []) if req.open]
    for req in cleared:
        req.resolved_at_ms = now_ms
    if cleared:
        log.info("ASSISTANCE CLEARED: lane %s (%d open request(s))", lane_number, len(cleared))
    return cleared


def open_requests(lane_number: int) -> list[AssistanceRequest]:
    return [req for req in _requests.get(lane_number, []) if req.open]


def has_open_problem(lane_number: int) -> bool:
    """Whether this lane is waiting on staff for something that stops play
    -- the one question session pausing is driven from (see api.py's
    _sync_session_pause). A pending server call doesn't count: the party is
    still bowling while they wait for their nachos."""
    return any(req.kind == KIND_PROBLEM for req in open_requests(lane_number))


def snapshot(lane_number: int) -> dict:
    """What the bowler terminal needs to show "help is coming" and offer to
    clear it again. Only open requests -- resolved ones are history, and
    nothing on the terminal renders them."""
    return {
        "assistance": [req.snapshot() for req in open_requests(lane_number)],
        "awaitingStaff": has_open_problem(lane_number),
    }


def _notify_dashboard(req: AssistanceRequest) -> None:
    if not _ensure_connected():
        log.warning(
            "MQTT not connected -- assistance request for lane %s NOT delivered to the dashboard",
            req.lane_number,
        )
        return
    topic = f"openlanescheduler/lane/{req.lane_number}/service_call"
    payload = json.dumps({
        "lane": req.lane_number,
        "timestamp": req.requested_at_ms // 1000,  # openlanescheduler's documented format uses Unix seconds
        "origin": "openlanelink",
        "deviceId": DEVICE_ID,
        # Extra fields, ignored by openlanescheduler today -- harmless, and
        # already correct if its bridge ever starts routing a problem call
        # and a server call to different staff.
        "kind": req.kind,
        "requestId": req.id,
        "reason": req.reason,
    })
    _client.publish(topic, payload, qos=1)
