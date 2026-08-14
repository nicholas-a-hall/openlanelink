import { K } from "./theme.jsx";
import { ballGlyph, displayTotal } from "../../lib/scoring.js";
import { LABEL, MONO, card, sunken } from "./styles.js";
import Modal from "./Modal.jsx";

/* Correcting a misread, in two steps behind an explicit "Edit score" tap:
   pick who, then pick which frame.

   Deliberately not an always-visible scoresheet. The overhead display is
   where scores are read; this terminal is where they're *changed*, and a
   permanently-tappable scoresheet on a console anyone can reach invites
   accidental edits. You have to say you want to edit first.

   The frame list is one frame per row in a single scrolling column, not
   the control screen's ten-across strip (see ControlLane's ScoreRow). Ten
   frames across a tablet gives each frame ~35px -- fine for staff reading
   a sheet, far too small as a touch target for a bowler picking the one
   they want to fix. Down the page each frame gets a full row, its own ball
   boxes at readable size, and its running total.

   Layered under the pin picker (zIndex 50 vs Modal's default 60): the
   picker opens on top of this list, and closing it returns here rather
   than dumping the bowler back to the lane screen mid-correction. */

function BallBoxes({ frame, isTenth }) {
  const boxes = isTenth ? 3 : 2;
  return (
    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
      {Array.from({ length: boxes }).map((_, i) => {
        const glyph = ballGlyph(frame.balls, i, isTenth);
        const isMark = glyph === "X" || glyph === "/";
        return (
          <div key={i} style={{
            ...sunken(8),
            width: 40, height: 40,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: MONO, fontSize: 17, fontWeight: 800,
            color: isMark ? K.accent : glyph ? K.text : K.textFaint,
          }}>{glyph || "·"}</div>
        );
      })}
    </div>
  );
}

function Row({ onClick, children, style, disabled = false }) {
  return (
    <button
      className="k-btn"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...card(12), width: "100%", padding: "11px 13px", textAlign: "left",
        display: "flex", alignItems: "center", gap: 13, ...style,
      }}
    >{children}</button>
  );
}

function BowlerStep({ bowlers, currentBowlerId, onPick }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...LABEL, marginBottom: 2 }}>Whose score?</div>
      {bowlers.map((b) => (
        <Row key={b.id} onClick={() => onPick(b)}>
          {b.id === currentBowlerId && (
            <span aria-hidden="true" style={{
              width: 9, height: 9, borderRadius: 5, background: K.accent, flexShrink: 0,
            }} />
          )}
          <span style={{
            flex: 1, minWidth: 0, fontSize: 18, fontWeight: 700, color: K.text,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>{b.name}</span>
          <span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 800, color: K.text }}>
            {displayTotal(b)}
          </span>
          {b.handicap > 0 && (
            <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: K.green }}>
              +{b.handicap}
            </span>
          )}
          <span aria-hidden="true" style={{ fontSize: 18, color: K.textFaint }}>›</span>
        </Row>
      ))}
    </div>
  );
}

function FrameStep({ bowler, onPick, onBack }) {
  const lastIdx = bowler.frames.length - 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <button
        className="k-btn"
        onClick={onBack}
        style={{
          alignSelf: "flex-start", padding: "10px 16px",
          fontSize: 13, fontWeight: 800, color: K.textDim, letterSpacing: 0.4,
        }}
      >‹ All bowlers</button>

      <div style={{ ...LABEL, marginBottom: 2 }}>{bowler.name} — which frame?</div>

      {bowler.frames.map((frame, i) => {
        const isTenth = i === lastIdx;
        const thrown = frame.balls.length > 0;
        /* A frame can only be edited if it has balls in it, or it's the one
           this bowler is on -- the backend can overwrite a recorded ball or
           add the next one, but it can't write into a frame that hasn't
           been reached (there's nowhere to put the gap; see
           game_state.edit_score). Offering those rows anyway just produced
           a rejection toast, so they're inert. */
        const editable = thrown || bowler.currentFrame === i + 1;
        return (
          <Row
            key={i}
            onClick={editable ? () => onPick(i) : undefined}
            disabled={!editable}
            style={editable ? null : { opacity: 0.45 }}
          >
            <span style={{
              width: 26, flexShrink: 0, fontFamily: MONO, fontSize: 15, fontWeight: 800,
              color: K.textDim, textAlign: "center",
            }}>{i + 1}</span>
            <BallBoxes frame={frame} isTenth={isTenth} />
            <span style={{
              flex: 1, textAlign: "right", fontFamily: MONO, fontSize: 20, fontWeight: 800,
              color: frame.runningTotal == null ? K.textFaint : K.text,
            }}>{frame.runningTotal == null ? "—" : frame.runningTotal}</span>
          </Row>
        );
      })}
    </div>
  );
}

export default function ScoreEditModal({ bowlers, currentBowlerId, selectedBowler, onPickBowler, onPickFrame, onBack, onClose }) {
  return (
    <Modal title="Edit score" onClose={onClose} maxWidth={520} zIndex={50}>
      {selectedBowler
        ? <FrameStep bowler={selectedBowler} onPick={onPickFrame} onBack={onBack} />
        : <BowlerStep bowlers={bowlers} currentBowlerId={currentBowlerId} onPick={onPickBowler} />}
    </Modal>
  );
}
