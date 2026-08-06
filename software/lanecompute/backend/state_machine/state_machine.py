"""Per-lane game/mesh state machine -- the single place every scoring input
lands: fouls, beam-pairing results, pinsetter status, and (until
vision/pinfall.py exists) manually-entered pinfall counts. Owns whose turn
it is and the cycle-vs-rerack decision. game_state.py stays pure scoring
math with no opinion on turn order or the pinsetter; this module is the
layer above it that actually drives a game ball-by-ball.

Nodes are dumb, the Pi decides (see firmware/HANDOFF.md) -- this is where
that decision-making happens for the ball-by-ball flow, the same principle
main.py already applies to beam-pairing/speed timing.
"""

import logging
from enum import Enum, auto

import game_state

log = logging.getLogger(__name__)


class State(Enum):
    IDLE = auto()              # no game started yet
    READY = auto()              # waiting for the current bowler's ball
    BALL_IN_FLIGHT = auto()     # upstream beam broken, waiting on the downstream beam or a foul
    AWAITING_PINFALL = auto()   # ball reached the pins, waiting on a pinfall count
    PINSETTER_BUSY = auto()     # cycle/rerack in flight (Pi-sent or gateway auto-rerack-on-foul), waiting on STATUS_CYCLE_COMPLETE
    GAME_COMPLETE = auto()      # every bowler has finished all 10 frames


class InvalidTransitionError(Exception):
    """An event arrived that doesn't make sense in the machine's current state."""


