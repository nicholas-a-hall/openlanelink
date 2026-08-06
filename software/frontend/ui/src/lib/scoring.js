/* ═══════════════════════════════════
   SHARED 10-PIN SCORING ENGINE
   Single source of truth for both the display and control screens —
   ported from lunar-lanes-scoring.jsx. Frames store raw per-ball pin
   counts; running totals and glyphs are always DERIVED, never stored,
   so auto-fed results (later: real pinsetter events over the compute
   node's WebSocket) and manual tablet corrections flow through the
   same path.
   ═══════════════════════════════════ */
export const STRIKE = 10;

export function emptyGame() {
  return Array.from({ length: 10 }, () => []);
}

export function isStrike(frame) {
  return frame[0] === STRIKE;
}

export function isSpare(frame) {
  return (
    frame.length >= 2 &&
    frame[0] !== STRIKE &&
    frame[0] != null &&
    frame[1] != null &&
    frame[0] + frame[1] === 10
  );
}

export function scoreGame(frames) {
  const result = [];
  let total = 0;
  const flat = [];
  const startIdx = [];
  for (let f = 0; f < 10; f++) {
    startIdx[f] = flat.length;
    for (const b of frames[f] || []) if (b != null) flat.push(b);
  }
  for (let f = 0; f < 10; f++) {
    const frame = frames[f] || [];
    const start = startIdx[f];
    if (f < 9) {
      if (isStrike(frame)) {
        const b1 = flat[start + 1], b2 = flat[start + 2];
        if (b1 === undefined || b2 === undefined) { result.push({ running: null, complete: false }); continue; }
        total += 10 + b1 + b2;
        result.push({ running: total, complete: true });
      } else if (isSpare(frame)) {
        const b1 = flat[start + 2];
        if (b1 === undefined) { result.push({ running: null, complete: false }); continue; }
        total += 10 + b1;
        result.push({ running: total, complete: true });
      } else {
        const a = frame[0], b = frame[1];
        if (a == null || b == null) { result.push({ running: null, complete: false }); continue; }
        total += a + b;
        result.push({ running: total, complete: true });
      }
    } else {
      const a = frame[0], b = frame[1], c = frame[2];
      const earnsBonus = a === STRIKE || (a != null && b != null && a + b === 10);
      if (a == null || b == null) { result.push({ running: null, complete: false }); continue; }
      if (earnsBonus && c == null) { result.push({ running: null, complete: false }); continue; }
      total += (a || 0) + (b || 0) + (earnsBonus ? c || 0 : 0);
      result.push({ running: total, complete: true });
    }
  }
  return result;
}

export function currentTotal(frames) {
  const s = scoreGame(frames);
  for (let i = s.length - 1; i >= 0; i--) if (s[i].running !== null) return s[i].running;
  return 0;
}

export function nextThrow(frames) {
  for (let f = 0; f < 10; f++) {
    const frame = frames[f] || [];
    if (f < 9) {
      if (frame[0] === STRIKE) continue;
      if (frame.length < 2) return { frame: f, ball: frame.length };
    } else {
      const a = frame[0], b = frame[1];
      const earnsBonus = a === STRIKE || (a != null && b != null && a + b === 10);
      const need = earnsBonus ? 3 : 2;
      if (frame.length < need) return { frame: f, ball: frame.length };
    }
  }
  return null;
}

export function gameComplete(frames) {
  return nextThrow(frames) === null;
}

/* How a single ball should be displayed in its box. */
export function ballGlyph(frame, idx, isTenth) {
  const v = frame[idx];
  if (v == null) return "";
  if (v === STRIKE) return "X";
  if (idx > 0 && frame[idx - 1] != null && frame[idx - 1] !== STRIKE && frame[idx - 1] + v === 10) return "/";
  if (isTenth && v === STRIKE) return "X";
  if (v === 0) return "-";
  return String(v);
}

/* Extended per-bowler stats (BowlerStatsPanel and friends) — pure
   derivations over `frames`, same as everything else in this file, so
   nothing displaying a bowler's numbers ever needs its own copy of this
   logic or a value computed anywhere other than the raw ball data. */
export function countStrikes(frames) {
  return frames.flat().filter((p) => p === STRIKE).length;
}

export function countSpares(frames) {
  let n = 0;
  for (let i = 0; i < 9; i++) if (isSpare(frames[i] || [])) n++;
  const tenth = frames[9] || [];
  if (tenth.length >= 2 && tenth[0] !== STRIKE && (tenth[0] ?? 0) + (tenth[1] ?? 0) === 10) n++;
  return n;
}

export function pinfall(frames) {
  return frames.flat().filter((p) => p != null).reduce((a, b) => a + b, 0);
}

/* Apply a ball result to a bowler's frames immutably. Returns NEW frames.
   Single mutation path — used by both auto-fed deliveries and manual
   tablet corrections. */
export function applyBall(frames, frameIdx, ballIdx, pins) {
  const next = frames.map((f) => f.slice());
  const frame = next[frameIdx];
  while (frame.length <= ballIdx) frame.push(null);
  frame[ballIdx] = pins;
  while (frame.length && frame[frame.length - 1] == null) frame.pop();
  return next;
}

let _bowlerId = 0;
export function mkBowler(name) {
  return { id: ++_bowlerId, name, frames: emptyGame() };
}

/* Is this bowler mid-frame — thrown ball 1 but frame not yet closed?
   They keep the turn until the frame completes. */
export function midFrame(frames) {
  const nt = nextThrow(frames);
  if (!nt) return false;
  const f = frames[nt.frame] || [];
  return f.length > 0 && f.length < (nt.frame === 9 ? 3 : 2) && nt.ball > 0;
}

function framesDone(frames) {
  let n = 0;
  for (let i = 0; i < 9; i++) {
    const f = frames[i] || [];
    if (f[0] === STRIKE || f.length >= 2) n++;
  }
  return n;
}

/* Whose turn is it? In-progress frame wins; otherwise the bowler who has
   completed the fewest frames, ties broken by roster order. */
export function computeUp(bowlers) {
  const playing = bowlers.filter((b) => !gameComplete(b.frames));
  if (playing.length === 0) return null;
  const inProgress = playing.find((b) => midFrame(b.frames));
  if (inProgress) return inProgress;
  let best = playing[0], bestCount = framesDone(best.frames);
  for (const b of playing.slice(1)) {
    const c = framesDone(b.frames);
    if (c < bestCount) { best = b; bestCount = c; }
  }
  return best;
}
