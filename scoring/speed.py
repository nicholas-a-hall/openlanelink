"""Ball-speed calculation from a speed-node interval reading.

The speed node only reports the raw interval (ms) between its two beams --
see firmware/speed_node/speed_node.ino -- so the physical beam spacing is a
calibration constant here, not baked into firmware. Re-measure and update
BEAM_SPACING_FT if the sensors are moved.
"""

# TODO: measure the actual distance between the two speed-node beams on the lane.
BEAM_SPACING_FT = 3.0  # PLACEHOLDER -- not yet measured

_FT_PER_S_TO_MPH = 1 / 1.46667


def interval_to_mph(interval_ms: int) -> float:
    if interval_ms <= 0:
        return 0.0
    feet_per_sec = (BEAM_SPACING_FT / interval_ms) * 1000
    return feet_per_sec * _FT_PER_S_TO_MPH
