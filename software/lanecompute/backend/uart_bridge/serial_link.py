"""Framed byte-protocol transport to the gateway ESP32 over UART.

Frame: [0xAA START][LEN][PAYLOAD (LEN bytes, payload[0] = msg type)][CHECKSUM]
CHECKSUM = XOR of LEN and every PAYLOAD byte. Mirrors gateway_node.ino's
sendToPi()/pollPiLink() exactly -- keep both sides in sync if this changes.

Outbound methods take real LANE NUMBERS and convert to the mesh's A/B sides
(lane_map.py) before encoding. Inbound frames decode to sides and are
translated the other way in service.py, so this class is the boundary where
lane numbers stop and sides begin.

This is the low-level transport only, adapted from
../state_machine/uart_bridge.py now that the bridge is its own process --
service.py wraps it in an HTTP/WebSocket surface for other processes (the
game state machine) to consume instead of importing this class directly.
See README.md for why.
"""

import logging
import threading
import time

import serial

import lane_map
import protocol as p

log = logging.getLogger(__name__)


def _checksum(length: int, payload: bytes) -> int:
    total = length
    for b in payload:
        total ^= b
    return total & 0xFF


class SerialLink:
    # How often to retry opening the port while disconnected -- lets this
    # run (mesh commands just unavailable/503) without real hardware
    # attached, and recovers on its own once a gateway is plugged in.
    RECONNECT_INTERVAL_S = 5.0

    def __init__(self, port: str, baud: int = 115200, on_lane_event=None, on_beam_event=None,
                 on_status_event=None, on_node_seen=None, on_peer_table_ack=None,
                 on_connect=None):
        self.port = port
        self.baud = baud
        self._ser: serial.Serial | None = None
        self._on_lane_event = on_lane_event
        self._on_beam_event = on_beam_event
        self._on_status_event = on_status_event
        self._on_node_seen = on_node_seen
        self._on_peer_table_ack = on_peer_table_ack
        # Fired after the port opens, so the peer allowlist can be re-pushed
        # to a gateway that may have rebooted while we weren't attached. The
        # gateway keeps its own NVS copy, so this is a convergence step rather
        # than a prerequisite -- but without it an allowlist edited while the
        # link was down would never reach the gateway.
        self._on_connect = on_connect
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._read_loop, daemon=True)
        # Monotonic timestamp of the last successfully-checksummed frame,
        # of any type. Exposed so /health can tell "port is open" apart from
        # "the gateway is actually talking" -- a stuck or miswired link can
        # hold the port open with nothing ever arriving.
        self.last_frame_at: float | None = None

    @property
    def connected(self) -> bool:
        return self._ser is not None

    def start(self):
        self._try_connect()
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=1)
        if self._ser is not None:
            self._ser.close()

    def _try_connect(self) -> bool:
        try:
            self._ser = serial.Serial(self.port, self.baud, timeout=0.05)
            log.info("UART connected on %s @ %d baud", self.port, self.baud)
            if self._on_connect:
                try:
                    self._on_connect(self)
                except Exception:
                    log.exception("on_connect hook failed -- link stays up regardless")
            return True
        except serial.SerialException as e:
            log.warning("could not open UART port %s: %s", self.port, e)
            self._ser = None
            return False

    # ---- outbound (Pi -> gateway) ----
    # Callers pass real LANE NUMBERS; the mesh only understands sides, so
    # every outbound path resolves one to the other here, at the last moment
    # before encoding. See lane_map.py. A lane that isn't on this pair is
    # DROPPED rather than guessed at -- guessing would fire a solenoid on
    # the wrong lane.
    def send_pinsetter_command(self, command: int, lane_number: int, cycle_count: int = 1):
        side = lane_map.side_for_lane(lane_number)
        if side is None:
            log.warning("dropping pinsetter command %s for lane %s -- not on this pair %s",
                        command, lane_number, lane_map.describe())
            return
        self._send_frame(p.UART_PINSETTER_COMMAND, p.encode_pinsetter_command(command, side, cycle_count))

    def send_cycle(self, lane_number: int, cycle_count: int = 1):
        self.send_pinsetter_command(p.CMD_CYCLE, lane_number, cycle_count)

    def send_rerack(self, lane_number: int, cycle_count: int = 2):
        # Defaults to 2 (the safe "sweep + spot fresh" option) if a caller
        # doesn't have a real ball-state-derived count to give -- matches
        # the gateway bench console's own rerack default. Callers with real
        # game state (state_machine.py's on_foul()/_record_ball()) always
        # pass an explicit count derived from the pinsetter's own reported
        # ball number.
        self.send_pinsetter_command(p.CMD_RERACK, lane_number, cycle_count)

    def send_peer_table(self, generation: int, entries):
        """Push the authoritative allowlist. One frame, so the gateway applies
        it atomically -- see protocol.encode_peer_table()."""
        self._send_frame(p.UART_PEER_TABLE, p.encode_peer_table(generation, entries))

    def send_score_event(self, lane_number: int, ball_number: int, pinfall_mask: int, timestamp_ms: int):
        side = lane_map.side_for_lane(lane_number)
        if side is None:
            log.warning("dropping score event for lane %s -- not on this pair %s",
                        lane_number, lane_map.describe())
            return
        self._send_frame(
            p.UART_SCORE_EVENT,
            p.encode_score_event(side, ball_number, pinfall_mask, timestamp_ms),
        )

    def _send_frame(self, msg_type: int, data: bytes):
        if self._ser is None:
            log.warning("UART not connected, dropping outbound frame (msgType=0x%02x)", msg_type)
            return
        payload = bytes([msg_type]) + data
        length = len(payload)
        frame = bytes([p.FRAME_START, length]) + payload + bytes([_checksum(length, payload)])
        try:
            _t0 = time.perf_counter()
            n = self._ser.write(frame)
            _dt = time.perf_counter() - _t0
            # Timing is logged because a stalled write is otherwise invisible
            # -- the HTTP route still returns 200 and the frame still goes
            # out, it just takes seconds, which shows up to a user only as
            # "the pinsetter reacts late" with nothing in any log to explain
            # it. See README.md's note on first-write-after-idle stalls.
            log.info("wrote outbound frame (msgType=0x%02x, %d bytes, write took %.3fs): %s", msg_type, n, _dt, frame.hex())
        except serial.SerialException as e:
            log.warning("UART write failed: %s -- marking disconnected", e)
            self._ser = None

    # ---- inbound (gateway -> Pi) ----
    # On a checksum mismatch the whole consumed frame is discarded and
    # scanning resumes from the next byte (not a byte-by-byte rewind) --
    # mirrors gateway_node.ino's pollPiLink() exactly. Adequate for a direct
    # wired point-to-point link (main failure mode: a mid-message connect,
    # not random bit corruption); see the comment there for the tradeoff.
    def _read_loop(self):
        buf = bytearray()
        state = "SEEK_START"
        expected_len = 0
        last_reconnect_attempt = 0.0

        while not self._stop.is_set():
            if self._ser is None:
                now = time.monotonic()
                if now - last_reconnect_attempt > self.RECONNECT_INTERVAL_S:
                    last_reconnect_attempt = now
                    self._try_connect()
                time.sleep(0.5)
                continue

            try:
                chunk = self._ser.read(64)
            except serial.SerialException as e:
                log.warning("UART read failed: %s -- marking disconnected", e)
                self._ser = None
                continue

            if not chunk:
                continue
            for b in chunk:
                if state == "SEEK_START":
                    if b == p.FRAME_START:
                        state = "READ_LEN"
                elif state == "READ_LEN":
                    expected_len = b
                    buf.clear()
                    state = "SEEK_START" if expected_len == 0 else "READ_PAYLOAD"
                elif state == "READ_PAYLOAD":
                    buf.append(b)
                    if len(buf) == expected_len:
                        state = "READ_CHECKSUM"
                elif state == "READ_CHECKSUM":
                    if b == _checksum(expected_len, bytes(buf)):
                        self.last_frame_at = time.monotonic()
                        self._dispatch(bytes(buf))
                    else:
                        log.warning("checksum mismatch, dropping frame")
                    state = "SEEK_START"

    def _dispatch(self, payload: bytes):
        msg_type = payload[0]
        body = payload[1:]
        if msg_type == p.UART_LANE_EVENT:
            if self._on_lane_event:
                self._on_lane_event(p.LaneEvent.decode(body))
        elif msg_type == p.UART_BEAM_EVENT:
            if self._on_beam_event:
                self._on_beam_event(p.BeamEvent.decode(body))
        elif msg_type == p.UART_PINSETTER_STATUS:
            if self._on_status_event:
                self._on_status_event(p.StatusEvent.decode(body))
        elif msg_type == p.UART_NODE_SEEN:
            if self._on_node_seen:
                self._on_node_seen(p.NodeSeenEvent.decode(body))
        elif msg_type == p.UART_PEER_TABLE_ACK:
            if self._on_peer_table_ack:
                self._on_peer_table_ack(p.PeerTableAck.decode(body))
        else:
            log.warning("unhandled UART message type 0x%02x", msg_type)
