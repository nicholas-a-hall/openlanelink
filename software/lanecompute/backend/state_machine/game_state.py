"""Authoritative game state for this compute node's lanes.

Single source of truth for bowler rosters, frames, and scores -- both the
overhead display and the control tablet are thin clients fed by the
REST/WebSocket API layer (api.py), which reads and mutates state through
this module. Nothing else computes scores. This is also the first *real*
implementation of pin-bowling scoring math in this project -- the UI
prototypes (scoredash's generateFrames, openlanescheduler-scoring's
scoreGame/applyBall) each had their own, and were flagged as needing
consolidation into one shared module; this is that module. Once the UI is
wired to this API it should stop computing scores itself and just render
what it's given.

Ball pinfall convention: scoring (score_game() and everything upstream of
it -- frame validation, turn-over/rerack decisions) is driven entirely by
the flat pinfall COUNT per ball, since that's all USBC scoring actually
needs and it keeps score_game()'s frame-walking arithmetic simple. But the
count alone throws away exactly which pins fell -- Bowler.pin_masks carries
that detail alongside (not instead of) balls, index-aligned ball-for-ball,
so the count stays the single source of truth for scoring while the mask is
still recorded for anyone who wants it (a future overhead-display pin-deck
visualization, auditing a disputed call, re-deriving a corrected count if a
mask turns out to be wrong). A ball recorded without mask detail (a foul's
automatic 0, a manual scoresheet correction) just carries None in the
matching pin_masks slot -- that's expected, not an error state.

The vision pipeline (../vision/pinfall.py) does NOT do this diffing itself
-- it only ever reports which pins are standing RIGHT NOW, with no memory
of any previous capture (see its module docstring; nodes/services in this
project stay dumb, the thing with the actual state owns deriving anything
from it, same principle as the ESP32 mesh). standing_mask_before_next_ball()
below is what turns "here's what's standing now" into "here's what fell on
THIS ball" -- it derives the pre-ball baseline from whatever's already been
recorded so far this frame, so vision never has to remember anything
across calls.

Game type: score_game() is a generic frame-walking algorithm parametrized by
a game_types.GameType (see that module) -- it's not ten-pin-specific despite
the name. Ten-pin, no-tap, and duckpin all share the same underlying shape
(fixed frame count, a strike/mark distinction, bonus balls borrowed from the
next frame except in the self-contained final frame) and differ only in the
GameType's numbers. A genuinely different scoring paradigm (some 9-pin/kegel
variants have no strike/spare bonus concept at all) would need its own
scoring function selected per game type, not a new GameType entry -- that's
a deliberately deferred, not a rejected, extension.
"""

import time
import uuid
from dataclasses import dataclass, field

from game_types import GameType, DEFAULT_GAME_TYPE

# 10 bits, all pins standing -- matches firmware/PROTOCOL.md's
# MSG_SCORE_EVENT.pinfallMask convention (bit N-1 = pin N) and
# ../vision/pinfall.py's own FULL_MASK, duplicated rather than imported
# since state_machine and vision are separate standalone services (see
# vision/README.md's "Relationship to state_machine").
FULL_PIN_MASK = 0b11_1111_1111


class UnknownBowlerError(KeyError):
    pass


@dataclass
class Bowler:
    id: str
    name: str
    balls: list[int] = field(default_factory=list)  # flat pinfall-per-ball list, this game
    # Index-aligned with balls: which pins fell on that ball, bit N-1 = pin
    # N (matches firmware/PROTOCOL.md's MSG_SCORE_EVENT.pinfallMask
    # convention). None where a ball has no per-pin detail (a foul, a
    # manual scoresheet edit) -- always the same length as balls.
    pin_masks: list[int | None] = field(default_factory=list)


@dataclass
class Game:
    id: str
    lane_number: int
    bowler_ids: list[str] = field(default_factory=list)  # roster order, this game
    started_at_ms: int = 0
    game_type: GameType = DEFAULT_GAME_TYPE


