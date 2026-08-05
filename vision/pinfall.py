"""Camera-based pinfall detection.

NOT YET IMPLEMENTED. Plan: grab a frame from a USB webcam (cv2.VideoCapture)
after the post-ball cooldown, locate the 10 pin positions using the
calibration data from calibration.py, and classify each as standing/down.

Runs as its own daemon on the Pi, OUTSIDE Docker, with direct access to the
camera device -- see ../README.md for why this is a separate process from
the dockerized scoring/ API service, and how the two are expected to talk to
each other (not fully specified yet -- flagged there).

Naming/convention note: this module's raw output is a STANDING-pin mask
(bit=1 = pin still up), because that's the direct thing a camera frame can
tell you. "Pinfall" (bit=1 = pin fell) is a derived value -- computed by
diffing a StandingPinsResult against whatever was standing at the start of
the frame -- and that conversion is what actually needs to happen before
anything is sent toward game_state.py or firmware/PROTOCOL.md's
MSG_SCORE_EVENT (whose pinfallMask is explicitly bit=1-means-fell, see that
doc). Don't conflate the two masks -- they're complements of each other, and
mixing them up silently produces exactly-backwards scores.
"""

from dataclasses import dataclass


@dataclass
class StandingPinsResult:
    standing_mask: int  # bit per pin, 1-10 (bit set = pin still standing)


def read_standing_pins(lane_number: int) -> StandingPinsResult:
    raise NotImplementedError("camera capture + pin detection not implemented yet")


def standing_to_pinfall_mask(before: int, after: int) -> int:
    """Convert two standing-pin masks (before this ball, after this ball)
    into a pinfall mask (bit=1 = pin fell on THIS ball) -- the delta, not
    either raw snapshot. Matches PROTOCOL.md's MSG_SCORE_EVENT convention.
    """
    return before & ~after & 0x3FF  # pins that were standing and no longer are, masked to 10 bits
