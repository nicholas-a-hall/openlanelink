"""Staff/maintenance assistance requests.

Deliberately isolated from game_state.py -- this is not game data, it's a
summon-a-human signal. Wired to openlanescheduler ("Lunar Lanes"), the
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
"""

import json
import logging
import os
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


@dataclass
class AssistanceRequest:
    id: str
    lane_number: int
    reason: str | None
    requested_at_ms: int


# In-memory only -- openlanescheduler's MongoDB service_history is the
# durable record once this reaches it; this is just enough state for the
# API layer to report back on a request it just created.
_requests: list[AssistanceRequest] = []


def request_assistance(lane_number: int, reason: str | None = None) -> AssistanceRequest:
    req = AssistanceRequest(
        id=uuid.uuid4().hex[:8],
        lane_number=lane_number,
        reason=reason,
        requested_at_ms=int(time.time() * 1000),
    )
    _requests.append(req)
    log.warning("ASSISTANCE REQUESTED: lane %s%s", lane_number, f" ({reason})" if reason else "")
    _notify_dashboard(req)
    return req


def _notify_dashboard(req: AssistanceRequest) -> None:
    if not _ensure_connected():
        log.warning(
            "MQTT not connected -- assistance request for lane %s NOT delivered to the dashboard",
            req.lane_number,
        )
        return
    topic = f"lunarlanes/lane/{req.lane_number}/service_call"
    payload = json.dumps({
        "lane": req.lane_number,
        "timestamp": req.requested_at_ms // 1000,  # openlanescheduler's documented format uses Unix seconds
        "origin": "openlanelink",
        "deviceId": DEVICE_ID,
        "reason": req.reason,  # extra field, ignored by openlanescheduler today -- harmless
    })
    _client.publish(topic, payload, qos=1)
