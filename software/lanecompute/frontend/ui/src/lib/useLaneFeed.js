import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ═══════════════════════════════════════════════════════════════════
   REAL COMPUTE-NODE CONNECTION

   Was a dummy backend stand-in (see HANDOFF.md's history) -- now a real
   WebSocket subscription to the compute node's per-lane feed
   (state_machine/api.py's /ws/display/{lane}, read-only) plus REST calls for
   every mutating action, matching that service's actual design: WS never
   carries commands, only state/event broadcasts. Return shape is still
   { lane, running, actions } so consuming components don't need to
   change -- see API.md for the exact wire shapes this now produces/sends.

   Games are no longer started from here. This hook used to auto-POST
   /games whenever an IDLE lane had bowlers on it, and again a few seconds
   after GAME_COMPLETE. That was the right call when nothing else could
   start one -- but a lane is now activated explicitly (by the bowler
   terminal, or eventually the siteserver bus; see the backend's
   session.py), and every game after the first is the party tapping "play
   another game". An auto-restart would fight both of those: ending a game
   would immediately un-end itself. Starting a game is now an action a
   caller takes, never something this hook does behind their back.

   `running` no longer means anything server-side (there's no "pause
   accepting pinsetter events" endpoint) and setPinsetterRunning is gone;
   the old toggle was a pure simulator artifact.
   ═══════════════════════════════════════════════════════════════════ */

const DEFAULT_API_PORT = 8000;
const RECONNECT_DELAY_MS = 3000;
const MAX_EVENTS = 6;

function apiBase() {
  if (import.meta.env.VITE_BACKEND_URL) return import.meta.env.VITE_BACKEND_URL;
  return `${window.location.protocol}//${window.location.hostname}:${DEFAULT_API_PORT}`;
}

function wsUrl(laneId) {
  return `${apiBase().replace(/^http/, "ws")}/ws/display/${laneId}`;
}

function fmtTime() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

async function apiCall(laneId, path, options) {
  const res = await fetch(`${apiBase()}/api/lanes/${laneId}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

function emptyLane(laneId) {
  return {
    laneId,
    bowlers: [],
    gameType: null,
    gameEnded: false,
    // Backend-owned lane capacity (game_state.MAX_BOWLERS_PER_LANE). Never
    // hardcode a copy of this in a component -- a house that seats more per
    // lane changes one env var, not the UI.
    maxBowlers: 12,
    machineState: "IDLE",
    currentBowlerId: null,
    ballSpeed: null,
    // Lane activation / session (backend session.py). `active` false means
    // an idle lane -- nobody has it. `session` survives being ended so a
    // terminal can still show what just finished; `active` is the flag to
    // branch on, never `session != null`.
    active: false,
    session: null,
    // Open staff summons only (backend assistance.py). awaitingStaff is
    // specifically "a problem is open", which is what holds the clock -- a
    // pending server call leaves it false.
    assistance: [],
    awaitingStaff: false,
    // Bumped every time somebody explicitly SETS the turn (the backend's
    // "turn_set" event), as opposed to it advancing because a ball was
    // thrown. The overhead display holds back a natural turn change for a
    // few seconds so the finished score stays readable; a deliberate one
    // has to land immediately. A counter rather than a boolean so a repeat
    // set to the same bowler is still a distinguishable event.
    turnSetSeq: 0,
    connected: false,
    events: [{ ts: fmtTime(), type: "sys", msg: "connecting…" }],
  };
}

/* Flattened per-bowler ball list, used only to diff snapshots for the
   event log (see below) -- not part of the returned `lane` shape. */
function flatBalls(bowler) {
  return bowler.frames.flatMap((f) => f.balls);
}

export function useLaneFeed(laneId) {
  const [lane, setLane] = useState(() => emptyLane(laneId));
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const stopRef = useRef(false);
  const prevBallsRef = useRef(new Map()); // bowlerId -> flat balls, for delivery-diff events

  const addEvent = useCallback((type, msg) => {
    setLane((prev) => ({
      ...prev,
      events: [{ ts: fmtTime(), type, msg }, ...prev.events].slice(0, MAX_EVENTS),
    }));
  }, []);

  const applySnapshot = useCallback((data) => {
    // Diff against the previous snapshot to synthesize a delivery/strike
    // event -- the backend doesn't broadcast a distinct "event" for every
    // ball (only for ball_speed, pinsetter commands, assistance), so this
    // is the client's own signal for "something just happened" driving
    // EventLog/CelebrationLayer. Purely cosmetic derivation; scoring
    // itself never depends on it.
    const prevBalls = prevBallsRef.current;
    const nextBalls = new Map();
    for (const b of data.bowlers) {
      const balls = flatBalls(b);
      nextBalls.set(b.id, balls);
      const prev = prevBalls.get(b.id) || [];
      if (balls.length > prev.length) {
        const newest = balls[balls.length - 1];
        addEvent(
          newest === 10 ? "strike" : "",
          newest === 10 ? `${b.name} — STRIKE` : `${b.name} — ${newest} pin${newest === 1 ? "" : "s"} down`
        );
      }
    }
    prevBallsRef.current = nextBalls;

    setLane((prev) => ({
      ...prev,
      bowlers: data.bowlers,
      gameType: data.game?.gameType ?? null,
      gameEnded: data.game?.ended ?? false,
      maxBowlers: data.maxBowlers ?? prev.maxBowlers,
      machineState: data.machineState,
      currentBowlerId: data.currentBowlerId,
      active: data.laneActive,
      session: data.session,
      assistance: data.assistance ?? [],
      awaitingStaff: data.awaitingStaff ?? false,
      connected: true,
    }));
  }, [addEvent]);

  const connect = useCallback(() => {
    if (stopRef.current) return;
    const ws = new WebSocket(wsUrl(laneId));
    wsRef.current = ws;

    ws.onopen = () => {
      setLane((prev) => ({ ...prev, connected: true }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "state") {
        applySnapshot(msg.data);
      } else if (msg.type === "event" && msg.event === "ball_speed") {
        setLane((prev) => ({ ...prev, ballSpeed: msg.data.mph }));
      } else if (msg.type === "event" && msg.event === "assistance_requested") {
        addEvent("alert", msg.data?.kind === "service" ? "server requested" : "help requested");
      } else if (msg.type === "event" && msg.event === "assistance_resolved") {
        addEvent("sys", msg.data?.kind === "service" ? "server call cleared" : "problem resolved");
      } else if (msg.type === "event" && msg.event === "turn_set") {
        setLane((prev) => ({ ...prev, turnSetSeq: prev.turnSetSeq + 1 }));
      } else if (msg.type === "event" && msg.event === "lane_activated") {
        addEvent("sys", `lane activated (${msg.data?.source ?? "api"})`);
      } else if (msg.type === "event" && msg.event === "lane_deactivated") {
        addEvent("sys", "lane closed");
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return; // superseded by a newer connection
      setLane((prev) => ({ ...prev, connected: false }));
      if (stopRef.current) return;
      addEvent("sys", "connection lost — retrying…");
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => ws.close();
  }, [laneId, applySnapshot, addEvent]);

  useEffect(() => {
    stopRef.current = false;
    prevBallsRef.current = new Map();
    setLane(emptyLane(laneId));
    connect();
    return () => {
      stopRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId]);

  // ── actions: REST calls to the compute node ──
  // Every action resolves to { ok, data } or { ok: false, error } instead
  // of rejecting. The event log gets the failure either way, but the
  // bowler terminal needs to show a real "that didn't work" toast at the
  // point of the tap, and an action that rejects would either need a
  // .catch() at all ~12 call sites or produce unhandled rejections at the
  // ones that forgot.
  const run = useCallback((what, path, options) => {
    return apiCall(laneId, path, options).then(
      (data) => ({ ok: true, data }),
      (e) => {
        addEvent("sys", `couldn't ${what}: ${e.message}`);
        return { ok: false, error: e.message };
      }
    );
  }, [laneId, addEvent]);

  const post = useCallback((what, path, body) => run(what, path, {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), [run]);

  // Handicap travels with the name -- see api.py's BowlerCreate for why
  // it's part of creation rather than a follow-up call.
  const addBowler = useCallback((name, handicap = 0) =>
    post("add bowler", "/bowlers", { name, handicap }), [post]);

  const renameBowler = useCallback((id, name) => run("rename bowler", `/bowlers/${id}`, {
    method: "PUT", body: JSON.stringify({ name }),
  }), [run]);

  const setHandicap = useCallback((id, handicap) => run("set handicap", `/bowlers/${id}/handicap`, {
    method: "PUT", body: JSON.stringify({ handicap }),
  }), [run]);

  const removeBowler = useCallback((id) => run("remove bowler", `/bowlers/${id}`, { method: "DELETE" }), [run]);

  // Hand the turn to someone else -- for when the lane's rotation and the
  // people actually standing on it have drifted apart. Doesn't record or
  // remove a ball; fixing the frames themselves is correctBall.
  const setCurrentBowler = useCallback((id) => run("change whose turn it is", "/turn", {
    method: "PUT", body: JSON.stringify({ bowler_id: id }),
  }), [run]);

  // ── lane activation / session ──
  // activateLane starts the session AND the first game server-side (see
  // api.py's activate_lane); startGame is only ever the *next* scoresheet
  // for a lane that's already active.
  // `bowlers` is the point of this payload, not a convenience: the roster
  // travels WITH the activation so the scoresheet is instantiated around a
  // known set of players. The terminal collects names first and only then
  // confirms, so this list is complete when it's sent.
  const activateLane = useCallback((opts = {}) => post("start", "/activate", {
    mode: opts.mode ?? "timed",
    minutes: opts.minutes ?? null,
    games: opts.games ?? null,
    bowlers: (opts.bowlers ?? []).map((b) => ({ name: b.name, handicap: b.handicap ?? 0 })),
    source: "kiosk",
  }), [post]);

  const deactivateLane = useCallback(() => post("end session", "/deactivate"), [post]);

  const extendSession = useCallback((opts = {}) => post("extend", "/session/extend", {
    minutes: opts.minutes ?? null,
    games: opts.games ?? 1,
  }), [post]);

  const startGame = useCallback(() => post("start game", "/games", {}), [post]);

  const endGame = useCallback(() => post("end game", "/games/end"), [post]);

  // ── staff summons ──
  const requestAssistance = useCallback((kind, reason = null) =>
    post(kind === "service" ? "call a server" : "call for help", "/assistance", { kind, reason }), [post]);

  const resolveAssistance = useCallback((id) =>
    post("clear the call", `/assistance/${id}/resolve`), [post]);

  // ── pinsetter (mesh; 503s when the gateway link is down) ──
  const cyclePinsetter = useCallback(() => post("cycle the pinsetter", "/pinsetter/cycle"), [post]);

  const rerackPinsetter = useCallback(() => post("re-rack the pinsetter", "/pinsetter/rerack"), [post]);

  // Kept 0-indexed (frameIdx, ballIdx) at the call site -- matches how
  // CorrectionModal already addresses frames/balls -- and translated to
  // the backend's 1-indexed (frame_number, ball_in_frame) here, the one
  // place that needs to know about that difference.
  // pinMask is which pins fell (bit N-1 = pin N), or null when the caller
  // genuinely doesn't know. The pin pickers always know, and sending it is
  // what lets a later ball in the same frame grey out pins already down.
  const correctBall = useCallback((bowlerId, frameIdx, ballIdx, pins, pinMask = null) => run("correct score", `/bowlers/${bowlerId}/score`, {
    method: "PUT",
    body: JSON.stringify({
      frame_number: frameIdx + 1,
      ball_in_frame: ballIdx + 1,
      pinfall: pins,
      pin_mask: pinMask,
    }),
  }), [run]);

  const actions = useMemo(() => ({
    addBowler, renameBowler, setHandicap, removeBowler, correctBall, setCurrentBowler,
    activateLane, deactivateLane, extendSession, startGame, endGame,
    requestAssistance, resolveAssistance,
    cyclePinsetter, rerackPinsetter,
  }), [
    addBowler, renameBowler, setHandicap, removeBowler, correctBall, setCurrentBowler,
    activateLane, deactivateLane, extendSession, startGame, endGame,
    requestAssistance, resolveAssistance,
    cyclePinsetter, rerackPinsetter,
  ]);

  return { lane, actions };
}
