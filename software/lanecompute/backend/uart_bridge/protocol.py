"""Wire protocol for the gateway <-> Pi UART bridge.

Mirrors firmware/gateway_node/gateway_node.ino's Uart*Payload structs.
Struct layouts match the ESP32 GCC ABI: a uint32_t field is 4-byte aligned,
which inserts padding after two uint8_t fields before it. Get this wrong and
frames silently misparse -- see firmware/HANDOFF.md's "Gateway <-> Pi UART
bridge" section.

THIS FILE SPEAKS SIDES, NOT LANE NUMBERS. The mesh addresses everything by
which side of a lane pair it concerns (SIDE_A/SIDE_B below), so the decoded
events here carry `lane_side`. lane_map.py resolves those to real lane
numbers, and service.py does that translation before anything leaves this
process -- so the /events feed and the REST surface stay in lane numbers and
every consumer upstream (state_machine, vision, the UI) was unaffected by
the mesh dropping lane numbers.

That translation is also why this file is NO LONGER a byte-for-byte
duplicate of ../state_machine/protocol.py, which it used to be. The two now
describe genuinely different things: this one is the raw wire (sides), that
one is this service's JSON feed (lane numbers). Constants they share
(EVENT_*, ROLE_*, STATUS_*, CMD_*) must still be kept in step by hand.
"""

import struct
from dataclasses import dataclass

FRAME_START = 0xAA

# Gateway -> Pi
UART_LANE_EVENT = 0x01
UART_BEAM_EVENT = 0x02
UART_PINSETTER_STATUS = 0x03  # forwards a pinsetter MSG_STATUS verbatim (any StatusCode)
UART_NODE_SEEN = 0x04  # a node tried to register -- see peer_registry.py
UART_PEER_TABLE_ACK = 0x05  # which allowlist generation is actually live on the gateway
# Pi -> Gateway
UART_PINSETTER_COMMAND = 0x10  # any CommandCode -- generalized from the old cycle-only message
UART_SCORE_EVENT = 0x11
UART_PEER_TABLE = 0x12  # the authoritative allowlist, whole table in one frame

EVENT_CLEAR = 0
EVENT_FOUL = 1
EVENT_REGISTER = 2
EVENT_BEAM_CLEAR = 3
EVENT_BEAM_BROKEN = 4

# Mirrors lanelink_protocol.h's LaneSide. A gateway's mesh is exactly one
# lane pair, so the wire only ever names a side; see lane_map.py for how
# these become real lane numbers. SIDE_NONE keeps the value 0 had as the old
# laneNumber field's "node-level / not lane-specific" sentinel, so every
# `== 0` check on either side of the wire kept its meaning through the
# rename.
SIDE_NONE = 0
SIDE_A = 1
SIDE_B = 2

ROLE_UPSTREAM = 0
ROLE_DOWNSTREAM = 1
# ball_detect_node.ino's single near-pins beam. Deliberately NOT reported as
# ROLE_DOWNSTREAM even though it means the same physical thing ("the ball
# reached the pins"): 0/1 are the speed node's PAIRED beams, and
# ../state_machine/main.py's on_beam_event() pops its pending upstream
# timestamp on any downstream edge. A ball-detect beam wearing that role
# would consume the pairing and report a fabricated ball speed on a lane
# covered by both nodes.
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
#
# LAYOUTS ARE UNCHANGED by the A/B-side rename -- same field sizes, same
# offsets, same padding. Only the meaning of the lane byte changed (a
# LaneSide now, not a lane number), so these format strings did not need to
# move a single character.
_LANE_EVENT_FMT = "<BB2xI"       # eventType, laneSide, pad, timestampMs  (8 bytes)
_BEAM_EVENT_FMT = "<BBBxI"       # eventType, laneSide, beamRole, pad, timestampMs (8 bytes)
_STATUS_EVENT_FMT = "<BBBxI"     # statusCode, laneSide, ballNumber, pad, timestampMs (8 bytes)
_PINSETTER_COMMAND_FMT = "<BBB"  # command, laneSide, cycleCount (3 bytes, no padding)
_SCORE_EVENT_FMT = "<BBHI"       # laneSide, ballNumber, pinfallMask, timestampMs (8 bytes)
_NODE_SEEN_FMT = "<6sBBI"        # mac, nodeType, status, timestampMs (12 bytes, no pad needed)
_PEER_TABLE_ACK_FMT = "<HB"      # generation, count (3 bytes)
_PEER_ENTRY_FMT = "<6sB"         # mac, nodeType (7 bytes)

LANE_EVENT_SIZE = struct.calcsize(_LANE_EVENT_FMT)
BEAM_EVENT_SIZE = struct.calcsize(_BEAM_EVENT_FMT)


@dataclass
class LaneEvent:
    event_type: int
    lane_side: int  # SIDE_A or SIDE_B -- resolve with lane_map.lane_for_side()
    timestamp_ms: int

    @classmethod
    def decode(cls, payload: bytes) -> "LaneEvent":
        event_type, lane_side, ts = struct.unpack(_LANE_EVENT_FMT, payload)
        return cls(event_type, lane_side, ts)


