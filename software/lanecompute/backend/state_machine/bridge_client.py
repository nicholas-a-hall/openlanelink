"""HTTP/WebSocket client for the standalone UART bridge service
(../uart_bridge), replacing this process's former direct pyserial
ownership -- see ../uart_bridge/README.md's "Relationship to state_machine".

Two transports, matching what each direction actually needs:
- Outbound commands (send_cycle/send_rerack/...) are synchronous HTTP
  POSTs. state_machine.py and api.py call these from sync code paths
  (FastAPI route handlers that never await them), exactly like the old
  UartBridge's synchronous pyserial writes -- so this class keeps the same
  synchronous method signatures rather than requiring every call site to
  become async. Failures are logged and swallowed, never raised: callers
  have always been able to assume these no-op safely when the mesh link
  isn't up (see api.py's _bridge_object() docstring).
- Inbound events (LaneEvent/BeamEvent/StatusEvent) and connectivity health
  are consumed on a background asyncio task (run(), started from
  main.py's lifespan) via the bridge's WS /events feed and periodic
  GET /health polling. Running on the same event loop uvicorn owns means
  main.py's callbacks can await api.broadcast_state()/broadcast_event()
  directly -- no thread-safe handoff needed anymore, unlike the old
  in-process UartBridge, which read serial on its own background thread.
"""

import asyncio
import json
import logging

import httpx
import websockets

import protocol as p

log = logging.getLogger(__name__)

HEALTH_POLL_INTERVAL_S = 5.0
WS_RECONNECT_INTERVAL_S = 3.0


class BridgeClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(base_url=self.base_url, timeout=2.0)
        self._reachable = False
        self._uart_connected = False

    @property
    def connected(self) -> bool:
        """Mirrors the old UartBridge.connected -- true only when this
        process can actually get a command to the gateway (bridge service
        reachable AND its own uartConnected), not just "the HTTP server is
        up". Backed by the last GET /health result (see _poll_health), not
        a live check on every call -- same staleness tradeoff the old
        UartBridge had (it only reflected whether the port was open, not a
        real round-trip to the gateway either)."""
        return self._reachable and self._uart_connected

    # ---- outbound (sync, called from route handlers / state_machine.py) ----
    def send_pinsetter_command(self, command: int, lane_number: int, cycle_count: int = 1) -> None:
        self._post("/commands/pinsetter", {"command": command, "lane_number": lane_number, "cycle_count": cycle_count})

    def send_cycle(self, lane_number: int, cycle_count: int = 1) -> None:
        self.send_pinsetter_command(p.CMD_CYCLE, lane_number, cycle_count)

    def send_rerack(self, lane_number: int, cycle_count: int = 2) -> None:
        # Defaults to 2 (safe "sweep + spot fresh") for callers with no
        # real ball-state-derived count. state_machine.py's on_foul()/
        # _record_ball() always pass an explicit count derived from the
        # pinsetter's own reported ball number -- see LaneStateMachine.
        self.send_pinsetter_command(p.CMD_RERACK, lane_number, cycle_count)

    def send_score_event(self, lane_number: int, ball_number: int, pinfall_mask: int, timestamp_ms: int) -> None:
        self._post(
            "/commands/score-event",
            {
                "lane_number": lane_number,
                "ball_number": ball_number,
                "pinfall_mask": pinfall_mask,
                "timestamp_ms": timestamp_ms,
            },
        )

    def _post(self, path: str, body: dict) -> None:
        try:
            resp = self._http.post(path, json=body)
            if resp.status_code >= 400:
                log.warning("bridge rejected %s %s: %s %s", path, body, resp.status_code, resp.text)
        except httpx.HTTPError as e:
            log.warning("UART bridge unreachable, dropping %s %s: %s", path, body, e)

    def close(self) -> None:
        self._http.close()

    # ---- inbound (async background task, started by main.py's lifespan) ----
    async def run(self, on_lane_event=None, on_beam_event=None, on_status_event=None) -> None:
        await asyncio.gather(
            self._poll_health(),
            self._consume_events(on_lane_event, on_beam_event, on_status_event),
        )

    async def _poll_health(self) -> None:
        async with httpx.AsyncClient(base_url=self.base_url, timeout=2.0) as client:
            while True:
                try:
                    resp = await client.get("/health")
                    resp.raise_for_status()
                    body = resp.json()
                    if not self._reachable:
                        log.info("UART bridge service reachable at %s", self.base_url)
                    self._reachable = True
                    self._uart_connected = bool(body.get("uartConnected"))
                except httpx.HTTPError as e:
                    if self._reachable:
                        log.warning("lost contact with UART bridge service: %s", e)
                    self._reachable = False
                    self._uart_connected = False
                await asyncio.sleep(HEALTH_POLL_INTERVAL_S)

    async def _consume_events(self, on_lane_event, on_beam_event, on_status_event) -> None:
        ws_url = self.base_url.replace("http://", "ws://").replace("https://", "wss://") + "/events"
        while True:
            try:
                async with websockets.connect(ws_url) as ws:
                    log.info("subscribed to UART bridge event feed at %s", ws_url)
                    async for raw in ws:
                        await self._dispatch(raw, on_lane_event, on_beam_event, on_status_event)
            except (OSError, websockets.exceptions.WebSocketException) as e:
                log.warning("UART bridge event feed disconnected (%s), retrying in %.0fs", e, WS_RECONNECT_INTERVAL_S)
            await asyncio.sleep(WS_RECONNECT_INTERVAL_S)

    @staticmethod
    async def _dispatch(raw, on_lane_event, on_beam_event, on_status_event) -> None:
        msg = json.loads(raw)
        msg_type = msg.get("type")
        if msg_type == "laneEvent" and on_lane_event:
            await on_lane_event(p.LaneEvent(msg["eventType"], msg["laneNumber"], msg["timestampMs"]))
        elif msg_type == "beamEvent" and on_beam_event:
            await on_beam_event(p.BeamEvent(msg["eventType"], msg["laneNumber"], msg["beamRole"], msg["timestampMs"]))
        elif msg_type == "statusEvent" and on_status_event:
            # ballNumber isn't sent by uart_bridge today (see
            # protocol.py's StatusEvent docstring) -- .get() rather than
            # [] so this doesn't break once it might be, and correctly
            # stays None until then.
            await on_status_event(p.StatusEvent(msg["statusCode"], msg["laneNumber"], msg["timestampMs"], msg.get("ballNumber")))
        else:
            log.warning("unhandled bridge event message: %s", msg)
