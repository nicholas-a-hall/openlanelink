/* ═══════════════════════════════════
   PRESENTATIONAL HELPERS ONLY

   Scoring itself is backend-authoritative now (state_machine/game_state.py) --
   this file used to be a full second scoring engine (frame boundaries,
   strike/spare detection, running totals), which is exactly the
   client/server duplication game_state.py's own docstring flags as the
   thing to avoid ("Once the UI is wired to this API it should stop
   computing scores itself and just render what it's given"). The backend
   is also multi-game-type now (ten-pin/no-tap/duckpin, see
   state_machine/game_types.py) with real per-game-type rules (duckpin's 3rd-ball
   clear scores flat with no bonus, unlike a spare) that this file's old
   scoreGame() never knew about and would have scored wrong.

   What's left here only ever DERIVES from data the backend already
   computed and sent -- nothing here decides what counts as a strike/spare
   or computes a running total from raw balls. See API.md §3.1 for the
   exact `Frame` shape this expects: `{ frame, balls, complete, turnOver,
   frameScore, runningTotal }`, one per element of a bowler's 10-element
   `frames` array, straight from the backend's score_game() output.
   ═══════════════════════════════════ */
export const STRIKE = 10;

/* How a single ball should be displayed in its box. Takes the raw
   per-frame `balls` array (frame.balls), not the frame object itself. */
export function ballGlyph(balls, idx, isTenth) {
  const v = balls[idx];
  if (v == null) return "";
  if (v === STRIKE) return "X";
  if (idx > 0 && balls[idx - 1] != null && balls[idx - 1] !== STRIKE && balls[idx - 1] + v === 10) return "/";
  if (isTenth && v === STRIKE) return "X";
  if (v === 0) return "-";
  return String(v);
}

/* Most recent resolved running total, or 0 if nothing's scored yet
   (mirrors the old currentTotal's fallback for an empty/fresh game). */
export function currentTotal(frames) {
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i].runningTotal != null) return frames[i].runningTotal;
  }
  return 0;
}

/* Is this bowler's whole game finished -- exactly the backend's own
   game-complete check (frames.py's _bowler_done): the LAST frame's
   `complete` flag, regardless of frame count (10 for every game type
   today, but not hardcoded here). */
export function gameComplete(frames) {
  return frames.length > 0 && frames[frames.length - 1].complete;
}

/* Which frame/ball is up next for this bowler -- the first frame that
   hasn't had its turn end yet (backend's `turnOver`), and however many
   balls are already recorded in it. Returns null once the game is
   complete. frame is 0-indexed to match how callers already index into
   the `frames` array (frames[nt.frame]). */
export function nextThrow(frames) {
  const f = frames.find((fr) => !fr.turnOver);
  if (!f) return null;
  return { frame: f.frame - 1, ball: f.balls.length };
}

/* Extended per-bowler stats (BowlerStatsPanel and friends) -- pure
   derivations over the backend's `frames`, same principle as everything
   else in this file: computed once, here, from real data, not
   independently in a component. */
export function countStrikes(frames) {
  return frames.flatMap((f) => f.balls).filter((p) => p === STRIKE).length;
}

export function countSpares(frames) {
  let n = 0;
  for (const f of frames) {
    const b = f.balls;
    if (b.length >= 2 && b[0] !== STRIKE && b[0] + b[1] === 10) n++;
  }
  return n;
}

export function pinfall(frames) {
  return frames.flatMap((f) => f.balls).reduce((a, b) => a + b, 0);
}
