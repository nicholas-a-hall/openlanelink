"""Framed byte-protocol bridge to the gateway ESP32 over UART.

Frame: [0xAA START][LEN][PAYLOAD (LEN bytes, payload[0] = msg type)][CHECKSUM]
CHECKSUM = XOR of LEN and every PAYLOAD byte. Mirrors gateway_node.ino's
sendToPi()/pollPiLink() exactly -- keep both sides in sync if this changes.
"""

import logging
import threading
import time

import serial

import protocol as p

log = logging.getLogger(__name__)


def _checksum(length: int, payload: bytes) -> int:
    total = length
    for b in payload:
        total ^= b
    return total & 0xFF


class UartBridge:
    # How often to retry opening the port while disconnected -- lets this
    # run (mesh commands just unavailable/503) without real hardware
    # attached, and recovers on its own once a gateway is plugged in.
    RECONNECT_INTERVAL_S = 5.0

    def __init__(self, port: str, baud: int = 115200, on_lane_event=None, on_beam_event=None):
        self._port = port
        self._baud = baud
        self._ser: serial.Serial | None = None
        self._on_lane_event = on_lane_event
        self._on_beam_event = on_beam_event
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._read_loop, daemon=True)

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
            self._ser = serial.Serial(self._port, self._baud, timeout=0.05)
            log.info("UART connected on %s @ %d baud", self._port, self._baud)
            return True
        except serial.SerialException as e:
            log.warning("could not open UART port %s: %s", self._port, e)
            self._ser = None
            return False

    # ---- outbound (Pi -> gateway) ----
    def send_pinsetter_command(self, command: int, lane_number: int):
        self._send_frame(p.UART_PINSETTER_COMMAND, p.encode_pinsetter_command(command, lane_number))

    def send_cycle(self, lane_number: int):
        self.send_pinsetter_command(p.CMD_CYCLE, lane_number)

    def send_rerack(self, lane_number: int):
        self.send_pinsetter_command(p.CMD_RERACK, lane_number)

    def send_score_event(self, lane_number: int, ball_number: int, pinfall_mask: int, timestamp_ms: int):
        self._send_frame(
            p.UART_SCORE_EVENT,
            p.encode_score_event(lane_number, ball_number, pinfall_mask, timestamp_ms),
        )

    def _send_frame(self, msg_type: int, data: bytes):
        if self._ser is None:
            log.warning("UART not connected, dropping outbound frame (msgType=0x%02x)", msg_type)
            return
        payload = bytes([msg_type]) + data
        length = len(payload)
        frame = bytes([p.FRAME_START, length]) + payload + bytes([_checksum(length, payload)])
        try:
            self._ser.write(frame)
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
        else:
            log.warning("unhandled UART message type 0x%02x", msg_type)