class LaneState:
    """All game state for one lane. One instance per lane this compute node covers."""

    def __init__(self, lane_number: int):
        self.lane_number = lane_number
        self.bowlers: dict[str, Bowler] = {}
        self._bowler_order: list[str] = []
        self.game: Game | None = None

    # ---- roster (persists across games -- bowlers stay checked in) ----
    def add_bowler(self, name: str) -> Bowler:
        """A bowler added while a game is already in progress (a friend
        walking up mid-session) joins that game's turn rotation immediately,
        at the back of the order -- not just the general roster. Game.
        bowler_ids is a snapshot taken at add_game() time; without this, a
        late-added bowler would show up in the roster but the state machine
        would never advance a turn to them, since _advance_to_next_active_
        bowler only ever cycles through that snapshot."""
        bowler = Bowler(id=uuid.uuid4().hex[:8], name=name)
        self.bowlers[bowler.id] = bowler
        self._bowler_order.append(bowler.id)
        if self.game is not None:
            self.game.bowler_ids.append(bowler.id)
        return bowler

    def edit_bowler(self, bowler_id: str, name: str) -> Bowler:
        bowler = self._require_bowler(bowler_id)
        bowler.name = name
        return bowler

    def remove_bowler(self, bowler_id: str) -> None:
        """Mirrors add_bowler's game.bowler_ids sync -- removing a bowler
        mid-game must also drop them from the active game's rotation, or
        the state machine's turn-advancement would later look up a bowler_id
        that no longer exists in self.bowlers and raise UnknownBowlerError."""
        self._require_bowler(bowler_id)
        del self.bowlers[bowler_id]
        self._bowler_order.remove(bowler_id)
        if self.game is not None and bowler_id in self.game.bowler_ids:
            self.game.bowler_ids.remove(bowler_id)

    def _require_bowler(self, bowler_id: str) -> Bowler:
        try:
            return self.bowlers[bowler_id]
        except KeyError:
            raise UnknownBowlerError(bowler_id) from None

    # ---- games ----
    def reset(self) -> None:
        """Full wipe: clears the roster AND the game, back to a blank lane
        -- for turning a lane over to a new party of bowlers, not for
        starting a fresh scoresheet with the people already checked in
        (that's add_game(), which deliberately keeps the roster). Bowlers
        normally persist across games (see add_bowler()'s docstring) --
        this is the one place that's intentionally overridden."""
        self.bowlers.clear()
        self._bowler_order.clear()
        self.game = None

    def add_game(self, game_type: GameType = DEFAULT_GAME_TYPE) -> Game:
        """Fresh scoresheet for the current roster -- resets every bowler's
        balls. game_type picks which ruleset score_game() applies for this
        game (see game_types.py); defaults to ten-pin. This is also how a
        lane starts its *next* game with the same players once one
        finishes -- same call, no separate endpoint, since keeping the
        roster and resetting scores is exactly what this already does."""
        for bowler in self.bowlers.values():
            bowler.balls = []
            bowler.pin_masks = []
        self.game = Game(
            id=uuid.uuid4().hex[:8],
            lane_number=self.lane_number,
            bowler_ids=list(self._bowler_order),
            started_at_ms=int(time.time() * 1000),
            game_type=game_type,
        )
        return self.game

    def _game_type(self) -> GameType:
        # record_ball() doesn't require an active Game (balls live on the
        # Bowler regardless), so fall back to the default rather than
        # requiring add_game() to have been called first.
        return self.game.game_type if self.game else DEFAULT_GAME_TYPE

    # ---- scoring ----
    def record_ball(self, bowler_id: str, pinfall: int, pin_mask: int | None = None) -> None:
        """A ball can only knock down pins that are actually still standing
        -- e.g. ball1=9 leaves at most 1 pin for ball2; a "second-ball
        strike" is physically impossible in real ten-pin (frames 1-9) and
        this must never silently accept one. The only ball that's ever
        unconstrained by the frame's running sum is the first ball of a
        frame, or the ball right after a clear (fresh rack -- the final
        frame's bonus balls after a strike/spare).

        pin_mask is optional detail, not a second source of truth: pinfall
        (the count) is what scoring actually validates/uses, exactly as
        before. When a mask IS given, though, it must actually agree with
        the count -- a caller passing both that disagree is a bug (vision
        computing the count and mask inconsistently, or a transport error),
        not something to silently store."""
        bowler = self._require_bowler(bowler_id)
        gt = self._game_type()
        _validate_pinfall(pinfall, gt)
        if pin_mask is not None and bin(pin_mask).count("1") != pinfall:
            raise ValueError(f"pin_mask {pin_mask:#x} has {bin(pin_mask).count('1')} bit(s) set, doesn't match pinfall={pinfall}")
        if _is_complete(bowler.balls, gt):
            raise ValueError(f"bowler {bowler_id}'s game is already complete")
        remaining = _pins_remaining_for_next_ball(_current_frame_balls(bowler.balls, gt), gt)
        if pinfall > remaining:
            raise ValueError(
                f"pinfall {pinfall} exceeds the {remaining} pin(s) still standing this frame"
            )
        bowler.balls.append(pinfall)
        bowler.pin_masks.append(pin_mask)

    def standing_mask_before_next_ball(self, bowler_id: str) -> int | None:
        """Which pins are standing going into this bowler's next ball --
        derived from this frame's already-recorded balls' pin_masks, not
        tracked as separate state anywhere. This is what lets vision stay
        completely stateless (see this module's docstring): it reports a
        raw "standing right now" mask, and diffing that against THIS is
        how a caller (state_machine.py's on_pinfall_observed) turns it
        into "here's what fell on this specific ball."

        Full rack if no balls have been thrown yet this frame (a fresh
        frame, or the ball right after a clear -- see
        _pins_remaining_for_next_ball()'s docstring, this mirrors its
        exact reset-on-clear logic, mask instead of count). None if we
        genuinely can't know: some ball already thrown this frame has no
        per-pin detail (manual entry, a foul), so there's no reliable
        baseline to diff a vision observation against -- the caller
        should treat that as "can't derive a mask-based count right now,"
        not fabricate one."""
        bowler = self._require_bowler(bowler_id)
        gt = self._game_type()
        frame_balls = _current_frame_balls(bowler.balls, gt)
        if not frame_balls:
            return FULL_PIN_MASK
        frame_masks = bowler.pin_masks[-len(frame_balls):]
        if any(m is None for m in frame_masks):
            return None

        standing = FULL_PIN_MASK
        total = 0
        for pos, (count, mask) in enumerate(zip(frame_balls, frame_masks)):
            total += count
            threshold = gt.strike_threshold if pos == 0 else gt.pins_per_throw_max
            if total >= threshold:
                standing, total = FULL_PIN_MASK, 0  # cleared -- fresh rack for whatever's next
            else:
                standing &= ~mask & FULL_PIN_MASK
        return standing

    def edit_score(self, bowler_id: str, frame_number: int, ball_in_frame: int, pinfall: int) -> None:
        """Manual correction: overwrite one already-recorded ball's pinfall,
        addressed the way a human reads a scoresheet -- frame number (1-10)
        and which ball within that frame (1-2, or 1-3 in the 10th) --
        rather than a flat index into the underlying ball list. Translated
        into that flat index via the same frame-boundary walk frames()
        already does, since that's the only thing that knows where frame N
        actually starts once earlier strikes/spares have shifted it. The
        flat list itself stays the stored/corrected representation (not
        frames) precisely because that walk has to be redone after every
        correction anyway -- e.g. turning a recorded strike into a 7 means
        that frame now needs a second ball, and every later frame's balls
        shift by one. A flat list re-derives that automatically; physically
        storing balls already-bucketed into frames would require this
        module to re-bucket everything after every edit instead."""
        bowler = self._require_bowler(bowler_id)
        gt = self._game_type()
        _validate_pinfall(pinfall, gt)
        if not (1 <= frame_number <= gt.frame_count):
            raise ValueError(f"frame_number must be 1-{gt.frame_count}, got {frame_number}")

        frames = score_game(bowler.balls, gt)
        frame = frames[frame_number - 1]
        if not (1 <= ball_in_frame <= len(frame["balls"])):
            raise IndexError(
                f"frame {frame_number} has {len(frame['balls'])} ball(s) recorded, "
                f"ball_in_frame {ball_in_frame} out of range"
            )

        ball_index = sum(len(f["balls"]) for f in frames[:frame_number - 1]) + (ball_in_frame - 1)
        bowler.balls[ball_index] = pinfall
        # A manual correction no longer has a real per-pin observation
        # behind it -- keeping the old mask around would misrepresent it
        # as still-trustworthy detail for whatever the corrected count is.
        bowler.pin_masks[ball_index] = None

    def frames(self, bowler_id: str) -> list[dict]:
        """Frame breakdown + running score under this lane's active
        game_type, computed fresh from the flat ball list every time -- no
        cached/stale totals. pinMasks is stitched in per frame afterward,
        index-aligned with that frame's own "balls" list -- score_game()
        stays a pure function of the flat count list and knows nothing
        about masks; every ball in bowler.balls ends up in exactly one
        frame's "balls" list in the same flat order (bonus balls included,
        see score_game()'s docstring), so walking frames in order and
        slicing pin_masks by each frame's ball count lines them up exactly
        the same way edit_score()'s ball_index math already does."""
        bowler = self._require_bowler(bowler_id)
        frames = score_game(bowler.balls, self._game_type())
        idx = 0
        for f in frames:
            n = len(f["balls"])
            f["pinMasks"] = bowler.pin_masks[idx:idx + n]
            idx += n
        return frames

    def current_ball_number(self, bowler_id: str) -> int | None:
        """Which ball (1st, 2nd, ...) this bowler is about to throw within
        their current frame -- None if their game's already complete, same
        meaning as snapshot()'s per-bowler `currentBall` (this just exposes
        it standalone, for state_machine.py's reconcile_ball_number() to
        cross-check against a hardware-reported ball number without
        needing a full snapshot)."""
        return self._current_frame_and_ball(self.frames(bowler_id))[1]

    def snapshot(self) -> dict:
        """Everything a display/control client needs for this lane --
        including totalScore/currentFrame/currentBall per bowler, computed
        here rather than left for the client to re-derive by scanning
        `frames` (the last resolved runningTotal, the first non-turnOver
        frame, ball counts, ...). The UI should read game state, never
        infer it. currentFrame/currentBall are well-defined for every
        bowler regardless of whose turn it actually is right now (see
        state_machine.py's currentBowlerId for that) -- e.g. DisplayLane's
        frame spotlight needs to know where EVERY bowler on the lane
        stands, not just whoever's currently up."""
        return {
            "laneNumber": self.lane_number,
            "game": {
                "id": self.game.id,
                "startedAtMs": self.game.started_at_ms,
                "gameType": self.game.game_type.name,
            } if self.game else None,
            "bowlers": [
                {
                    "id": bid,
                    "name": self.bowlers[bid].name,
                    "frames": (frames := self.frames(bid)),
                    "totalScore": self._total_score(frames),
                    "currentFrame": (cf := self._current_frame_and_ball(frames))[0],
                    "currentBall": cf[1],
                }
                for bid in self._bowler_order
                if bid in self.bowlers
            ],
        }

    @staticmethod
    def _total_score(frames: list[dict]) -> int:
        for f in reversed(frames):
            if f["runningTotal"] is not None:
                return f["runningTotal"]
        return 0

    @staticmethod
    def _current_frame_and_ball(frames: list[dict]) -> tuple[int | None, int | None]:
        f = next((fr for fr in frames if not fr["turnOver"]), None)
        if f is None:
            return None, None  # this bowler's game is complete -- nothing left to throw
        return f["frame"], len(f["balls"]) + 1


