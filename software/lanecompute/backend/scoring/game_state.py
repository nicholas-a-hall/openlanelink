"""Authoritative game state for this compute node's lanes.

Single source of truth for bowler rosters, frames, and scores -- both the
overhead display and the control tablet are thin clients fed by the
REST/WebSocket API layer (api.py), which reads and mutates state through
this module. Nothing else computes scores. This is also the first *real*
implementation of 10-pin scoring math in this project -- the UI prototypes
(scoredash's generateFrames, openlanescheduler-scoring's scoreGame/applyBall) each
had their own, and were flagged as needing consolidation into one shared
module; this is that module. Once the UI is wired to this API it should stop
computing scores itself and just render what it's given.

Ball pinfall convention: each recorded ball is the COUNT of pins that fell
on that specific throw (0-10) -- not a cumulative standing-pin mask. The
camera pipeline (pinfall.py, not yet implemented) observes standing pins and
is responsible for converting that into a per-ball pinfall count before
calling record_ball(); this module only ever deals in that count.
"""

import time
import uuid
from dataclasses import dataclass, field

MAX_FRAME = 10
STRIKE = 10


class UnknownBowlerError(KeyError):
    pass


@dataclass
class Bowler:
    id: str
    name: str
    balls: list[int] = field(default_factory=list)  # flat pinfall-per-ball list, this game


@dataclass
class Game:
    id: str
    lane_number: int
    bowler_ids: list[str] = field(default_factory=list)  # roster order, this game
    started_at_ms: int = 0


class LaneState:
    """All game state for one lane. One instance per lane this compute node covers."""

    def __init__(self, lane_number: int):
        self.lane_number = lane_number
        self.bowlers: dict[str, Bowler] = {}
        self._bowler_order: list[str] = []
        self.game: Game | None = None

    # ---- roster (persists across games -- bowlers stay checked in) ----
    def add_bowler(self, name: str) -> Bowler:
        bowler = Bowler(id=uuid.uuid4().hex[:8], name=name)
        self.bowlers[bowler.id] = bowler
        self._bowler_order.append(bowler.id)
        return bowler

    def edit_bowler(self, bowler_id: str, name: str) -> Bowler:
        bowler = self._require_bowler(bowler_id)
        bowler.name = name
        return bowler

    def remove_bowler(self, bowler_id: str) -> None:
        self._require_bowler(bowler_id)
        del self.bowlers[bowler_id]
        self._bowler_order.remove(bowler_id)

    def _require_bowler(self, bowler_id: str) -> Bowler:
        try:
            return self.bowlers[bowler_id]
        except KeyError:
            raise UnknownBowlerError(bowler_id) from None

    # ---- games ----
    def add_game(self) -> Game:
        """Fresh scoresheet for the current roster -- resets every bowler's balls."""
        for bowler in self.bowlers.values():
            bowler.balls = []
        self.game = Game(
            id=uuid.uuid4().hex[:8],
            lane_number=self.lane_number,
            bowler_ids=list(self._bowler_order),
            started_at_ms=int(time.time() * 1000),
        )
        return self.game

    # ---- scoring ----
    def record_ball(self, bowler_id: str, pinfall: int) -> None:
        bowler = self._require_bowler(bowler_id)
        _validate_pinfall(pinfall)
        if _is_complete(bowler.balls):
            raise ValueError(f"bowler {bowler_id}'s game is already complete")
        bowler.balls.append(pinfall)

    def edit_score(self, bowler_id: str, ball_index: int, pinfall: int) -> None:
        """Manual correction: overwrite one already-recorded ball's pinfall."""
        bowler = self._require_bowler(bowler_id)
        _validate_pinfall(pinfall)
        if not (0 <= ball_index < len(bowler.balls)):
            raise IndexError(f"ball index {ball_index} out of range")
        bowler.balls[ball_index] = pinfall

    def frames(self, bowler_id: str) -> list[dict]:
        """Standard 10-pin frame breakdown + running score, computed fresh
        from the flat ball list every time -- no cached/stale totals."""
        bowler = self._require_bowler(bowler_id)
        return score_game(bowler.balls)

    def snapshot(self) -> dict:
        """Everything a display/control client needs for this lane."""
        return {
            "laneNumber": self.lane_number,
            "game": {"id": self.game.id, "startedAtMs": self.game.started_at_ms} if self.game else None,
            "bowlers": [
                {
                    "id": bid,
                    "name": self.bowlers[bid].name,
                    "frames": self.frames(bid),
                }
                for bid in self._bowler_order
                if bid in self.bowlers
            ],
        }


def _validate_pinfall(pinfall: int) -> None:
    if not (0 <= pinfall <= 10):
        raise ValueError(f"pinfall must be 0-10, got {pinfall}")


def _is_complete(balls: list[int]) -> bool:
    frames = score_game(balls)
    return bool(frames) and frames[-1]["complete"]


def score_game(balls: list[int]) -> list[dict]:
    """Classic flat-ball-list lookahead scoring. Frames not yet fully
    resolved (waiting on bonus balls) have frame_score/running_total = None.
    """
    frames = []
    i = 0
    running_total = 0

    for frame_no in range(1, MAX_FRAME + 1):
        if frame_no < MAX_FRAME:
            if i < len(balls) and balls[i] == STRIKE:
                frame_balls = [balls[i]]
                i += 1
            else:
                frame_balls = balls[i:i + 2]
                i += len(frame_balls)
        else:
            # 10th frame: up to 3 balls, pins reset after a strike or spare
            # (no auto-stop the way frames 1-9 stop after a single strike).
            frame_balls = balls[i:i + 3]
            i += len(frame_balls)

        is_strike = frame_no < MAX_FRAME and frame_balls[:1] == [STRIKE]
        is_spare = not is_strike and len(frame_balls) == 2 and sum(frame_balls) == STRIKE

        score = None
        complete = False
        if frame_no < MAX_FRAME:
            if is_strike:
                bonus = balls[i:i + 2]
                if len(bonus) == 2:
                    score = STRIKE + sum(bonus)
                    complete = True
            elif is_spare:
                bonus = balls[i:i + 1]
                if len(bonus) == 1:
                    score = STRIKE + bonus[0]
                    complete = True
            elif len(frame_balls) == 2:
                score = sum(frame_balls)
                complete = True
        else:
            open_10th = len(frame_balls) == 2 and sum(frame_balls) < STRIKE
            if len(frame_balls) == 3 or open_10th:
                score = sum(frame_balls)
                complete = True

        if complete:
            running_total += score

        frames.append({
            "frame": frame_no,
            "balls": frame_balls,
            "complete": complete,
            "frameScore": score,
            "runningTotal": running_total if complete else None,
        })

    return frames


_LANES: dict[int, LaneState] = {}


def get_lane(lane_number: int) -> LaneState:
    if lane_number not in _LANES:
        _LANES[lane_number] = LaneState(lane_number)
    return _LANES[lane_number]
