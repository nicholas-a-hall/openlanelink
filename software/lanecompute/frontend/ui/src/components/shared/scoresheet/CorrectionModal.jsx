import { T } from "../../../lib/theme.js";
import { PIN_ROWS, useBallCorrection } from "./useBallCorrection.js";

/* The control tablet's pin picker. Presentation only -- which ball, how
   many pins may be selected and what committing does all live in
   useBallCorrection, shared with the kiosk's own picker
   (../../kiosk/PinPickerModal.jsx), which draws the same rules in the
   kiosk's flat theme instead of these Midnight Arcade tokens. */

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

function PinPicker({ knockedDown, alreadyDown, onChange }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "4px 0" }}>
      {PIN_ROWS.map((row, ri) => (
        <div key={ri} style={{ display: "flex", gap: 10 }}>
          {row.map((pin) => {
            const down = knockedDown.has(pin);
            // Already taken down by an earlier ball this frame -- inert and
            // struck through, so the deck still shows ten pins rather than
            // looking like one went missing.
            const already = !!alreadyDown?.has(pin);
            return (
              <button
                key={pin}
                onClick={already ? undefined : () => onChange(pin)}
                disabled={already}
                title={already ? "Already down from an earlier ball this frame" : undefined}
                style={{
                  width: 44, height: 44, borderRadius: "50%", border: "none",
                  cursor: already ? "default" : "pointer",
                  fontSize: 14, fontWeight: 700,
                  color: already || down ? T.muted : T.text, fontFamily: "'JetBrains Mono',monospace",
                  textDecoration: already ? "line-through" : "none",
                  ...(already || down ? recessed(22) : raised(22)),
                  opacity: already ? 0.35 : down ? 0.4 : 1,
                  transition: "transform 120ms ease, opacity 200ms ease",
                }}
              >{pin}</button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function CorrectionModal({ bowler, frameIdx, onCommit, onClose }) {
  const { ballIdx, knocked, alreadyDown, togglePin, commitSelected, commitGutter } =
    useBallCorrection({ bowler, frameIdx, onCommit, onClose });

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(5,4,10,0.72)", backdropFilter: "blur(3px)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20, zIndex: 50,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        ...raised(20), width: "100%", maxWidth: 480, padding: "20px 18px 26px",
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

        <PinPicker knockedDown={knocked} alreadyDown={alreadyDown} onChange={togglePin} />

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button onClick={commitGutter} style={{
            flex: 1, padding: "12px 0", fontSize: 13, fontWeight: 700, color: T.muted,
            border: "none", cursor: "pointer", ...raised(11),
          }}>Gutter (0)</button>
          <button
            onClick={commitSelected}
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
