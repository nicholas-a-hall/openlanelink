import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useLaneFeed } from "../../lib/useLaneFeed.js";
import { ballGlyph, STRIKE } from "../../lib/scoring.js";
import { T } from "../../lib/theme.js";

/* Neumorphic raised/recessed helpers, tuned for the tablet control screen
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

const PIN_ROWS = [[7, 8, 9, 10], [4, 5, 6], [2, 3], [1]];

function FrameCell({ frame, frameIdx, running, isTenth, isUp, upBall, onTap, isActive }) {
  const boxes = isTenth ? 3 : 2;
  const cellBorder = "1px solid rgba(255,255,255,0.04)";
  return (
    <div
      onClick={() => onTap(frameIdx)}
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
            <div key={i} style={{
              flex: 1, borderLeft: i === 0 ? "none" : cellBorder,
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

function ScoreRow({ bowler, isActive, isWinner = false, onTapFrame, currentFrame, currentBall }) {
  const total = bowler.totalScore;
  // currentFrame/currentBall come straight from the state machine's own
  // snapshot (lane.currentFrame/currentBall) -- only meaningful for
  // whichever bowler is actually active, never re-derived from frames here.
  const up = isActive && currentFrame != null ? { frame: currentFrame - 1, ball: currentBall - 1 } : null;
  const isUpTurn = !!up;

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
        }}>{total}</div>
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

function PinPicker({ knockedDown, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "4px 0" }}>
      {PIN_ROWS.map((row, ri) => (
        <div key={ri} style={{ display: "flex", gap: 10 }}>
          {row.map((pin) => {
            const down = knockedDown.has(pin);
            return (
              <button key={pin} onClick={() => !down && onChange(pin)} disabled={down} style={{
                width: 44, height: 44, borderRadius: "50%", border: "none",
                cursor: down ? "default" : "pointer", fontSize: 14, fontWeight: 700,
                color: down ? T.muted : T.text, fontFamily: "'JetBrains Mono',monospace",
                ...(down ? recessed(22) : raised(22)), opacity: down ? 0.4 : 1,
                transition: "transform 120ms ease, opacity 200ms ease",
              }}>{pin}</button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function CorrectionModal({ bowler, frameIdx, onCommit, onClose }) {
  const frame = bowler.frames[frameIdx]?.balls || [];
  const isTenth = frameIdx === bowler.frames.length - 1;
  const [ballIdx, setBallIdx] = useState(0);
  const [knocked, setKnocked] = useState(new Set());
  const ballsInFrame = isTenth ? 3 : 2;

  // Cap how many pins can be selected for this ball — a non-strike first
  // ball in frames 1-9 only leaves (10 - first) standing. The identity of
  // *which* pins those are isn't reconstructible from the frame array (only
  // the count is stored), so the picker doesn't pre-lock specific pins.
  const maxSelectable = useMemo(() => {
    if (ballIdx === 0) return 10;
    if (!isTenth) {
      const first = frame[0];
      return first != null && first !== STRIKE ? 10 - first : 10;
    }
    return 10;
  }, [ballIdx, frame, isTenth]);

  const commitBall = (pins) => {
    onCommit(frameIdx, ballIdx, pins);
    setKnocked(new Set());
    if (ballIdx + 1 < ballsInFrame) setBallIdx(ballIdx + 1);
    else onClose();
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(5,4,10,0.72)", backdropFilter: "blur(3px)",
      display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 50,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        ...raised(20), width: "100%", maxWidth: 480, padding: "20px 18px 26px",
        borderTopLeftRadius: 20, borderTopRightRadius: 20,
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
            {bowler.name} · Frame {frameIdx + 1} · Ball {ballIdx + 1}
          </div>
          <button onClick={onClose} style={{
            width: 30, height: 30, borderRadius: "50%", border: "none", cursor: "pointer",
            color: T.muted, background: "rgba(0,0,0,0.3)", fontSize: 15,
          }}>✕</button>
        </div>

        <PinPicker knockedDown={knocked} onChange={(pin) => {
          setKnocked((prev) => {
            const next = new Set(prev);
            if (next.has(pin)) next.delete(pin);
            else if (next.size < maxSelectable) next.add(pin);
            return next;
          });
        }} />

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button onClick={() => commitBall(0)} style={{
            flex: 1, padding: "12px 0", fontSize: 13, fontWeight: 700, color: T.muted,
            border: "none", cursor: "pointer", ...raised(11),
          }}>Gutter (0)</button>
          <button
            onClick={() => commitBall(Math.min(knocked.size, maxSelectable))}
            style={{
              flex: 2, padding: "12px 0", fontSize: 14, fontWeight: 800, color: T.bg,
              border: "none", cursor: "pointer", borderRadius: 11,
              background: `linear-gradient(145deg, ${T.red}, #b83020)`,
              boxShadow: `4px 4px 10px ${T.shadowD}`,
            }}
          >Confirm {knocked.size} pin{knocked.size === 1 ? "" : "s"}</button>
        </div>
      </div>
    </div>
  );
}

function RosterBar({ bowlers, activeId, onAdd, onRemove }) {
  const [name, setName] = useState("");
  const full = bowlers.length >= 12;
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
          placeholder={full ? "Lane full (12 max)" : "Add bowler…"} disabled={full}
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

      <RosterBar bowlers={lane.bowlers} activeId={activeBowler?.id} onAdd={actions.addBowler} onRemove={actions.removeBowler} />

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
            onTapFrame={(frameIdx) => setEditing({ bowlerId: b.id, frameIdx })}
            currentFrame={lane.currentFrame} currentBall={lane.currentBall}
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
          bowler={editingBowler} frameIdx={editing.frameIdx}
          onCommit={(frameIdx, ballIdx, pins) => actions.correctBall(editingBowler.id, frameIdx, ballIdx, pins)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
