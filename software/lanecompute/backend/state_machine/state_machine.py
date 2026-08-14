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

# A single trip over the foul line produces several debounced FOUL edges in
# quick succession (stumble, scramble up, beam re-broken) -- this used to be
# suppressed on the gateway via its own per-lane cooldown timer, independent
# of any real game state. That was a scoring-relevant decision ("how many
# balls does this one physical trip actually affect") being made by hardware
# with no notion of whose ball it is, so it now lives here instead -- see
# on_foul(). TUNE ON REAL HARDWARE (matches the gateway's old default).
FOUL_COOLDOWN_S = 0.75


class State(Enum):
    IDLE = auto()              # no game started yet
    READY = auto()              # waiting for the current bowler's ball
    BALL_IN_FLIGHT = auto()     # upstream beam broken, waiting on the downstream beam or a foul
    AWAITING_PINFALL = auto()   # ball reached the pins, waiting on a pinfall count
    PINSETTER_BUSY = auto()     # cycle/rerack in flight (Pi-sent), waiting on STATUS_CYCLE_COMPLETE
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
        self._last_foul_at: float | None = None
        # The pinsetter's own last-reported ball (1 or 2) for this lane, from
        # StatusEvent.ball_number (MSG_STATUS's MachineRecord.flags ball
        # bit) -- see reconcile_ball_number(). None until a status event
        # with real ball data has arrived for this lane.
        self._reported_ball: int | None = None
        # How many more STATUS_CYCLE_COMPLETE events are still expected
        # before the pinsetter is actually done -- a rerack can take 2
        # sequenced solenoid pulses (see _rerack_cycle_count()), each
        # producing its OWN STATUS_CYCLE_COMPLETE, not one for the whole
        # rerack. Set whenever a command is sent (_record_ball), consumed
        # in on_cycle_complete().
        self._pending_cycle_completes = 0

    # ---- lifecycle ----
    def begin_game(self) -> None:
        """Call after game_state.LaneState.add_game() sets up a fresh
        scoresheet -- resets whose turn it is and opens the lane for the
        first ball."""
        self.current_bowler_idx = 0
        self.state = State.READY

    def set_current_bowler(self, bowler_id: str) -> None:
        """Hand the turn to a specific bowler.

        Whose turn it is is otherwise only ever moved by
        _advance_to_next_active_bowler, i.e. by balls actually being thrown.
        That's correct right up until the lane's idea of the rotation stops
        matching the people standing on it -- somebody bowls out of order,
        a ball gets recorded against the wrong person and corrected after
        the turn already moved on, a bowler is added mid-frame. Without
        this the only fix was resetting the lane and losing the scoresheet.

        Deliberately does NOT touch self.state. A lane that's PINSETTER_BUSY
        is still busy after the turn changes -- the pinsetter doesn't care
        who's up -- and forcing READY here would let a ball be recorded
        while the rack is still moving. The turn is the only thing this
        changes.

        Note this is a correction, not a delivery: it doesn't record or
        un-record anything, so the frames each bowler has already thrown are
        untouched. Fixing those is edit_score's job (game_state.py)."""
        ls = self._lane()
        game = ls.active_game()
        if game is None:
            raise InvalidTransitionError(f"lane {self.lane_number}: no game in progress to set a turn in")
        if bowler_id not in game.bowler_ids:
            raise InvalidTransitionError(
                f"lane {self.lane_number}: bowler {bowler_id} isn't in this game's rotation"
            )
        if self._bowler_done(ls, bowler_id):
            # Handing the turn to someone with no frames left would wedge
            # the lane: the next recorded ball raises "game already
            # complete" and nothing advances past them.
            raise InvalidTransitionError(
                f"lane {self.lane_number}: bowler {bowler_id} has already finished their game"
            )
        self.current_bowler_idx = game.bowler_ids.index(bowler_id)

    def end_game(self) -> None:
        """Call after game_state.LaneState.end_game() closes the scoresheet
        -- the bowlers keep the lane (their session is untouched), there's
        just nothing in progress to be READY for until they start another
        one. Like reset(), not guarded by current state: ending a game
        mid-ball or mid-cycle is a legitimate thing for a party to do and
        should never be refused."""
        self.current_bowler_idx = 0
        self.state = State.IDLE

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
        """USBC Rule 9. A foul counts as a ball delivered and scores zero;
        any pins it knocked down do NOT count and are respotted, so the
        bowler faces a full fresh rack for whatever they throw next. On
        ball 1 that means the frame stays open and they throw ball 2 at ten
        pins (clearing all ten there is a SPARE, not a strike -- score_game
        already derives that correctly from the recorded [0, 10]); on ball
        2 the frame simply ends. Both cases want the same thing from the
        pinsetter -- a full fresh rack -- which is force_rerack below.

        pin_mask=0 is the point of the explicit argument: "zero counting
        pins fell, so all ten are standing for the next ball." Recording
        None instead (as this used to) means "unknown", which makes
        game_state.standing_mask_before_next_ball() return None and leaves
        vision unable to score the REST of the frame after any foul -- it
        has no baseline to diff its observation against. A foul is one of
        the few events where the resulting pin state is known exactly
        rather than observed, so it should be recorded, not left unknown.

        A foul can land anywhere between READY and AWAITING_PINFALL (the
        bowler can cross the line before, during, or after the ball's
        flight). FOUL_COOLDOWN_S collapses one physical trip's several
        debounced edges into exactly one recorded ball."""
        if self.state not in (State.READY, State.BALL_IN_FLIGHT, State.AWAITING_PINFALL):
            log.warning("Lane %s: foul in state %s, ignored", self.lane_number, self.state.name)
            return
        now = time.monotonic()
        if self._last_foul_at is not None and now - self._last_foul_at < FOUL_COOLDOWN_S:
            log.info("Lane %s: foul within cooldown, ignored", self.lane_number)
            return
        self._last_foul_at = now
        self._record_ball(pinfall=0, send_command=True, pin_mask=0, force_rerack=True)

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
        """Fires once per individual solenoid pulse the pinsetter finishes,
        NOT once per rerack -- a rerack can be 2 sequenced pulses (see
        _rerack_cycle_count()), each sending its own STATUS_CYCLE_COMPLETE.
        Only the last expected one actually clears PINSETTER_BUSY; treating
        the first as "done" would mark the lane ready for a new ball while
        the pinsetter is still physically mid-rerack."""
        if self.state != State.PINSETTER_BUSY:
            log.warning("Lane %s: cycle complete in state %s, ignored", self.lane_number, self.state.name)
            return
        self._pending_cycle_completes = max(0, self._pending_cycle_completes - 1)
        if self._pending_cycle_completes > 0:
            log.info("Lane %s: cycle complete, %d more expected before ready", self.lane_number, self._pending_cycle_completes)
            return
        self.state = State.GAME_COMPLETE if self._all_bowlers_done() else State.READY

    def reconcile_ball_number(self, hardware_ball_number: int) -> None:
        """Records the pinsetter's own hardware-reported ball number
        (StatusEvent.ball_number -- MSG_STATUS's MachineRecord.flags ball
        bit, forwarded end-to-end as of 2026-08-07) as self._reported_ball
        -- this is now the ground truth _rerack_cycle_count() uses to
        decide how many solenoid cycles a rerack needs, replacing logic
        that used to live in pinsetter_node.ino's execRerack() (which
        derived it from the SAME counter locally instead, a decision that
        belongs here since this is the process with real game state).
        Scoring/turn-tracking itself (ls.current_ball_number(), whose
        turn it is) is untouched -- that stays entirely self-tracked from
        recorded ball history, independent of the pinsetter's own belief.
        Still cross-checks and logs a mismatch, same as before: a
        disagreement means either self-tracking drifted (a real bug) or
        the pinsetter's local toggle desynced (e.g. cycled from its own
        button -- see MachineState.ball's comment in pinsetter_node.ino),
        either way worth surfacing loudly rather than silently picking a
        side."""
        self._reported_ball = hardware_ball_number
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
        # active_game(), not .game: an ended scoresheet still exists to be
        # read, but nobody is "up" on it -- so a stray pinfall/foul arriving
        # after End game raises rather than silently appending a ball to a
        # finished game.
        game = self._lane().active_game()
        if not game or not game.bowler_ids:
            return None
        return game.bowler_ids[self.current_bowler_idx % len(game.bowler_ids)]

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
        game = ls.active_game()
        if not game:
            return True
        return all(self._bowler_done(ls, bid) for bid in game.bowler_ids)

    def _rerack_cycle_count(self) -> int:
        """How many solenoid cycles get the pinsetter from its own
        last-reported position (self._reported_ball, see
        reconcile_ball_number()) to a fresh full rack -- ported from
        pinsetter_node.ino's old execRerack() logic, which used to make
        this same 1-vs-2 decision locally from its own ball counter (see
        firmware/HANDOFF.md's "Next" list). 1 cycle if the pinsetter last
        reported ball 2; 2 cycles (sweep the standing rack, then spot
        fresh) for ball 1 OR when nothing's been reported yet -- matching
        the pinsetter's own prior default (MachineState boots assuming
        ball 1), so an unreported machine still gets a real fresh rack
        rather than an under-cycled one."""
        return 1 if self._reported_ball == 2 else 2

    def _record_ball(self, pinfall: int, send_command: bool, pin_mask: int | None = None, force_rerack: bool = False) -> None:
        ls = self._lane()
        bowler_id = self._current_bowler_id()
        if bowler_id is None:
            raise InvalidTransitionError(f"lane {self.lane_number}: no active game/bowler to record a ball for")

        ls.record_ball(bowler_id, pinfall, pin_mask)
        turn_over, ball_number = self._current_frame_status(ls, bowler_id)

        if send_command:
            if turn_over or force_rerack:
                cycle_count = self._rerack_cycle_count()
                self._bridge.send_rerack(self.lane_number, cycle_count)
            else:
                cycle_count = 1
                self._bridge.send_cycle(self.lane_number, cycle_count)
            # How many STATUS_CYCLE_COMPLETE events on_cycle_complete()
            # needs to see before this lane is actually ready again -- see
            # that method's docstring.
            self._pending_cycle_completes = cycle_count

        if pin_mask is not None:
            # Broadcasts MSG_SCORE_EVENT onto the mesh (PROTOCOL.md) --
            # informational only today (no node currently acts on it, see
            # ESPNOW.md's "Known gaps" -- it's for a future display node),
            # so this only fires when there's a real per-pin observation to
            # report. A manual entry's plain count has no mask to put in
            # pinfallMask, and broadcasting a fabricated/zero one would
            # misrepresent it as "no pins fell" rather than "unknown."
            #
            # monotonic, not time.time(): the wire field is a uint32 millis()
            # uptime counter (firmware/PROTOCOL.md), so epoch-ms overflowed it
            # and made every score event fail to encode -- see
            # protocol.py's encode_score_event().
            self._bridge.send_score_event(self.lane_number, ball_number, pin_mask, int(time.monotonic() * 1000))

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
