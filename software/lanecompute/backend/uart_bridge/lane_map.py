"""Which real lane number each side of this pair's mesh corresponds to.

THE MESH HAS NO LANE NUMBERS. A gateway's mesh is exactly one lane pair, so
every node on it reports only which SIDE of that pair an event concerns
(SIDE_A / SIDE_B -- LaneSide in
firmware/lib/lanelink/src/lanelink_protocol.h). That is what lets every leaf
sketch be flashed unmodified onto every pair in the house: the firmware
genuinely does not know, and never learns, which lanes it is sitting on.

This module is the one place that knowledge lives. It is deployment config,
not wire format, which is why it is here rather than in protocol.py -- that
file mirrors the bytes on the wire and must stay in step with the firmware;
this one describes where this particular Pi is installed.

The translation happens at this service's boundary (service.py on the way
in, serial_link.py on the way out), so nothing downstream ever sees a side:
state_machine, vision, and the UI all speak real lane numbers exactly as
they did before sides existed.
"""

import logging
import os

log = logging.getLogger(__name__)

# Mirrors LaneSide in the firmware's lanelink_protocol.h. SIDE_NONE is the
# "node-level / not side-specific" sentinel (a pinsetter heartbeat, a relay
# fault -- see firmware/PROTOCOL.md), NOT a lane.
SIDE_NONE = 0
SIDE_A = 1
SIDE_B = 2

# Defaults match the lane pair this project was developed against, so an
# existing single-pair install keeps working with no new environment set.
LANE_FOR_SIDE: dict[int, int] = {
    SIDE_A: int(os.environ.get("LANE_SIDE_A", "7")),
    SIDE_B: int(os.environ.get("LANE_SIDE_B", "8")),
}

SIDE_FOR_LANE: dict[int, int] = {lane: side for side, lane in LANE_FOR_SIDE.items()}

if len(SIDE_FOR_LANE) != len(LANE_FOR_SIDE):
    raise ValueError(
        f"LANE_SIDE_A and LANE_SIDE_B must name different lanes, got {LANE_FOR_SIDE}"
    )


def lane_for_side(side: int) -> int | None:
    """Inbound: a side off the wire -> the real lane number to publish.

    Returns None for SIDE_NONE and for any side this pair doesn't map, which
    are two genuinely different situations that callers treat differently
    (see service.py): a sensor edge naming no side is meaningless and gets
    dropped, while a STATUS event naming no side is completely normal -- it
    describes the pinsetter board rather than one of its machines -- and is
    published as the laneNumber 0 sentinel that ../state_machine/main.py
    already checks for.

    Returning None rather than 0 is what keeps those two cases separable at
    all: 0 is a legitimate value to publish for the node-level case, so if
    this collapsed both into 0 the sensor-edge guard could never fire.
    """
    if side == SIDE_NONE:
        return None
    lane = LANE_FOR_SIDE.get(side)
    if lane is None:
        log.warning("unknown lane side %r on the wire (this bridge maps %s)",
                    side, describe())
    return lane


def side_for_lane(lane: int) -> int | None:
    """Outbound: a lane number from a caller -> the side to put on the wire.

    Returns None for a lane this pair doesn't cover, which callers treat as
    "drop the command". That case is worth refusing rather than passing
    through: this gateway's mesh physically cannot reach another pair's
    pinsetter, so sending anyway would either silently do nothing or -- if
    the number happened to collide with a valid side value -- cycle the WRONG
    machine on this pair.
    """
    return SIDE_FOR_LANE.get(lane)


def describe() -> dict[str, int]:
    """The configured mapping, for /health and error messages. Surfacing it
    is the only way a mis-set LANE_SIDE_A/LANE_SIDE_B is visible at all --
    otherwise the symptom is a working system that scores the wrong lane."""
    return {"A": LANE_FOR_SIDE[SIDE_A], "B": LANE_FOR_SIDE[SIDE_B]}
