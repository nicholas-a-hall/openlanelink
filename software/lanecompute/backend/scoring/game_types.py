"""Loads per-game-type scoring parameters from game_types.json. This module
is data only, no scoring logic -- see game_state.py's score_game() for the
generic frame-walking algorithm these parameters drive.

Covers games that share ten-pin's underlying shape: a fixed frame count, a
strike/spare distinction (bonus balls only ever earned by clearing on ball 1
or ball 2, never later), and bonus balls borrowed from the next frame except
in the self-contained final frame. Ten-pin, no-tap, and duckpin all fit this
shape -- verified against real rules for each (2026-08-06):
  - ten-pin: USBC rules, unchanged from before this module existed.
  - no-tap: standard 10-pin equipment: pins_per_throw_max=10, but
    strike_threshold=9 -- 9 *or* 10 on ball 1 scores as a strike. Bonus
    balls count at their literal thrown value, not re-credited, same as
    ordinary ten-pin scoring ("scoring in all respects is the same as your
    normal bowling").
  - duckpin: regular_frame_max_balls=3, not 2 -- but a clear on the 3rd
    ball is NOT a spare. It scores a flat pins_per_throw_max with no bonus
    ball ("gets 10 points, as in candlepins, with no bonus" -- confirmed
    against two independent sources). Only ball 1 (strike) and ball 2
    (spare) ever earn bonus balls; score_game() enforces this by position,
    not by "cleared or not."

9-pin was explicitly researched and does NOT fit this shape -- neither major
real-world variant has a strike/spare/bonus-ball concept at all:
  - American/Texas ninepins: flat pinfall total, with a special fixed-value
    bonus for a specific standing-pin pattern (a "ringer" = clearing
    everything but the center pin), not a bonus *ball* mechanic.
  - European Kegeln: pure cumulative pinfall across a fixed throw count;
    pins don't even reset between players, which doesn't fit this module's
    one-bowler-one-flat-ball-list model at all, let alone the frame algorithm.
Either would need its own scoring function selected per game type, not a
new entry in this JSON -- see game_state.py's module docstring.
"""

import json
import os
from dataclasses import dataclass

_JSON_PATH = os.path.join(os.path.dirname(__file__), "game_types.json")


@dataclass(frozen=True)
class GameType:
    name: str
    display_name: str
    frame_count: int
    pins_per_throw_max: int      # max valid pinfall for a single throw (validation ceiling)
    strike_threshold: int        # pins on ball 1 that end the frame as a strike -- equals
                                  # pins_per_throw_max for a true clear (ten-pin/duckpin), lower
                                  # for a scoring-rule override like no-tap's 9
    regular_frame_max_balls: int # balls per non-final frame before a strike/mark ends it early
                                  # (2 for ten-pin/no-tap, 3 for duckpin)
    strike_bonus_balls: int      # bonus balls awarded for a first-ball strike
    mark_bonus_balls: int        # bonus balls awarded for a later-ball mark (spare-equivalent);
                                  # marks always require a true full clear, never the relaxed
                                  # strike_threshold -- no-tap only relaxes ball 1


def _load() -> dict[str, GameType]:
    with open(_JSON_PATH) as f:
        raw = json.load(f)
    return {
        name: GameType(
            name=name,
            display_name=cfg["displayName"],
            frame_count=cfg["frameCount"],
            pins_per_throw_max=cfg["pinsPerThrowMax"],
            strike_threshold=cfg["strikeThreshold"],
            regular_frame_max_balls=cfg["regularFrameMaxBalls"],
            strike_bonus_balls=cfg["strikeBonusBalls"],
            mark_bonus_balls=cfg["markBonusBalls"],
        )
        for name, cfg in raw.items()
    }


GAME_TYPES: dict[str, GameType] = _load()
DEFAULT_GAME_TYPE = GAME_TYPES["ten_pin"]


def get_game_type(name: str) -> GameType:
    try:
        return GAME_TYPES[name]
    except KeyError:
        raise ValueError(f"unknown game type {name!r}, available: {sorted(GAME_TYPES)}") from None
