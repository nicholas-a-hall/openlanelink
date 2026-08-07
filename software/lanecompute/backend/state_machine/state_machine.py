"""Per-lane game/mesh state machine -- the single place every scoring input
lands: fouls, beam-pairing results, pinsetter status, manually-entered
pinfall counts, and vision's raw standing-pin observations. Owns whose turn
it is and the cycle-vs-rerack decision. game_state.py stays pure scoring
math with no opinion on turn order or the pinsetter; this module is the
layer above it that actually drives a game ball-by-ball.

Nodes are dumb, the Pi decides (see firmware/HANDOFF.md) -- this is where
that decision-making happens for the ball-by-ball flow, the same principle
main.py already applies to beam-pairing/speed timing and this module
applies to turning vision's raw standing_mask into a per-ball fallen count
(see on_pinfall_observed()).
"""

import logging
import time
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

    def reset(self) -> None:
        """Call after game_state.LaneState.reset() clears the roster/game --
        drops back to IDLE regardless of whatever was in flight (a ball
        mid-air, a pinsetter cycle), unlike begin_game()'s READY, since a
        full reset means there's no active game or players to be READY
        for. Not guarded by current state -- a lane being handed to a new
        party should always succeed, not get stuck refusing because the
        previous party left mid-ball."""
        self.current_bowler_idx = 0
        self.state = State.IDLE

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

    # ---- sensor/mesh events (see main.py's BridgeClient callbacks) ----
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

    def on_pinfall_observed(self, pinfall: int | None = None, standing_mask: int | None = None) -> None:
        """Called from api.py's POST /api/lanes/{lane}/pinfall. Exactly one
        of two shapes of report, both landing on the same _record_ball()
        underneath:
        - Manual entry (a bowler tablet or staff UI): a plain pinfall
          count, no per-pin detail to give, pin_mask ends up None.
        - vision/pinfall.py: a raw standing_mask -- which pins are
          standing RIGHT NOW, full stop, no memory of any earlier capture
          (see its module docstring for why it stays that stateless. THIS
          machine derives both the count and the fallen-this-ball mask by
          diffing standing_mask against game_state.LaneState.
          standing_mask_before_next_ball(), i.e. whatever's already been
          recorded so far this frame -- vision never needs to remember
          anything across calls, this is the one place doing that
          derivation, matching the "dumb node, smart bridge owns timing/
          correlation" principle already used for the ESP32 mesh.

        Deliberately NOT gated on self.state == AWAITING_PINFALL (unlike
        on_upstream_beam/on_downstream_beam, which are real hardware-edge
        events and stay strict). A pinfall observation is allowed to arrive
        from any state and is trusted as ground truth that a ball was
        thrown -- beam events are a nice-to-have timing/speed signal, not a
        prerequisite for scoring, and vision in particular has no beam
        events of its own to wait on. Whatever state we were actually in
        (still READY, mid-flight, even PINSETTER_BUSY from a previous
        ball's cycle never explicitly confirmed complete -- that previous
        cycle is exactly what THIS new ball's existence proves happened)
        gets overwritten by _record_ball's own state transition below,
        same as the normal path. The cases that genuinely can't record a
        ball -- no active game/bowler, this bowler's game already
        complete, or (standing_mask path only) an earlier ball this frame
        has no per-pin detail to diff against -- still raise, from further
        down the call chain rather than a state check up here."""
        if standing_mask is not None:
            pinfall, pin_mask = self._derive_ball_from_standing_mask(standing_mask)
        elif pinfall is None:
            raise ValueError(f"lane {self.lane_number}: pinfall observed with neither pinfall nor standing_mask given")
        else:
            pin_mask = None
        self._record_ball(pinfall, send_command=True, pin_mask=pin_mask)

    def _derive_ball_from_standing_mask(self, standing_mask: int) -> tuple[int, int]:
        ls = self._lane()
        bowler_id = self._current_bowler_id()
        if bowler_id is None:
            raise InvalidTransitionError(f"lane {self.lane_number}: no active game/bowler to record a ball for")
        before = ls.standing_mask_before_next_ball(bowler_id)
        if before is None:
            raise ValueError(
                f"lane {self.lane_number}: can't derive a pinfall count from standing_mask -- an earlier "
                f"ball this frame has no per-pin detail to diff against"
            )
        fallen_mask = before & ~standing_mask & game_state.FULL_PIN_MASK
        return bin(fallen_mask).count("1"), fallen_mask

    def on_cycle_complete(self) -> None:
        if self.state != State.PINSETTER_BUSY:
            log.warning("Lane %s: cycle complete in state %s, ignored", self.lane_number, self.state.name)
            return
        self.state = State.GAME_COMPLETE if self._all_bowlers_done() else State.READY

    def reconcile_ball_number(self, hardware_ball_number: int) -> None:
        """Cross-checks a hardware-reported ball number (StatusEvent.
        ball_number -- the pinsetter's own MachineRecord.flags ball bit,
        see protocol.py's StatusEvent docstring for why this is None on
        every event today) against what this machine already tracks from
        the recorded ball history. Self-tracking stays authoritative
        either way -- this never changes state or scoring, only logs a
        mismatch. A disagreement here would mean either self-tracking
        drifted (a real bug) or the hardware's own notion is stale (also
        worth knowing), so it's a signal to investigate, not something to
        resolve by silently trusting one side over the other. Call sites
        should only call this when hardware_ball_number is not None
        (main.py's on_status_event does) -- with nothing decoding/
        forwarding it yet, this is currently unreachable in practice, not
        because the logic is unfinished but because there's nothing to
        call it with; no further changes will be needed here once
        uart_bridge starts sending it."""
        ls = self._lane()
        bowler_id = self._current_bowler_id()
        if bowler_id is None:
            return
        tracked = ls.current_ball_number(bowler_id)
        if tracked is not None and tracked != hardware_ball_number:
            log.warning(
                "Lane %s: ball-number mismatch -- self-tracked %s, pinsetter reports %s",
                self.lane_number, tracked, hardware_ball_number,
            )

    # ---- internals ----
    def _lane(self) -> game_state.LaneState:
        return game_state.get_lane(self.lane_number)

    def _current_bowler_id(self) -> str | None:
        ls = self._lane()
        if not ls.game or not ls.game.bowler_ids:
            return None
        return ls.game.bowler_ids[self.current_bowler_idx % len(ls.game.bowler_ids)]

    @staticmethod
    def _current_frame_status(ls: game_state.LaneState, bowler_id: str) -> tuple[bool, int]:
        """frames() always returns all 10 frame entries regardless of how
        many balls have actually been thrown, so frames()[-1] is always
        frame 10 -- not "whichever frame is in progress." Find the frame
        the just-thrown ball actually landed in: the last one with any
        balls recorded. (A frame's own `balls` list is stable once
        populated -- later balls fill later frames, never rewrite an
        earlier one -- so "last non-empty" is a safe, stable definition.)
        Returns (turn_over, ball_number) -- ball_number is this frame's
        ball count so far (the just-recorded ball's position within it,
        1st/2nd/...), for MSG_SCORE_EVENT's `code` field (PROTOCOL.md) --
        see _record_ball's send_score_event call."""
        frames = ls.frames(bowler_id)
        in_progress = [f for f in frames if f["balls"]]
        current = in_progress[-1] if in_progress else frames[0]
        return current["turnOver"], len(current["balls"])

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

    def _record_ball(self, pinfall: int, send_command: bool, pin_mask: int | None = None) -> None:
        ls = self._lane()
        bowler_id = self._current_bowler_id()
        if bowler_id is None:
            raise InvalidTransitionError(f"lane {self.lane_number}: no active game/bowler to record a ball for")

        ls.record_ball(bowler_id, pinfall, pin_mask)
        turn_over, ball_number = self._current_frame_status(ls, bowler_id)

        if send_command:
            if turn_over:
                self._bridge.send_rerack(self.lane_number)
            else:
                self._bridge.send_cycle(self.lane_number)

        if pin_mask is not None:
            # Broadcasts MSG_SCORE_EVENT onto the mesh (PROTOCOL.md) --
            # informational only today (no node currently acts on it, see
            # ESPNOW.md's "Known gaps" -- it's for a future display node),
            # so this only fires when there's a real per-pin observation to
            # report. A manual entry's plain count has no mask to put in
            # pinfallMask, and broadcasting a fabricated/zero one would
            # misrepresent it as "no pins fell" rather than "unknown."
            self._bridge.send_score_event(self.lane_number, ball_number, pin_mask, int(time.time() * 1000))

        if turn_over:
            self._advance_to_next_active_bowler(ls)

        # Same completion check on_cycle_complete() uses, run here too --
        # not just there -- because a vision-only flow (no beam events, no
        # explicit /cycle-complete) never calls on_cycle_complete() at all
        # (see on_pinfall_observed()'s docstring). Without this, the very
        # LAST ball of the whole game would leave the machine stuck
        # reporting PINSETTER_BUSY forever, since nothing else would ever
        # arrive to flip it to GAME_COMPLETE. For every ball except the
        # last, _all_bowlers_done() is false and this is identical to the
        # old unconditional PINSETTER_BUSY.
        self.state = State.GAME_COMPLETE if self._all_bowlers_done() else State.PINSETTER_BUSY

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
