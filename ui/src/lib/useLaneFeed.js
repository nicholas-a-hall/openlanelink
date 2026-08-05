import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyBall, computeUp, currentTotal, emptyGame, gameComplete,
  isStrike, mkBowler, nextThrow, STRIKE,
} from "./scoring.js";

/* ═══════════════════════════════════════════════════════════════════
   DUMMY BACKEND STAND-IN

   This hook is the ONLY place that fakes data. Its return shape —
   { lane, actions } — is meant to be exactly what a real connection to
   the compute node's per-lane WebSocket will eventually provide:
   `lane` is the live game-state snapshot, `actions` are the same verbs
   a tablet sends upstream (addBowler / removeBowler / correctBall /
   setPinsetterRunning). Swapping the simulated interval below for a
   real `ws.onmessage` + `ws.send(...)` should not require touching any
   component that consumes this hook.
   ═══════════════════════════════════════════════════════════════════ */

const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

const NAMES = [
  "Alex", "Jordan", "Sam", "Casey", "Morgan", "Riley", "Quinn", "Taylor",
  "Drew", "Avery", "Reese", "Blake", "Dana", "Emery", "Parker", "Skyler",
];
const BOWLERS_PER_LANE = 6;

function randomBowlerNames(count) {
  const pool = [...NAMES];
  const picked = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

function fmtTime() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function fullDeck() {
  return Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 1]));
}

/* Recreational-league-ish bowlers, not pros: modest strike/spare rates and
   a real chance of an outright gutter ball on either delivery, with the
   rest skewed toward middling pin counts rather than clearing the rack.
   `standing` is how many pins are still up; pass `10` for a fresh frame's
   first ball. Previously this reused the same `r` draw for both the
   strike check and the pin count, which happened to make a first-ball
   gutter (0-2 pins) mathematically impossible — fixed here along with the
   skill-level rebalance. */
function simulateBallPins(standing, isFirstBall) {
  const clearChance = isFirstBall ? 0.10 : 0.22; // strike, or spare
  const gutterChance = isFirstBall ? 0.16 : 0.14;
  const r = Math.random();
  if (r < clearChance) return standing;
  if (r < clearChance + gutterChance) return 0;
  // everything else: skewed toward the low-middle of what's left standing
  const skew = Math.pow(Math.random(), 1.7);
  const range = Math.max(standing - 1, 1);
  return Math.max(1, Math.min(standing - 1, Math.floor(skew * range) + 1));
}

function initialLane(laneId) {
  return {
    laneId,
    maintenance: false,
    bowlers: randomBowlerNames(BOWLERS_PER_LANE).map(mkBowler),
    pins: fullDeck(),
    flashPins: [],
    ballSpeed: rand(9, 16),
    alert: null,
    lastEvent: "",
    events: [{ ts: fmtTime(), type: "sys", msg: "lane online" }],
    nightlyPins: 0,
    strikes: 0,
    deliveries: 0,
    stops: 0,
    jams: 0,
  };
}