def _validate_pinfall(pinfall: int, gt: GameType) -> None:
    if not (0 <= pinfall <= gt.pins_per_throw_max):
        raise ValueError(f"pinfall must be 0-{gt.pins_per_throw_max}, got {pinfall}")


def _is_complete(balls: list[int], gt: GameType) -> bool:
    frames = score_game(balls, gt)
    return bool(frames) and frames[-1]["complete"]


def _current_frame_balls(balls: list[int], gt: GameType) -> list[int]:
    """Balls already thrown in whichever frame the *next* ball would land
    in -- [] if the next ball starts a brand new frame (nothing thrown yet,
    or the most recent frame already closed)."""
    frames = score_game(balls, gt)
    in_progress = [f for f in frames if f["balls"] and not f["turnOver"]]
    return in_progress[-1]["balls"] if in_progress else []


def _pins_remaining_for_next_ball(frame_balls_so_far: list[int], gt: GameType) -> int:
    """How many pins the next ball can legally knock down, given what's
    already been thrown in the current frame. A fresh rack
    (pins_per_throw_max) applies to the very first ball of a frame, and
    resets again immediately after any clear within the frame -- the only
    place that matters is the final frame's bonus balls after a strike or
    spare, which are thrown at fresh racks, not constrained by the frame's
    earlier running sum. (Regular frames 1-9 never have a "ball after a
    clear" to validate this way -- turnOver ends the frame the instant it
    clears, so there's nothing left in that same frame to throw.)"""
    remaining = gt.pins_per_throw_max
    total = 0
    for pos, b in enumerate(frame_balls_so_far):
        total += b
        threshold = gt.strike_threshold if pos == 0 else gt.pins_per_throw_max
        if total >= threshold:
            remaining, total = gt.pins_per_throw_max, 0  # cleared -- fresh rack for whatever's next
        else:
            remaining = gt.pins_per_throw_max - total
    return remaining


