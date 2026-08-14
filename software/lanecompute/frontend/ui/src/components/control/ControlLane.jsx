import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useLaneFeed } from "../../lib/useLaneFeed.js";
import { T } from "../../lib/theme.js";
import { ballGlyph } from "../../lib/scoring.js";
import CorrectionModal from "../shared/scoresheet/CorrectionModal.jsx";

/* The tap-a-frame pin picker (CorrectionModal) moved to
   components/shared/scoresheet/ when the bowler terminal gained score
   correction — both screens post the same correction against the same
   endpoint, so they open the same picker. The scoresheet layout itself
   stayed here: this screen's dense 10-across strip and the terminal's
   one-frame-per-row list are genuinely different presentations of the same
   data, not one component with a flag.

   Neumorphic raised/recessed helpers, tuned for the tablet control screen
   (shares the Midnight Arcade tokens with the overhead display). */
const raised = (r = 14) => ({
  background: `linear-gradient(145deg, ${T.raised}, ${T.surface})`,
  borderRadius: r,
  boxShadow: `6px 6px 14px ${T.shadowD}, -5px -5px 12px ${T.shadowL}`,
});
const recessed = (r = 14) => ({
  background: `linear-gradient(145deg, ${T.surface}, ${T.raised})`,
  borderRadius: r,
  boxShadow: `inset 5px 5px 11px ${T.shadowD}, inset -4px -4px 10px ${T.shadowL}`,
});

function FrameCell({ frame, frameIdx, running, isTenth, isUp, upBall, onTap, isActive }) {
  const boxes = isTenth ? 3 : 2;
  const cellBorder = "1px solid rgba(255,255,255,0.04)";
  return (
    <div
      onClick={() => onTap(frameIdx, Math.min(frame.balls.length, (isTenth ? 3 : 2) - 1))}
      style={{
        flex: isTenth ? "1.5 1 0" : "1 1 0", minWidth: 0, display: "flex", flexDirection: "column",
        cursor: "pointer", borderRight: cellBorder, position: "relative",
        background: isUp ? "rgba(224,64,48,0.07)" : "transparent", transition: "background 240ms ease",
      }}
    >
      <div style={{ display: "flex", height: 30, borderBottom: cellBorder }}>
        {Array.from({ length: boxes }).map((_, i) => {
          const active = isUp && upBall === i;
          const glyph = ballGlyph(frame.balls, i, isTenth);
          const isMark = glyph === "X" || glyph === "/";
          return (
            <div key={i}
              onClick={(e) => { e.stopPropagation(); onTap(frameIdx, i); }}
              style={{
              flex: 1, borderLeft: i === 0 ? "none" : cellBorder, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 700, lineHeight: 1, fontFamily: "'JetBrains Mono','SF Mono',monospace",
              color: isMark
                ? (glyph === "X" ? (isActive ? T.red : "rgba(224,64,48,0.45)") : (isActive ? T.yellow : "rgba(224,192,48,0.45)"))
                : (isActive ? T.text : T.muted),
              background: active ? "rgba(224,192,48,0.16)" : "transparent",
              boxShadow: active ? "inset 0 0 0 1px rgba(224,192,48,0.5)" : "none",
              transition: "background 200ms ease",
            }}>{glyph}</div>
          );
        })}
      </div>
      <div style={{
        height: 32, display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 16, fontWeight: 800, fontFamily: "'JetBrains Mono','SF Mono',monospace",
        color: running == null ? T.muted : (isActive ? T.text : T.muted), letterSpacing: 0.5,
      }}>{running == null ? "" : running}</div>
    </div>
  );
}

