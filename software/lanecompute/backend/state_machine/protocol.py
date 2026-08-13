"""Event shapes and mesh constants for the UART bridge's JSON feed.

THIS PROCESS SPEAKS LANE NUMBERS. It reaches the mesh only through
../uart_bridge's HTTP/WebSocket surface (see bridge_client.py), never over
serial, and that service resolves the mesh's A/B lane sides to real lane
numbers before anything reaches this feed (../uart_bridge/lane_map.py). So
the dataclasses here carry `lane_number`, and nothing in this process ever
sees a lane side.

That is also why this file is NO LONGER a byte-for-byte duplicate of
../uart_bridge/protocol.py, which it used to be. The two now describe
genuinely different things: that one is the raw wire (sides, struct
layouts, framing), this one is the bridge's decoded JSON feed (lane
numbers). The constants they share -- EVENT_*, ROLE_*, STATUS_*, CMD_* --
are still duplicated deliberately and must be kept in step by hand.

The struct-packing helpers below are vestigial here: this process posts
JSON, so nothing in it packs a frame. They're kept for now because they
document the wire the bridge is speaking on this process's behalf; see
firmware/PROTOCOL.md for the authoritative version.
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
# ball_detect_node.ino's single near-pins beam. Deliberately NOT reported as
# ROLE_DOWNSTREAM even though it means the same physical thing ("the ball
# reached the pins"): 0/1 are the speed node's PAIRED beams, and main.py's
# on_beam_event() pops its pending upstream timestamp on any downstream edge.
# A ball-detect beam wearing that role would consume the pairing and report a
# fabricated ball speed on a lane covered by both nodes.
ROLE_BALL_DETECT = 2

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
_STATUS_EVENT_FMT = "<BBBxI"     # statusCode, laneNumber, ballNumber, pad, timestampMs (8 bytes)
_PINSETTER_COMMAND_FMT = "<BBB"  # command, laneNumber, cycleCount (3 bytes, no padding)
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
    beam_role: int    # ROLE_UPSTREAM, ROLE_DOWNSTREAM, or ROLE_BALL_DETECT
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
    # The pinsetter's own reported ball (1 or 2) for lane_number, decoded
    # from MSG_STATUS's MachineRecord.flags ball bit -- the gateway
    # extracts it (gateway_node.ino's ballForSide()/forwardStatusToPi()) and
    # ../uart_bridge/service.py's on_status_event() puts it on the feed.
    # None for the wire's 0 sentinel (node-level status, or a side with no
    # matching MachineRecord in this particular MSG_STATUS). This is the
    # ground truth LaneStateMachine.reconcile_ball_number() uses to decide
    # rerack cycle counts (state_machine.py).
    ball_number: int | None = None

    @classmethod
    def decode(cls, payload: bytes) -> "StatusEvent":
        status_code, lane_number, ball_number, ts = struct.unpack(_STATUS_EVENT_FMT, payload)
        return cls(status_code, lane_number, ts, ball_number or None)


def encode_pinsetter_command(command: int, lane_number: int, cycle_count: int = 1) -> bytes:
    # cycle_count only matters for CMD_CYCLE/CMD_RERACK -- see
    # gateway_node.ino's sendPinsetterCommand()/PinsetterCommandFromPi.
    # Defaulted to 1 so callers issuing CMD_POWER_ON/OFF/CMD_STATUS/
    # CMD_RESPOT don't need to think about it.
    return struct.pack(_PINSETTER_COMMAND_FMT, command, lane_number, cycle_count)


def encode_score_event(lane_number: int, ball_number: int, pinfall_mask: int, timestamp_ms: int) -> bytes:
    # timestampMs is a uint32 on the wire, and every mesh node fills it with
    # its own millis() -- an uptime counter that wraps at ~49.7 days, NOT a
    # Unix epoch timestamp (see firmware/PROTOCOL.md's NodeMessage). Masking
    # to 32 bits keeps that contract and, importantly, makes it impossible
    # for a caller passing epoch-ms to blow the whole message up: that used
    # to raise struct.error inside the bridge's route handler, so every
    # single score event 500'd and nothing on the mesh ever saw one -- a
    # failure that was invisible from state_machine's side, since its
    # _post() only logs a warning and moves on. Callers should still pass a
    # monotonic ms value (see state_machine.py's _record_ball).
    return struct.pack(_SCORE_EVENT_FMT, lane_number, ball_number, pinfall_mask, timestamp_ms & 0xFFFFFFFF)
