"""Wire protocol for the gateway <-> Pi UART bridge.

Mirrors firmware/gateway_node/gateway_node.ino and
firmware/speed_node/speed_node.ino. Struct layouts match the ESP32 GCC ABI:
a uint32_t field is 4-byte aligned, which inserts padding after two uint8_t
fields before it. Get this wrong and frames silently misparse -- see
firmware/HANDOFF.md's "Gateway <-> Pi UART bridge" section.
"""

import struct
from dataclasses import dataclass

FRAME_START = 0xAA

# Gateway -> Pi
UART_LANE_EVENT = 0x01
UART_BEAM_EVENT = 0x02
UART_PINSETTER_STATUS = 0x03  # forwards a pinsetter MSG_STATUS verbatim (any StatusCode)
# Pi -> Gateway
UART_PINSETTER_COMMAND = 0x10  # any CommandCode -- generalized from the old cycle-only message
UART_SCORE_EVENT = 0x11

EVENT_CLEAR = 0
EVENT_FOUL = 1
EVENT_REGISTER = 2
EVENT_BEAM_CLEAR = 3
EVENT_BEAM_BROKEN = 4

ROLE_UPSTREAM = 0
ROLE_DOWNSTREAM = 1

# Mirrors firmware/PROTOCOL.md's StatusCode -- MUST match gateway_node.ino
# and pinsetter_node.ino exactly. Only STATUS_CYCLE_COMPLETE is consumed by
# state_machine.py today; the rest decode fine but nothing acts on them yet.
STATUS_RELAY_ACK = 0
STATUS_PULSE_ACK = 1
STATUS_PULSE_COMPLETE = 2
STATUS_ALL_ACK = 3
STATUS_RELAY_FAULT = 4
STATUS_REFUSED_PULSE_ONLY = 5
STATUS_MACHINE_STATUS = 6
STATUS_RESPOT_STUB = 7
STATUS_DI_CHANGE = 8
STATUS_HEARTBEAT = 9
STATUS_CYCLE_COMPLETE = 10

# Mirrors firmware/PROTOCOL.md's CommandCode -- MUST match gateway_node.ino
# and pinsetter_node.ino exactly.
CMD_CYCLE = 0
CMD_POWER_ON = 1
CMD_POWER_OFF = 2
CMD_RERACK = 3
CMD_RESPOT = 4
CMD_STATUS = 5

# '<' = little-endian, explicit pad bytes (Python struct never inserts
# implicit alignment padding the way C does).
_LANE_EVENT_FMT = "<BB2xI"       # eventType, laneNumber, pad, timestampMs  (8 bytes)
_BEAM_EVENT_FMT = "<BBBxI"       # eventType, laneNumber, beamRole, pad, timestampMs (8 bytes)
_STATUS_EVENT_FMT = "<BB2xI"     # statusCode, laneNumber, pad, timestampMs (8 bytes)
_PINSETTER_COMMAND_FMT = "<BB"   # command, laneNumber (2 bytes, no padding)
_SCORE_EVENT_FMT = "<BBHI"       # laneNumber, ballNumber, pinfallMask, timestampMs (8 bytes)

LANE_EVENT_SIZE = struct.calcsize(_LANE_EVENT_FMT)
BEAM_EVENT_SIZE = struct.calcsize(_BEAM_EVENT_FMT)


@dataclass
class LaneEvent:
    event_type: int
    lane_number: int
    timestamp_ms: int

    @classmethod
    def decode(cls, payload: bytes) -> "LaneEvent":
        event_type, lane_number, ts = struct.unpack(_LANE_EVENT_FMT, payload)
        return cls(event_type, lane_number, ts)


@dataclass
class BeamEvent:
    event_type: int  # EVENT_BEAM_BROKEN or EVENT_BEAM_CLEAR
    lane_number: int
    beam_role: int    # ROLE_UPSTREAM or ROLE_DOWNSTREAM
    timestamp_ms: int

    @classmethod
    def decode(cls, payload: bytes) -> "BeamEvent":
        event_type, lane_number, beam_role, ts = struct.unpack(_BEAM_EVENT_FMT, payload)
        return cls(event_type, lane_number, beam_role, ts)


@dataclass
class StatusEvent:
    status_code: int
    lane_number: int  # 0 for node-level status codes (see PROTOCOL.md)
    timestamp_ms: int

    @classmethod
    def decode(cls, payload: bytes) -> "StatusEvent":
        status_code, lane_number, ts = struct.unpack(_STATUS_EVENT_FMT, payload)
        return cls(status_code, lane_number, ts)


def encode_pinsetter_command(command: int, lane_number: int) -> bytes:
    return struct.pack(_PINSETTER_COMMAND_FMT, command, lane_number)


def encode_score_event(lane_number: int, ball_number: int, pinfall_mask: int, timestamp_ms: int) -> bytes:
    return struct.pack(_SCORE_EVENT_FMT, lane_number, ball_number, pinfall_mask, timestamp_ms)