class LaneStateMachine:
    """All mesh/game orchestration state for one lane. One instance per lane
    this compute node covers -- see get_machine()."""

    def __init__(self, lane_number: int, bridge):
        self.lane_number = lane_number
        self._bridge = bridge
        self.state = State.IDLE
        self.current_bowler_idx = 0

    # ---- lifecycle ----
    def begin_game(self) -> None:
        """Call after game_state.LaneState.add_game() sets up a fresh
        scoresheet -- resets whose turn it is and opens the lane for the
        first ball."""
        self.current_bowler_idx = 0
        self.state = State.READY

    def snapshot(self) -> dict:
        """Whose turn it is. What frame/ball that bowler is on lives on
        their own entry in game_state.LaneState.snapshot()'s `bowlers`
        list (currentFrame/currentBall there, well-defined for every
        bowler, not just whoever's up) -- looking that up by
        currentBowlerId is how a client finds "what's next" without
        re-deriving it from raw frame data itself."""
        return {
            "machineState": self.state.name,
            "currentBowlerId": self._current_bowler_id(),
        }

    # ---- sensor/mesh events (see main.py's UartBridge callbacks) ----
    def on_upstream_beam(self) -> None:
        if self.state != State.READY:
            log.warning("Lane %s: upstream beam in state %s, ignored", self.lane_number, self.state.name)
            return
        self.state = State.BALL_IN_FLIGHT

    def on_downstream_beam(self) -> None:
        if self.state != State.BALL_IN_FLIGHT:
            log.warning("Lane %s: downstream beam in state %s, ignored", self.lane_number, self.state.name)
            return
        self.state = State.AWAITING_PINFALL

    def on_foul(self) -> None:
        """A foul can land anywhere between READY and AWAITING_PINFALL -- the
        bowler can cross the line before, during, or after the ball's
        flight. The gateway already auto-reracks on every foul edge
        (firmware/HANDOFF.md's FOUL_COOLDOWN_MS logic), so the Pi does not
        also send a redundant command -- but it still records the ball as a
        0 and waits for the same STATUS_CYCLE_COMPLETE before the next ball,
        since the rack really is in motion regardless of who triggered it."""
        if self.state not in (State.READY, State.BALL_IN_FLIGHT, State.AWAITING_PINFALL):
            log.warning("Lane %s: foul in state %s, ignored", self.lane_number, self.state.name)
            return
        self._record_ball(pinfall=0, send_command=False)

    def on_pinfall_observed(self, pinfall: int) -> None:
        """Manual-entry stub until vision/pinfall.py exists -- see api.py's
        POST /api/lanes/{lane}/pinfall. Vision will call this same method
        once it's built; the FSM doesn't care where the count came from."""
        if self.state != State.AWAITING_PINFALL:
            raise InvalidTransitionError(
                f"lane {self.lane_number}: pinfall observed in state {self.state.name}, expected AWAITING_PINFALL"
            )
        self._record_ball(pinfall, send_command=True)

    def on_cycle_complete(self) -> None:
        if self.state != State.PINSETTER_BUSY:
            log.warning("Lane %s: cycle complete in state %s, ignored", self.lane_number, self.state.name)
            return
        self.state = State.GAME_COMPLETE if self._all_bowlers_done() else State.READY

    # ---- internals ----
    def _lane(self) -> game_state.LaneState:
        return game_state.get_lane(self.lane_number)

    def _current_bowler_id(self) -> str | None:
        ls = self._lane()
        if not ls.game or not ls.game.bowler_ids:
            return None
        return ls.game.bowler_ids[self.current_bowler_idx % len(ls.game.bowler_ids)]

    @staticmethod
    def _turn_over(ls: game_state.LaneState, bowler_id: str) -> bool:
        """frames() always returns all 10 frame entries regardless of how
        many balls have actually been thrown, so frames()[-1] is always
        frame 10 -- not "whichever frame is in progress." Find the frame
        the just-thrown ball actually landed in: the last one with any
        balls recorded. (A frame's own `balls` list is stable once
        populated -- later balls fill later frames, never rewrite an
        earlier one -- so "last non-empty" is a safe, stable definition.)"""
        frames = ls.frames(bowler_id)
        in_progress = [f for f in frames if f["balls"]]
        current = in_progress[-1] if in_progress else frames[0]
        return current["turnOver"]

    @staticmethod
    def _bowler_done(ls: game_state.LaneState, bowler_id: str) -> bool:
        # Unlike _turn_over, this one WANTS frame 10 specifically -- "is
        # this bowler's whole game finished" is exactly frame 10's
        # `complete` flag, regardless of which frame is in progress.
        return ls.frames(bowler_id)[-1]["complete"]

    def _all_bowlers_done(self) -> bool:
        ls = self._lane()
        if not ls.game:
            return True
        return all(self._bowler_done(ls, bid) for bid in ls.game.bowler_ids)

    def _record_ball(self, pinfall: int, send_command: bool) -> None:
        ls = self._lane()
        bowler_id = self._current_bowler_id()
        if bowler_id is None:
            raise InvalidTransitionError(f"lane {self.lane_number}: no active game/bowler to record a ball for")

        ls.record_ball(bowler_id, pinfall)
        turn_over = self._turn_over(ls, bowler_id)

        if send_command:
            if turn_over:
                self._bridge.send_rerack(self.lane_number)
            else:
                self._bridge.send_cycle(self.lane_number)

        if turn_over:
            self._advance_to_next_active_bowler(ls)

        self.state = State.PINSETTER_BUSY

    def _advance_to_next_active_bowler(self, ls: game_state.LaneState) -> None:
        ids = ls.game.bowler_ids
        for _ in range(len(ids)):
            self.current_bowler_idx = (self.current_bowler_idx + 1) % len(ids)
            if not self._bowler_done(ls, ids[self.current_bowler_idx]):
                return
        # Every bowler has thrown their last ball. Left pointing at whoever
        # we landed on -- on_cycle_complete() checks _all_bowlers_done() and
        # moves to GAME_COMPLETE once the final rerack/cycle finishes.


_MACHINES: dict[int, LaneStateMachine] = {}


def get_machine(lane_number: int, bridge) -> LaneStateMachine:
    if lane_number not in _MACHINES:
        _MACHINES[lane_number] = LaneStateMachine(lane_number, bridge)
    return _MACHINES[lane_number]
