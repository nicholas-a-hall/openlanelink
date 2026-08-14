"""How long a lane is sold for -- the bowler-terminal session, not the game.

Deliberately separate from game_state.py the same way assistance.py is: a
session is a commercial fact about the lane (this party has it for an hour,
or for three games), while game_state.py is scoring math and
state_machine.py is ball-by-ball orchestration. A lane can have several
games inside one session, and neither owns the other -- ending a game
doesn't end the session, and a session outliving its current scoresheet is
the normal state of a party between games.

Lifecycle -- a session IS the lane being active:
- An idle lane is one with no live session. It sits there waiting to be
  activated, from either of two places: a bowler starting a game on the
  kiosk, or (not built yet) the siteserver's message bus telling this
  compute node a lane has been sold. Both land on start() below, which is
  why nothing in here knows which one called it beyond the `source` tag --
  a future bus consumer is another caller of the same entry point, not a
  second way to do this. Activating auto-starts the first game (see
  api.py's activate_lane).
- Deactivating the lane (POST .../deactivate) ends the session and returns
  the lane to idle. Front-of-house does this to turn a lane over, and the
  kiosk's own "End session" button hits the same endpoint -- one path, so
  a lane handed back by the party and a lane taken back by staff land in
  exactly the same state. Ending a *game* is a separate, smaller act that
  leaves the session running.

This is the piece that came over from openlanescheduler's kiosk, where the
same countdown was derived client-side from a walk-in record
(`openedAt + hours + serviceCallMs + grace`) held in that project's state.
It lives here now: openlanescheduler still gets summoned for a service call
(see assistance.py), but it is no longer the source of truth for how much
time a lane has left, and this compute node keeps running a session with
the scheduler unreachable.

Pausing: a session's clock stops while staff are being waited on for a
*problem* (USBC-style "we're not bowling until this is fixed") and starts
again once it's resolved -- the same allowance openlanescheduler made by
accumulating `serviceCallMs` onto the walk-in's end time, done here by
holding the clock instead of extending the end. pause()/resume() are
idempotent so the caller can drive them straight from "is there an open
problem right now" (see api.py's _sync_session_pause) rather than
maintaining a counter that can drift out of sync with the real request
list.
"""

import os
import time
import uuid
from dataclasses import dataclass

# A timed session bought without an explicit length, and how much a single
# "extend time" tap adds. Both in minutes, env-configurable so a house that
# sells half-hours doesn't need a code change.
DEFAULT_SESSION_MINUTES = int(os.environ.get("SESSION_DEFAULT_MINUTES", "60"))
EXTEND_MINUTES = int(os.environ.get("SESSION_EXTEND_MINUTES", "60"))

MODE_TIMED = "timed"
MODE_GAMES = "games"
MODES = (MODE_TIMED, MODE_GAMES)

# Who activated the lane. Recorded for provenance only -- nothing branches
# on it, since an activation from the kiosk and one from the siteserver bus
# have to produce exactly the same lane state (see the module docstring).
SOURCE_KIOSK = "kiosk"
SOURCE_SITESERVER = "siteserver"
SOURCE_API = "api"


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class Session:
    """One party's claim on the lane. `duration_ms`/`games_purchased` are
    the *current* totals including anything extend() has added -- the
    original purchase isn't kept separately, only the count of extensions,
    since nothing downstream needs to distinguish the two."""

    id: str
    lane_number: int
    mode: str
    started_at_ms: int
    source: str = SOURCE_API
    duration_ms: int = 0        # timed mode only
    games_purchased: int = 0    # games mode only
    games_started: int = 0
    extensions: int = 0
    paused_total_ms: int = 0
    paused_at_ms: int | None = None
    ended_at_ms: int | None = None

    @property
    def paused(self) -> bool:
        return self.paused_at_ms is not None

    def paused_ms(self, now_ms: int) -> int:
        """Total time this session has spent held, including the pause
        currently in progress (if any) up to `now_ms`."""
        held = self.paused_total_ms
        if self.paused_at_ms is not None:
            held += max(0, now_ms - self.paused_at_ms)
        return held

    def remaining_ms(self, now_ms: int) -> int | None:
        """None in games mode -- there's no clock to run down. Floored at 0
        rather than going negative: "how much is left" is never less than
        nothing, and `expired` below is what says the difference between
        "just ran out" and "ran out twenty minutes ago"."""
        if self.mode != MODE_TIMED:
            return None
        elapsed = now_ms - self.started_at_ms - self.paused_ms(now_ms)
        return max(0, self.duration_ms - elapsed)

    def ends_at_ms(self, now_ms: int) -> int | None:
        """Wall-clock instant the session runs out. Only meaningful while
        the clock is actually running -- every second spent paused pushes
        this later, so a paused session's clients must render
        `remaining_ms` (which holds still) instead of counting down to
        this."""
        if self.mode != MODE_TIMED:
            return None
        return self.started_at_ms + self.duration_ms + self.paused_ms(now_ms)

    def snapshot(self, now_ms: int | None = None) -> dict:
        now_ms = _now_ms() if now_ms is None else now_ms
        remaining = self.remaining_ms(now_ms)
        return {
            "id": self.id,
            "mode": self.mode,
            "source": self.source,
            "startedAtMs": self.started_at_ms,
            "endedAtMs": self.ended_at_ms,
            "ended": self.ended_at_ms is not None,
            "durationMs": self.duration_ms if self.mode == MODE_TIMED else None,
            "endsAtMs": self.ends_at_ms(now_ms),
            "remainingMs": remaining,
            "expired": remaining == 0 if remaining is not None else False,
            "gamesPurchased": self.games_purchased if self.mode == MODE_GAMES else None,
            "gamesStarted": self.games_started,
            "gamesRemaining": max(0, self.games_purchased - self.games_started) if self.mode == MODE_GAMES else None,
            "extensions": self.extensions,
            "paused": self.paused,
            "pausedAtMs": self.paused_at_ms,
            "pausedTotalMs": self.paused_ms(now_ms),
        }