@dataclass
class BeamEvent:
    event_type: int  # EVENT_BEAM_BROKEN or EVENT_BEAM_CLEAR
    lane_side: int   # SIDE_A or SIDE_B -- resolve with lane_map.lane_for_side()
    beam_role: int   # ROLE_UPSTREAM, ROLE_DOWNSTREAM, or ROLE_BALL_DETECT
    timestamp_ms: int

    @classmethod
    def decode(cls, payload: bytes) -> "BeamEvent":
        event_type, lane_side, beam_role, ts = struct.unpack(_BEAM_EVENT_FMT, payload)
        return cls(event_type, lane_side, beam_role, ts)


@dataclass
class StatusEvent:
    status_code: int
    lane_side: int  # SIDE_NONE for node-level status codes (see PROTOCOL.md)
    timestamp_ms: int
    # The pinsetter's own reported ball (1 or 2) for lane_side, decoded
    # from MSG_STATUS's MachineRecord.flags ball bit -- the gateway
    # extracts and forwards this on every UART_PINSETTER_STATUS frame (see
    # gateway_node.ino's ballForSide()/forwardStatusToPi()). None for
    # the wire's 0 sentinel (node-level status, or a side with no matching
    # MachineRecord in this particular MSG_STATUS).
    ball_number: int | None = None

    @classmethod
    def decode(cls, payload: bytes) -> "StatusEvent":
        status_code, lane_side, ball_number, ts = struct.unpack(_STATUS_EVENT_FMT, payload)
        return cls(status_code, lane_side, ts, ball_number or None)


@dataclass
class NodeSeenEvent:
    """A node tried to register with the gateway. Reported whether it was
    accepted or refused -- a node silently turned away is exactly the symptom
    that's impossible to diagnose from the lane itself."""

    mac: str          # "AA:BB:CC:DD:EE:FF"
    node_type: int    # NodeType
    status: int       # peer_registry.NODE_* -- accepted / ungoverned / rejected_*
    timestamp_ms: int

    @classmethod
    def decode(cls, payload: bytes) -> "NodeSeenEvent":
        raw_mac, node_type, status, ts = struct.unpack(_NODE_SEEN_FMT, payload)
        return cls(":".join(f"{b:02X}" for b in raw_mac), node_type, status, ts)


@dataclass
class PeerTableAck:
    """The gateway confirming which allowlist generation it actually applied.
    Divergence from ours means a push didn't land."""

    generation: int
    count: int

    @classmethod
    def decode(cls, payload: bytes) -> "PeerTableAck":
        generation, count = struct.unpack(_PEER_TABLE_ACK_FMT, payload)
        return cls(generation, count)


def encode_peer_table(generation: int, entries) -> bytes:
    """The WHOLE allowlist in one frame -- that is what makes the gateway
    apply it atomically, with no staging/commit protocol and no way to
    half-apply a table and lock out the lane's real nodes.

    `entries` is an iterable of (mac_string, node_type). 8 entries is 59 bytes,
    inside the gateway's 64-byte UART payload buffer; more than that would
    silently truncate, so callers cap at peer_registry.MAX_PEERS.
    """
    entries = list(entries)
    body = b"".join(
        struct.pack(_PEER_ENTRY_FMT, bytes.fromhex(mac.replace(":", "")), node_type)
        for mac, node_type in entries
    )
    return struct.pack("<HB", generation & 0xFFFF, len(entries)) + body


def encode_pinsetter_command(command: int, lane_side: int, cycle_count: int = 1) -> bytes:
    # lane_side is a SIDE_* value, NOT a lane number -- callers go through
    # lane_map.side_for_lane() first (see serial_link.py). cycle_count only
    # matters for CMD_CYCLE/CMD_RERACK -- see gateway_node.ino's
    # sendPinsetterCommand()/PinsetterCommandFromPi. Defaulted to 1 so
    # callers issuing CMD_POWER_ON/OFF/CMD_STATUS/CMD_RESPOT don't need to
    # think about it.
    return struct.pack(_PINSETTER_COMMAND_FMT, command, lane_side, cycle_count)


def encode_score_event(lane_side: int, ball_number: int, pinfall_mask: int, timestamp_ms: int) -> bytes:
    # timestampMs is a uint32 on the wire, and every mesh node fills it with
    # its own millis() -- an uptime counter that wraps at ~49.7 days, NOT a
    # Unix epoch timestamp (see firmware/PROTOCOL.md's NodeMessage). Masking
    # to 32 bits keeps that contract and, importantly, makes it impossible
    # for a caller passing epoch-ms to blow the whole message up: that used
    # to raise struct.error inside this service's route handler, so every
    # single score event 500'd and nothing on the mesh ever saw one -- a
    # failure that was invisible from state_machine's side, since its
    # _post() only logs a warning and moves on. Callers should still pass a
    # monotonic ms value (see state_machine.py's _record_ball).
    return struct.pack(_SCORE_EVENT_FMT, lane_side, ball_number, pinfall_mask, timestamp_ms & 0xFFFFFFFF)