function ScoreRow({ bowler, isActive, isWinner = false, onTapFrame }) {
  // Read off the bowler's OWN snapshot fields. These are well-defined for
  // every bowler on the roster, not just whoever has the turn (API.md
  // §3.1), and `isActive` is what decides whether to draw the highlight.
  //
  // These used to be passed in as `lane.currentFrame`/`lane.currentBall` —
  // fields that have never existed on the lane snapshot, only per bowler —
  // so `up` was always null and the "you're here" highlight silently never
  // rendered at all.
  const up = isActive && bowler.currentFrame != null
    ? { frame: bowler.currentFrame - 1, ball: bowler.currentBall - 1 }
    : null;
  const isUpTurn = !!up;
  const handicap = bowler.handicap ?? 0;

  return (
    <div style={{
      display: "flex", alignItems: "stretch", gap: 10, marginBottom: 10, padding: 8,
      ...(isActive ? raised(16) : recessed(16)),
      outline: isWinner ? "1px solid rgba(224,192,48,0.6)" : isUpTurn ? "1px solid rgba(224,64,48,0.35)" : "none",
      opacity: isActive ? 1 : 0.78, transition: "opacity 240ms ease, outline-color 240ms ease",
    }}>
      <div style={{ width: 96, flexShrink: 0, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 10px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {isUpTurn && (
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: T.red, boxShadow: `0 0 8px ${T.red}`, flexShrink: 0 }} />
          )}
          {isWinner && <span style={{ fontSize: 13, filter: `drop-shadow(0 0 6px ${T.yellow})` }}>★</span>}
          <span style={{
            fontSize: 14, fontWeight: 700, color: isActive ? T.text : T.muted,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: 0.3,
          }}>{bowler.name}</span>
        </div>
        <div style={{
          fontSize: 24, fontWeight: 800, color: isActive ? T.yellow : T.muted, marginTop: 2,
          fontFamily: "'JetBrains Mono',monospace", lineHeight: 1,
        }}>{bowler.totalScore}</div>
        {/* Scratch stays the big number; the handicapped total sits under
            it rather than replacing it, so nobody has to guess which one
            they're looking at. Hidden entirely at 0 — a scratch bowler
            shouldn't see a redundant second copy of their own score. */}
        {handicap > 0 && (
          <div style={{ fontSize: 11, fontWeight: 700, color: T.muted, fontFamily: "'JetBrains Mono',monospace", marginTop: 3 }}>
            +{handicap} = <span style={{ color: T.green }}>{bowler.totalWithHandicap}</span>
          </div>
        )}
      </div>

      <div style={{
        flex: 1, minWidth: 0, display: "flex", overflow: "hidden",
        ...(isActive ? recessed(10) : { borderRadius: 10, background: "rgba(0,0,0,0.18)", boxShadow: "none" }),
      }}>
        {bowler.frames.map((frame, fi) => (
          <FrameCell
            key={fi} frame={frame} frameIdx={fi} isTenth={fi === bowler.frames.length - 1}
            running={frame.runningTotal} isUp={up && up.frame === fi} upBall={up && up.frame === fi ? up.ball : -1}
            isActive={isActive} onTap={onTapFrame}
          />
        ))}
      </div>
    </div>
  );
}