class SessionError(Exception):
    """A session command that doesn't make sense right now (starting one on
    a lane that already has a live session, extending one that isn't
    running)."""


class LaneSession:
    """The current (or most recently ended) session for one lane. One
    instance per lane this compute node covers -- see get_lane_session().

    An ended session is kept, not dropped, so the terminal can still show
    "you finished at 8:42" until the next party starts one. Anything asking
    "is this lane sold right now" wants active(), not current."""

    def __init__(self, lane_number: int):
        self.lane_number = lane_number
        self.current: Session | None = None

    def active(self) -> Session | None:
        """The live session, or None if the lane has never had one or its
        last one has ended."""
        if self.current is None or self.current.ended_at_ms is not None:
            return None
        return self.current

    def _require_active(self) -> Session:
        s = self.active()
        if s is None:
            raise SessionError(f"lane {self.lane_number} has no active session")
        return s

    def start(
        self,
        mode: str = MODE_TIMED,
        minutes: int | None = None,
        games: int | None = None,
        source: str = SOURCE_API,
    ) -> Session:
        """Activate the lane for a party -- from the kiosk or the siteserver
        bus, same call either way (see the module docstring). Refuses to
        replace a session that's still running: ending one is always the
        explicit deactivate act, never a side effect of somebody hitting
        start twice."""
        if mode not in MODES:
            raise SessionError(f"unknown session mode {mode!r}, expected one of {'/'.join(MODES)}")
        if self.active() is not None:
            raise SessionError(f"lane {self.lane_number} already has an active session")

        if mode == MODE_TIMED:
            minutes = DEFAULT_SESSION_MINUTES if minutes is None else minutes
            if minutes <= 0:
                raise SessionError(f"a timed session needs a positive length, got {minutes} minute(s)")
            duration_ms, games_purchased = minutes * 60_000, 0
        else:
            games = 1 if games is None else games
            if games <= 0:
                raise SessionError(f"a per-game session needs at least one game, got {games}")
            duration_ms, games_purchased = 0, games

        self.current = Session(
            id=uuid.uuid4().hex[:8],
            lane_number=self.lane_number,
            mode=mode,
            started_at_ms=_now_ms(),
            source=source,
            duration_ms=duration_ms,
            games_purchased=games_purchased,
        )
        return self.current

    def end(self) -> Session:
        """Deactivate: close the session out. Stamps the end time and
        releases any hold -- a lane that ends while paused shouldn't leave a
        dangling paused_at_ms that a later snapshot would keep growing
        paused_total_ms from."""
        s = self._require_active()
        now = _now_ms()
        if s.paused_at_ms is not None:
            s.paused_total_ms += max(0, now - s.paused_at_ms)
            s.paused_at_ms = None
        s.ended_at_ms = now
        return s

    def extend(self, minutes: int | None = None, games: int = 1) -> Session:
        """"Extend time" and "play another game" are the same button on the
        terminal -- which one it means is decided by the session's mode, not
        by the caller, so the UI doesn't have to branch on it."""
        s = self._require_active()
        if s.mode == MODE_TIMED:
            minutes = EXTEND_MINUTES if minutes is None else minutes
            if minutes <= 0:
                raise SessionError(f"an extension needs a positive length, got {minutes} minute(s)")
            s.duration_ms += minutes * 60_000
        else:
            if games <= 0:
                raise SessionError(f"an extension needs at least one game, got {games}")
            s.games_purchased += games
        s.extensions += 1
        return s

    def note_game_started(self) -> None:
        """Count a scoresheet against a per-game session. No-op when there's
        no session (a lane being scored without one is allowed -- see
        api.py's add_game) and harmless in timed mode, where gamesStarted is
        reported but nothing is metered against it."""
        s = self.active()
        if s is not None:
            s.games_started += 1

    def pause(self) -> Session | None:
        """Hold the clock. Idempotent: pausing an already-paused session
        does nothing, so callers can drive this straight from "is a problem
        open right now" without tracking edges themselves."""
        s = self.active()
        if s is None or s.paused_at_ms is not None:
            return s
        s.paused_at_ms = _now_ms()
        return s

    def resume(self) -> Session | None:
        """Start the clock again, banking however long the hold lasted onto
        paused_total_ms. Idempotent, same reasoning as pause()."""
        s = self.active()
        if s is None or s.paused_at_ms is None:
            return s
        s.paused_total_ms += max(0, _now_ms() - s.paused_at_ms)
        s.paused_at_ms = None
        return s

    def snapshot(self) -> dict:
        return {"session": self.current.snapshot() if self.current else None}


_SESSIONS: dict[int, LaneSession] = {}


def get_lane_session(lane_number: int) -> LaneSession:
    if lane_number not in _SESSIONS:
        _SESSIONS[lane_number] = LaneSession(lane_number)
    return _SESSIONS[lane_number]