export function useLaneFeed(laneId) {
  const [lane, setLane] = useState(() => initialLane(laneId));
  const [running, setRunning] = useState(true);
  const laneIdRef = useRef(laneId);

  // Re-seed when the route's laneId changes (e.g. dev nav between lanes).
  useEffect(() => {
    if (laneIdRef.current !== laneId) {
      laneIdRef.current = laneId;
      setLane(initialLane(laneId));
    }
  }, [laneId]);

  const addLog = useCallback((type, msg) => {
    setLane((prev) => ({
      ...prev,
      events: [{ ts: fmtTime(), type, msg }, ...prev.events].slice(0, 6),
    }));
  }, []);

  /* ── simulated delivery: stands in for a real pinsetter/gateway event ── */
  const tick = useCallback(() => {
    setLane((prev) => {
      const up = computeUp(prev.bowlers);
      if (!up || prev.maintenance) return prev;
      const nt = nextThrow(up.frames);
      if (!nt) return prev;

      const frame = up.frames[nt.frame] || [];
      let standing = 10;
      if (nt.ball > 0 && nt.frame < 9) {
        const first = frame[0];
        if (first != null && first !== STRIKE) standing = 10 - first;
      }
      const pins = simulateBallPins(standing, nt.ball === 0);

      const newFrames = applyBall(up.frames, nt.frame, nt.ball, pins);
      const newBowlers = prev.bowlers.map((b) => (b.id === up.id ? { ...b, frames: newFrames } : b));

      // visual pin-deck knockdown for this delivery
      const deckBefore = nt.ball === 0 ? fullDeck() : prev.pins;
      const upPins = Object.keys(deckBefore).map(Number).filter((p) => deckBefore[p] === 1);
      const toKnock = upPins.sort(() => Math.random() - 0.5).slice(0, pins);
      const newDeck = { ...deckBefore };
      toKnock.forEach((p) => { newDeck[p] = 0; });

      // did this ball close the frame? -> deck resets full for the next delivery
      const after = nextThrow(newFrames);
      const frameClosed = !after || after.frame !== nt.frame;
      const finalDeck = frameClosed ? fullDeck() : newDeck;

      const isTrueStrike = nt.ball === 0 && pins === 10;
      const isGutter = pins === 0;

      let msg;
      if (isTrueStrike) msg = "STRIKE — all 10 cleared";
      else if (isGutter) msg = "gutter ball — no pins down";
      else msg = `delivery — ${pins} pin${pins === 1 ? "" : "s"} down`;

      const nextEvents = [
        { ts: fmtTime(), lane: laneId, type: isTrueStrike ? "strike" : "", msg },
        ...prev.events,
      ].slice(0, 6);

      return {
        ...prev,
        bowlers: newBowlers,
        pins: finalDeck,
        flashPins: toKnock,
        lastEvent: isTrueStrike ? "strike" : "",
        ballSpeed: rand(9, 16),
        deliveries: prev.deliveries + 1,
        strikes: prev.strikes + (isTrueStrike ? 1 : 0),
        stops: prev.stops + (isGutter ? 1 : 0),
        nightlyPins: prev.nightlyPins + pins,
        events: nextEvents,
      };
    });

    // clear the flash after a beat
    setTimeout(() => {
      setLane((prev) => ({ ...prev, flashPins: [] }));
    }, 450);
  }, [laneId]);

  /* ── occasional pinsetter jam, independent of delivery cadence ── */
  const maybeJam = useCallback(() => {
    if (Math.random() > 0.08) return;
    setLane((prev) => ({ ...prev, alert: "jam", jams: prev.jams + 1 }));
    addLog("alert", "pinsetter jam");
    setTimeout(() => {
      setLane((prev) => ({ ...prev, alert: null, pins: fullDeck() }));
      addLog("sys", "jam cleared");
    }, 3500);
  }, [addLog]);

  useEffect(() => {
    if (!running) return;
    const evInt = setInterval(tick, rand(3000, 4600));
    const jamInt = setInterval(maybeJam, 9000);
    return () => { clearInterval(evInt); clearInterval(jamInt); };
  }, [running, tick, maybeJam]);

  /* ── auto-restart the game once every bowler has finished ── */
  useEffect(() => {
    const allDone = lane.bowlers.length > 0 && lane.bowlers.every((b) => gameComplete(b.frames));
    if (!allDone) return;
    const t = setTimeout(() => {
      setLane((prev) => ({
        ...prev,
        bowlers: prev.bowlers.map((b) => ({ ...b, frames: emptyGame() })),
      }));
      addLog("sys", "game complete — new game starting");
    }, 4000);
    return () => clearTimeout(t);
  }, [lane.bowlers, addLog]);

  /* ── actions: same shape a tablet will send upstream to the compute node ── */
  const addBowler = useCallback((name) => {
    setLane((prev) => (prev.bowlers.length >= 12 ? prev : { ...prev, bowlers: [...prev.bowlers, mkBowler(name)] }));
  }, []);

  const removeBowler = useCallback((id) => {
    setLane((prev) => ({ ...prev, bowlers: prev.bowlers.filter((b) => b.id !== id) }));
  }, []);

  const correctBall = useCallback((bowlerId, frameIdx, ballIdx, pins) => {
    setLane((prev) => ({
      ...prev,
      bowlers: prev.bowlers.map((b) =>
        b.id === bowlerId ? { ...b, frames: applyBall(b.frames, frameIdx, ballIdx, pins) } : b
      ),
    }));
  }, []);

  const setPinsetterRunning = useCallback((v) => setRunning(v), []);

  // Memoized so `actions` has a stable identity across renders — every
  // individual action fn is already useCallback'd, but the wrapping
  // object literal was being recreated every render (lane state ticks
  // every few seconds), which breaks any consumer that puts `actions` in
  // a dependency array (found this while testing: a one-shot effect with
  // `[actions]` never survived long enough to fire).
  const actions = useMemo(
    () => ({ addBowler, removeBowler, correctBall, setPinsetterRunning }),
    [addBowler, removeBowler, correctBall, setPinsetterRunning]
  );

  return { lane, running, actions };
}

export { currentTotal, computeUp, isStrike };
