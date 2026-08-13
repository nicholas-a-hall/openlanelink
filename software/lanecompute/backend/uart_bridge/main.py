"""Entry point for the standalone UART bridge service.

Runs as its own OS process -- installed via deploy/openlanelink-uart-bridge.service
on the Pi -- completely decoupled from the game state machine process. This
is the only process that owns the pyserial connection to the gateway ESP32;
everything else (game_state, state_machine, the REST/WebSocket API the UI
talks to, in ../state_machine) reaches this service over HTTP/WebSocket
instead. See README.md for the health-check contract and current
integration status.
"""

import logging
import os

import service
import uvicorn
from serial_link import SerialLink

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("uart_bridge")

UART_PORT = os.environ.get("UART_BRIDGE_PORT", "/dev/serial0")
UART_BAUD = int(os.environ.get("UART_BRIDGE_BAUD", "115200"))
HTTP_HOST = os.environ.get("UART_BRIDGE_HTTP_HOST", "0.0.0.0")
HTTP_PORT = int(os.environ.get("UART_BRIDGE_HTTP_PORT", "8100"))


def main():
    link = SerialLink(
        UART_PORT,
        UART_BAUD,
        on_lane_event=service.on_lane_event,
        on_beam_event=service.on_beam_event,
        on_status_event=service.on_status_event,
        on_node_seen=service.on_node_seen,
        on_peer_table_ack=service.on_peer_table_ack,
        # Re-push the peer allowlist whenever the port opens: the gateway may
        # have rebooted, or the allowlist may have been edited, while the link
        # was down. Takes the freshly-opened link explicitly because
        # service.link isn't assigned until set_link() below.
        on_connect=service.push_peer_table,
    )
    service.set_link(link)
    log.info(
        "UART bridge service starting: serial %s @ %d baud, HTTP on %s:%d",
        UART_PORT, UART_BAUD, HTTP_HOST, HTTP_PORT,
    )
    uvicorn.run(service.app, host=HTTP_HOST, port=HTTP_PORT)


if __name__ == "__main__":
    main()