def _take_regular_frame(balls: list[int], i: int, gt: GameType) -> tuple[list[int], int, bool, bool, bool]:
    """Take balls for one non-final frame, up to gt.regular_frame_max_balls,
    stopping early on a clear. A clear on ball 1 alone only needs to reach
    gt.strike_threshold (which is < pins_per_throw_max for a scoring-rule
    override like no-tap's 9 -- otherwise the two are equal); a clear on any
    later ball always needs the true full pins_per_throw_max, never the
    relaxed threshold.

    Returns (frame_balls, new_i, cleared, struck, reached_cap). frame_balls
    may come up short of what the rule calls for if there simply aren't
    enough recorded balls yet -- reached_cap distinguishes "this frame is
    structurally done being thrown into" from "still waiting on the next
    ball," which is exactly what turnOver needs and what `complete` must
    NOT be set from prematurely.
    """
    frame_balls: list[int] = []
    total = 0
    cleared = False
    for pos in range(gt.regular_frame_max_balls):
        if i + len(frame_balls) >= len(balls):
            break  # not enough balls recorded yet -- still this bowler's turn
        b = balls[i + len(frame_balls)]
        frame_balls.append(b)
        total += b
        threshold = gt.strike_threshold if pos == 0 else gt.pins_per_throw_max
        if total >= threshold:
            cleared = True
            break
    new_i = i + len(frame_balls)
    struck = cleared and len(frame_balls) == 1
    reached_cap = cleared or len(frame_balls) == gt.regular_frame_max_balls
    return frame_balls, new_i, cleared, struck, reached_cap