function RosterBar({ bowlers, maxBowlers, activeId, onAdd, onRemove }) {
  const [name, setName] = useState("");
  // Backend-owned (game_state.MAX_BOWLERS_PER_LANE, in the lane snapshot) —
  // was a hardcoded 12 here, which would have silently disagreed with the
  // server the moment a house configured a different capacity.
  const full = bowlers.length >= maxBowlers;
  const add = () => {
    const n = name.trim();
    if (!n || full) return;
    onAdd(n);
    setName("");
  };
  return (
    <div style={{ ...raised(18), padding: 14, marginBottom: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {bowlers.map((b) => (
          <div key={b.id} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "7px 10px 7px 13px",
            borderRadius: 11, ...(b.id === activeId ? recessed(11) : raised(11)),
          }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: b.id === activeId ? T.yellow : T.text }}>{b.name}</span>
            <span style={{ fontSize: 12, color: T.muted, fontFamily: "monospace" }}>{b.totalScore}</span>
            <button onClick={() => onRemove(b.id)} style={{
              width: 20, height: 20, borderRadius: "50%", border: "none", cursor: "pointer",
              color: T.muted, background: "rgba(0,0,0,0.3)", fontSize: 12, lineHeight: 1,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder={full ? `Lane full (${maxBowlers} max)` : "Add bowler…"} disabled={full}
          style={{ flex: 1, padding: "12px 14px", fontSize: 14, color: T.text, border: "none", outline: "none", ...recessed(11), fontFamily: "inherit" }}
        />
        <button onClick={add} disabled={full || !name.trim()} style={{
          padding: "0 22px", fontSize: 14, fontWeight: 800,
          color: full || !name.trim() ? T.muted : T.bg, border: "none",
          cursor: full || !name.trim() ? "default" : "pointer", borderRadius: 11,
          background: full || !name.trim() ? undefined : `linear-gradient(145deg, ${T.red}, #b83020)`,
          boxShadow: full || !name.trim() ? "none" : `4px 4px 10px ${T.shadowD}`,
          ...(full || !name.trim() ? raised(11) : {}),
        }}>Add</button>
      </div>
    </div>
  );
}

export default function ControlLane() {
  const { laneId } = useParams();
  const { lane, actions } = useLaneFeed(laneId);
  const [editing, setEditing] = useState(null); // { bowlerId, frameIdx }

  const activeBowler = useMemo(
    () => lane.bowlers.find((b) => b.id === lane.currentBowlerId) ?? null,
    [lane.bowlers, lane.currentBowlerId]
  );
  const allComplete = lane.machineState === "GAME_COMPLETE";
  const topScore = useMemo(
    () => (allComplete ? Math.max(...lane.bowlers.map((b) => b.totalScore)) : null),
    [allComplete, lane.bowlers]
  );

  const editingBowler = editing && lane.bowlers.find((b) => b.id === editing.bowlerId);

  return (
    <div style={{
      minHeight: "100vh", width: "100%",
      background: `radial-gradient(circle at 30% 0%, ${T.bg}, #0c0a12)`,
      color: T.text, padding: "20px 16px 40px",
      fontFamily: "'Rajdhani','Inter',system-ui,sans-serif", boxSizing: "border-box",
    }}>
      <style>{`
        * { box-sizing: border-box; }
        @media (prefers-reduced-motion: reduce){ *{animation:none!important} }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <div style={{ fontSize: 12, letterSpacing: 3, textTransform: "uppercase", color: T.muted, fontWeight: 600 }}>OpenLane Scheduler</div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 1, color: T.text }}>Lane {String(laneId).padStart(2, "0")}</div>
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 9, padding: "9px 16px",
          color: T.text, fontSize: 13, fontWeight: 700, ...recessed(12),
        }}>
          <span style={{
            width: 9, height: 9, borderRadius: "50%",
            background: lane.connected ? T.yellow : T.muted,
            boxShadow: lane.connected ? `0 0 8px ${T.yellow}` : "none",
          }} />
          {lane.connected ? "Connected" : "Reconnecting…"}
        </div>
      </div>

      <RosterBar bowlers={lane.bowlers} maxBowlers={lane.maxBowlers} activeId={activeBowler?.id} onAdd={actions.addBowler} onRemove={actions.removeBowler} />

      {lane.bowlers.length === 0 ? (
        <div style={{ ...recessed(18), padding: "48px 20px", textAlign: "center", color: T.muted }}>
          No bowlers yet. Add a name above to start scoring.
        </div>
      ) : (
        lane.bowlers.map((b) => (
          <ScoreRow
            key={b.id} bowler={b}
            isActive={allComplete || activeBowler?.id === b.id}
            isWinner={allComplete && b.totalScore === topScore}
            onTapFrame={(frameIdx, ballIdx) => setEditing({ bowlerId: b.id, frameIdx, ballIdx })}
          />
        ))
      )}

      {allComplete ? (
        <div style={{
          marginTop: 16, padding: "14px 20px", textAlign: "center", ...raised(14),
          display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 12, letterSpacing: 3, textTransform: "uppercase", color: T.muted, fontWeight: 700 }}>Final</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: T.yellow }}>
            ★ {lane.bowlers.filter((b) => b.totalScore === topScore).map((b) => b.name).join(" & ")} — {topScore}
          </span>
        </div>
      ) : (
        <div style={{ marginTop: 14, fontSize: 12, color: T.muted, textAlign: "center" }}>
          Tap any frame to correct a misread · scores recompute automatically
        </div>
      )}

      {editing && editingBowler && (
        <CorrectionModal
          bowler={editingBowler} frameIdx={editing.frameIdx} ballIdx={editing.ballIdx}
          onCommit={(frameIdx, ballIdx, pins, pinMask) => actions.correctBall(editingBowler.id, frameIdx, ballIdx, pins, pinMask)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
