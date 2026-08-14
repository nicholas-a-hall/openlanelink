import { K } from "./theme.jsx";
import { MONO, filled } from "./styles.js";
import Modal, { ModalButton } from "./Modal.jsx";
import { PIN_ROWS, useBallCorrection } from "../shared/scoresheet/useBallCorrection.js";

/* The kiosk's pin deck: tap the pins that actually went down.

   Same rules as the control tablet's picker -- both call
   useBallCorrection -- drawn in the kiosk's flat theme. A knocked-down pin
   is filled and dimmed rather than "pressed in"; on a flat surface there's
   no shadow pair to invert, so state has to read from fill and opacity.

   Pins stay tappable after selection so a mis-tap can be undone, which the
   old picker didn't allow (it disabled them outright, and a bowler who hit
   the wrong pin had to cancel the whole correction and start again). */

/* Three states, not two:
   - standing: tappable
   - down (this ball): filled accent
   - already down (an earlier ball this frame): inert and struck through,
     so it's visible that the pin exists and is accounted for, rather than
     silently missing from a deck that would then look wrong. */
function Pin({ pin, down, already, onToggle }) {
  return (
    <button
      className="k-btn"
      onClick={already ? undefined : onToggle}
      disabled={already}
      aria-pressed={down}
      aria-label={`Pin ${pin}${already ? ", already down from an earlier ball" : down ? ", down" : ", standing"}`}
      title={already ? "Already down from an earlier ball this frame" : undefined}
      style={{
        width: 52, height: 52, borderRadius: 26, flexShrink: 0,
        fontSize: 15, fontWeight: 800, fontFamily: MONO,
        ...(already
          ? { background: K.sunken, color: K.textFaint, textDecoration: "line-through" }
          : down
            ? { background: K.accent, borderColor: K.accent, color: K.accentInk }
            : { background: K.panel, color: K.text }),
      }}
    >{pin}</button>
  );
}

export default function PinPickerModal({ bowler, frameIdx, ballIdx = 0, onCommit, onClose }) {
  const { knocked, alreadyDown, togglePin, commitSelected, commitGutter } =
    useBallCorrection({ bowler, frameIdx, ballIdx, onCommit, onClose });

  return (
    <Modal
      title={`${bowler.name} · Frame ${frameIdx + 1} · Ball ${ballIdx + 1}`}
      onClose={onClose}
      maxWidth={420}
      footer={
        <>
          <ModalButton onClick={commitGutter}>Gutter (0)</ModalButton>
          <ModalButton tone="accent" wide onClick={commitSelected}>
            Confirm {knocked.size} pin{knocked.size === 1 ? "" : "s"}
          </ModalButton>
        </>
      }
    >
      <div style={{ marginBottom: 14, fontSize: 14, color: K.textDim, textAlign: "center" }}>
        {alreadyDown?.size
          ? "Tap the pins that went down. Struck-through pins were already down."
          : "Tap the pins that went down."}
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        {PIN_ROWS.map((row, ri) => (
          <div key={ri} style={{ display: "flex", gap: 10 }}>
            {row.map((pin) => (
              <Pin
                key={pin}
                pin={pin}
                down={knocked.has(pin)}
                already={!!alreadyDown?.has(pin)}
                onToggle={() => togglePin(pin)}
              />
            ))}
          </div>
        ))}
      </div>

      <div style={{
        ...filled(K.bgAccent, K.text, 10),
        marginTop: 16, padding: "10px 14px", textAlign: "center",
        fontFamily: MONO, fontSize: 15, fontWeight: 800, borderColor: K.line,
      }}>
        {knocked.size} down
      </div>
    </Modal>
  );
}
