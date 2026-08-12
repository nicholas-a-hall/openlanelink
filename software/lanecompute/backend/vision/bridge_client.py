"""WebSocket client for the standalone UART bridge service (../uart_bridge),
subscribing to its /events feed so this daemon can self-trigger a pinfall
capture off ball-detection beam events.

Vision is the side that actually depends on knowing when a ball has been
detected, so per the project's service-boundary convention (see
../state_machine/bridge_client.py's docstring for the mirrored, fuller
pattern -- outbound commands + inbound events) this client glue lives here,
not in uart_bridge or state_machine calling into vision. This copy is
intentionally trimmed: vision only ever consumes events off the bridge, it
never issues commands to it, so there's no outbound half here.

Mirrors ../state_machine/protocol.py's BeamEvent wire constants (just the
two this module needs, not a full protocol.py duplicate -- vision talks
JSON over the bridge's WS feed, not raw serial, so it has no framing/struct
code to duplicate).
"""

import asyncio
import json
import logging

import websockets

log = logging.getLogger(__name__)

WS_RECONNECT_INTERVAL_S = 3.0

EVENT_BEAM_BROKEN = 4
ROLE_DOWNSTREAM = 1
ROLE_BALL_DETECT = 2

# Both roles mean the same thing to THIS daemon -- "a ball just reached the
# pins, start the settle-then-capture clock." They stay distinct on the wire
# only because state_machine pairs the speed node's beams into a mph figure
# and a ball_detect_node's single beam has no partner to pair with (see
# firmware/PROTOCOL.md's MSG_BEAM_EVENT and ../state_machine/main.py's
# on_beam_event). Vision does no pairing at all, so it simply accepts either.
TRIGGER_ROLES = (ROLE_DOWNSTREAM, ROLE_BALL_DETECT)


async def watch_ball_detected(base_url: str, on_ball_detected) -> None:
    """Runs forever (until cancelled), awaiting on_ball_detected(lane_number)
    once per ball-at-the-pins BeamEvent -- see TRIGGER_ROLES above for which
    roles count. state_machine.py acts on the same edges independently over
    its own copy of this feed (on_downstream_beam()/on_ball_detected()).

    Covers a speed_node (two beams; only its downstream/near-pins beam
    triggers -- the upstream one is just there for speed pairing, which
    state_machine does on its own) and a ball_detect_node (a single beam
    sited just before the pin deck, tagged ROLE_BALL_DETECT). Either node
    alone is enough to drive captures; a lane running both produces two
    triggers per ball, which pinfall.py's in-flight guard absorbs (see
    _capture_in_flight there -- that overlap is one of the two cases it
    exists for).

    Reconnects on drop with the same fixed-interval retry
    state_machine/bridge_client.py uses.
    """
    ws_url = base_url.rstrip("/").replace("http://", "ws://").replace("https://", "wss://") + "/events"
    while True:
        try:
            async with websockets.connect(ws_url) as ws:
                log.info("subscribed to UART bridge event feed at %s", ws_url)
                async for raw in ws:
                    await _handle(raw, on_ball_detected)
        except (OSError, websockets.exceptions.WebSocketException) as e:
            log.warning("UART bridge event feed disconnected (%s), retrying in %.0fs", e, WS_RECONNECT_INTERVAL_S)
        await asyncio.sleep(WS_RECONNECT_INTERVAL_S)


async def _handle(raw, on_ball_detected) -> None:
    msg = json.loads(raw)
    if msg.get("type") != "beamEvent":
        return
    if msg.get("eventType") != EVENT_BEAM_BROKEN or msg.get("beamRole") not in TRIGGER_ROLES:
        return
    await on_ball_detected(msg["laneNumber"])
