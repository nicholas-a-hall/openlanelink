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


async def watch_ball_detected(base_url: str, on_ball_detected) -> None:
    """Runs forever (until cancelled), awaiting on_ball_detected(lane_number)
    once per downstream-beam-broken BeamEvent -- the "ball reached the pins"
    edge, same one state_machine.py's on_downstream_beam() acts on
    independently over its own copy of this feed.

    Covers both a speed_node (two beams; only its downstream/near-pins beam
    is the trigger -- the upstream one is just there for speed pairing,
    which state_machine does on its own) and a future ball_detect_node
    (single beam; by convention it should tag its one beam as
    ROLE_DOWNSTREAM too, since that's the "ball reached the pins" role,
    which makes it indistinguishable from -- and handled identically to --
    speed_node's trigger beam here). ball_detect_node's firmware doesn't
    exist yet (firmware/ball_detect_node/ is still an empty placeholder
    directory); this is the assumption to revisit once it's built.

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
    if msg.get("eventType") != EVENT_BEAM_BROKEN or msg.get("beamRole") != ROLE_DOWNSTREAM:
        return
    await on_ball_detected(msg["laneNumber"])
