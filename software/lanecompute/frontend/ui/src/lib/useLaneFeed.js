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

   Auto-restarts a new game a few seconds after the lane reaches
   GAME_COMPLETE (product decision -- see PR discussion). `running` no
   longer means anything server-side (there's no "pause accepting
   pinsetter events" endpoint) and setPinsetterRunning is gone; the old
   toggle was a pure simulator artifact.
   ═══════════════════════════════════════════════════════════════════ */

const DEFAULT_API_PORT = 8000;
const RECONNECT_DELAY_MS = 3000;
const NEW_GAME_DELAY_MS = 4000; // matches the old simulator's pacing
const ROSTER_SETTLE_MS = 800; // debounce so back-to-back bowler adds don't double-start a game
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
    machineState: "IDLE",
    currentBowlerId: null,
    ballSpeed: null,
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
  const newGameTimerRef = useRef(null);
  const stopRef = useRef(false);
  const startingGameRef = useRef(false); // guards against a duplicate POST /games race
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
      machineState: data.machineState,
      currentBowlerId: data.currentBowlerId,
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
        addEvent("alert", "assistance requested");
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
      clearTimeout(newGameTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId]);

  // ── start a game automatically: a short debounce after bowlers first
  // exist on an otherwise-idle lane, or a few seconds after GAME_COMPLETE
  // so the final score has a moment to be visible first. A fresh lane sits
  // in IDLE until POST /games is called -- nothing else starts one.
  //
  // The IDLE case MUST be debounced, not fired immediately: adding two
  // bowlers back-to-back broadcasts two separate state updates (bowlers
  // still empty->1, then 1->2), each re-running this effect. The first
  // POST /games often resolves (clearing startingGameRef's concurrency
  // guard) before the second bowler's broadcast even arrives, so a naive
  // immediate call fires twice -- the second add_game() snapshots
  // game.bowler_ids from whoever's in the roster *at that instant*, which
  // can be just the first bowler, permanently excluding the second from
  // that game's turn rotation (game_state.py's add_bowler/remove_bowler
  // now also keep an already-started game's bowler_ids in sync for the
  // same reason, but there's still no reason to double-call this). ──
  useEffect(() => {
    clearTimeout(newGameTimerRef.current);
    const startGame = () => {
      if (startingGameRef.current) return;
      startingGameRef.current = true;
      apiCall(laneId, "/games", { method: "POST", body: JSON.stringify({}) })
        .catch((e) => addEvent("sys", `couldn't start game: ${e.message}`))
        .finally(() => { startingGameRef.current = false; });
    };

    if (lane.machineState === "GAME_COMPLETE") {
      newGameTimerRef.current = setTimeout(startGame, NEW_GAME_DELAY_MS);
    } else if (lane.machineState === "IDLE" && lane.bowlers.length > 0) {
      newGameTimerRef.current = setTimeout(startGame, ROSTER_SETTLE_MS);
    }
    return () => clearTimeout(newGameTimerRef.current);
  }, [lane.machineState, lane.bowlers.length, laneId, addEvent]);

  // ── actions: REST calls to the compute node ──
  const addBowler = useCallback((name) => {
    apiCall(laneId, "/bowlers", { method: "POST", body: JSON.stringify({ name }) })
      .catch((e) => addEvent("sys", `couldn't add bowler: ${e.message}`));
  }, [laneId, addEvent]);

  const removeBowler = useCallback((id) => {
    apiCall(laneId, `/bowlers/${id}`, { method: "DELETE" })
      .catch((e) => addEvent("sys", `couldn't remove bowler: ${e.message}`));
  }, [laneId, addEvent]);

  // Kept 0-indexed (frameIdx, ballIdx) at the call site -- matches how
  // CorrectionModal already addresses frames/balls -- and translated to
  // the backend's 1-indexed (frame_number, ball_in_frame) here, the one
  // place that needs to know about that difference.
  const correctBall = useCallback((bowlerId, frameIdx, ballIdx, pins) => {
    apiCall(laneId, `/bowlers/${bowlerId}/score`, {
      method: "PUT",
      body: JSON.stringify({ frame_number: frameIdx + 1, ball_in_frame: ballIdx + 1, pinfall: pins }),
    }).catch((e) => addEvent("sys", `couldn't correct score: ${e.message}`));
  }, [laneId, addEvent]);

  const actions = useMemo(() => ({ addBowler, removeBowler, correctBall }), [addBowler, removeBowler, correctBall]);

  return { lane, actions };
}