def score_game(balls: list[int], gt: GameType = DEFAULT_GAME_TYPE) -> list[dict]:
    """Generic flat-ball-list lookahead scoring, parametrized by a
    game_types.GameType -- see that module and this module's docstring for
    which games this shape covers. Frames not yet fully resolved (waiting
    on bonus balls) have frameScore/runningTotal = None.
    """
    frames = []
    i = 0
    running_total = 0

    for frame_no in range(1, gt.frame_count + 1):
        frame_balls, i, cleared, struck, reached_cap = _take_regular_frame(balls, i, gt)
        # Bonus balls are only ever earned by clearing on ball 1 (strike) or
        # ball 2 (spare) -- clearing later (duckpin's 3rd ball, the only way
        # this can happen since ten-pin/no-tap never have a 3rd regular
        # ball) scores a flat pins_per_throw_max with NO bonus ball, same as
        # an open frame. Verified against real duckpin rules: "gets 10
        # points, as in candlepins, with no bonus."
        spared = cleared and not struck and len(frame_balls) == 2

        score = None
        complete = False
        if frame_no < gt.frame_count:
            # Bonus balls are borrowed from the NEXT frame's own throws --
            # they aren't consumed here (i doesn't advance for them), only
            # peeked at, so the next frame's own walk sees them normally.
            if reached_cap and struck:
                bonus = balls[i:i + gt.strike_bonus_balls]
                if len(bonus) == gt.strike_bonus_balls:
                    score = gt.pins_per_throw_max + sum(bonus)
                    complete = True
            elif reached_cap and spared:
                bonus = balls[i:i + gt.mark_bonus_balls]
                if len(bonus) == gt.mark_bonus_balls:
                    score = gt.pins_per_throw_max + sum(bonus)
                    complete = True
            elif reached_cap:
                score = sum(frame_balls)
                complete = True
            turn_over = reached_cap
        else:
            # Final frame: self-contained, no next frame to borrow from --
            # a strike/spare's bonus balls are taken inline, extending this
            # same frame, unconditionally (they don't need to clear
            # anything themselves; a fresh rack is given for each). A
            # late clear (duckpin's 3rd ball) gets no bonus, same as a
            # regular frame.
            if reached_cap and (struck or spared):
                bonus_needed = gt.strike_bonus_balls if struck else gt.mark_bonus_balls
                bonus = balls[i:i + bonus_needed]
                i += len(bonus)
                if len(bonus) == bonus_needed:
                    # Credit a struck ball 1 at pins_per_throw_max even if
                    # its literal value was lower (no-tap's 9) -- same
                    # crediting the regular-frame strike formula already
                    # applies above, kept consistent here rather than
                    # summing the raw thrown value. A spare's own balls
                    # already sum to exactly pins_per_throw_max by
                    # definition (a spare always requires a true full
                    # clear, never the relaxed strike_threshold), so
                    # summing them is already correct in that case.
                    base = gt.pins_per_throw_max if struck else sum(frame_balls)
                    score = base + sum(bonus)
                    complete = True
                frame_balls = frame_balls + bonus
            elif reached_cap:
                score = sum(frame_balls)
                complete = True
            # Final frame: no later frame exists to keep the turn open for,
            # so "structurally done being thrown into" and "fully scored"
            # are the same instant.
            turn_over = complete

        if complete:
            running_total += score

        frames.append({
            "frame": frame_no,
            "balls": frame_balls,
            "complete": complete,
            "turnOver": turn_over,
            "frameScore": score,
            "runningTotal": running_total if complete else None,
        })

    return frames


_LANES: dict[int, LaneState] = {}


def get_lane(lane_number: int) -> LaneState:
    if lane_number not in _LANES:
        _LANES[lane_number] = LaneState(lane_number)
    return _LANES[lane_number]
