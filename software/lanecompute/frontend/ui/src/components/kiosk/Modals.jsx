import { useState } from "react";
import { K } from "./theme.jsx";
import { LABEL, MONO, sunken } from "./styles.js";
import Modal, { ModalButton } from "./Modal.jsx";

/* The three things the bowler terminal has to ask for: a name, a number,
   and a yes/no. All built on Modal (centred overlay -- see its docstring). */

export function TextPromptModal({ title, label, initial = "", confirmLabel = "Save", onCommit, onClose }) {
  const [value, setValue] = useState(initial);
  const valid = value.trim().length > 0;
  const commit = () => {
    if (!valid) return;
    onCommit(value.trim());
    onClose();
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton tone="accent" wide disabled={!valid} onClick={commit}>{confirmLabel}</ModalButton>
        </>
      }
    >
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        placeholder={label}
        style={{
          ...sunken(12),
          width: "100%",
          padding: "16px 18px",
          fontSize: 20,
          color: K.text,
          outline: "none",
          fontFamily: "inherit",
        }}
      />
    </Modal>
  );
}

/* Adding a bowler takes a name AND their handicap in one go.

   These arrive together in real life -- a league bowler knows their
   handicap and says it in the same breath as their name -- and the roster
   is entered once, at the start, by somebody working through a group.
   Making the handicap a second trip (add the name, find them in the list,
   open the pad) meant it was usually just skipped, which is how you end up
   with a scoreboard that quietly scores a handicap league scratch.

   The handicap is optional and defaults to 0: most bowlers don't have one,
   so it's an inline field rather than a required step, and the name alone
   is enough to commit. */
export function AddBowlerModal({ maxHandicap = 300, onCommit, onClose }) {
  const [name, setName] = useState("");
  const [handicap, setHandicap] = useState("");
  const value = handicap === "" ? 0 : parseInt(handicap, 10);
  const tooBig = value > maxHandicap;
  const valid = name.trim().length > 0 && !tooBig;

  const commit = () => {
    if (!valid) return;
    onCommit(name.trim(), value);
    onClose();
  };

  return (
    <Modal
      title="Who's bowling?"
      onClose={onClose}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton tone="accent" wide disabled={!valid} onClick={commit}>Add</ModalButton>
        </>
      }
    >
      <div style={{ ...LABEL, marginBottom: 8 }}>Name</div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        placeholder="Name"
        style={{
          ...sunken(12), width: "100%", padding: "16px 18px", fontSize: 20,
          color: K.text, outline: "none", fontFamily: "inherit",
        }}
      />

      <div style={{ ...LABEL, margin: "18px 0 8px" }}>Handicap — optional</div>
      <input
        value={handicap}
        // inputMode/pattern so a touch keyboard opens on digits; the regex
        // strip is what actually enforces it, since inputMode is a hint.
        inputMode="numeric"
        pattern="[0-9]*"
        onChange={(e) => setHandicap(e.target.value.replace(/\D/g, "").slice(0, 3))}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        placeholder="0"
        style={{
          ...sunken(12), width: "100%", padding: "16px 18px", fontSize: 20,
          color: tooBig ? K.danger : K.text, outline: "none",
          fontFamily: MONO, fontVariantNumeric: "tabular-nums",
        }}
      />
      <div style={{ marginTop: 8, fontSize: 13, color: tooBig ? K.danger : K.textDim }}>
        {tooBig ? `Maximum is ${maxHandicap}` : "Pins added to their score. Leave blank for scratch."}
      </div>
    </Modal>
  );
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"];

export function NumberPadModal({ title, initial = 0, max = 300, onCommit, onClose }) {
  // Held as a string so a half-typed "1" isn't rendered as 1 while the
  // bowler is still reaching for the 2, and so clearing shows an empty pad
  // rather than a 0 they have to delete.
  const [digits, setDigits] = useState(initial ? String(initial) : "");
  const value = digits === "" ? 0 : parseInt(digits, 10);
  const tooBig = value > max;

  const press = (k) => {
    if (k === "clear") return setDigits("");
    if (k === "back") return setDigits((d) => d.slice(0, -1));
    setDigits((d) => (d === "0" ? k : (d + k).slice(0, 3)));
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      maxWidth={400}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton tone="accent" wide disabled={tooBig} onClick={() => { onCommit(value); onClose(); }}>Save</ModalButton>
        </>
      }
    >
      <div style={{
        ...sunken(12),
        padding: "16px 18px",
        marginBottom: 16,
        textAlign: "center",
        fontFamily: MONO,
        fontSize: 40,
        fontWeight: 800,
        letterSpacing: 2,
        color: tooBig ? K.danger : K.text,
        fontVariantNumeric: "tabular-nums",
      }}>{digits === "" ? "0" : digits}</div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {KEYS.map((k) => {
          const isWord = k.length > 1;
          return (
            <button key={k} className="k-btn" onClick={() => press(k)} style={{
              padding: "18px 0",
              fontSize: isWord ? 13 : 24,
              fontWeight: 700,
              fontFamily: isWord ? "inherit" : MONO,
              color: isWord ? K.textDim : K.text,
              letterSpacing: isWord ? 1 : 0,
              textTransform: "uppercase",
            }}>{k === "back" ? "⌫" : k}</button>
          );
        })}
      </div>

      {tooBig && (
        <div style={{ marginTop: 12, textAlign: "center", color: K.danger, fontSize: 13, fontWeight: 700 }}>
          Maximum is {max}
        </div>
      )}
    </Modal>
  );
}

export function ConfirmModal({ title, message, confirmLabel = "Confirm", danger = false, onConfirm, onClose }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      maxWidth={440}
      footer={
        <>
          <ModalButton onClick={onClose}>Cancel</ModalButton>
          <ModalButton tone={danger ? "danger" : "green"} wide onClick={() => { onConfirm(); onClose(); }}>
            {confirmLabel}
          </ModalButton>
        </>
      }
    >
      <div style={{ fontSize: 17, lineHeight: 1.55, color: K.text }}>{message}</div>
    </Modal>
  );
}
