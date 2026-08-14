import { useEffect } from "react";
import { K } from "./theme.jsx";
import { LABEL } from "./styles.js";

/* The one dialog shell every kiosk modal is built from.

   Centred, not a bottom sheet. The sheets this replaced put their controls
   in a strip along the bottom edge, which is fine on a phone held in one
   hand and wrong on the two screens this actually runs on: a portrait lane
   console where the bottom edge is below the counter, and a landscape
   monitor where it strands the buttons a long way from the content they
   act on. Centred reads the same at every size.

   Sizing is by content, capped by the viewport (`max-height: 100%` against
   the padded scrim), so a two-line confirmation is a small box and a
   ten-frame list is a tall scrolling one -- without either being able to
   grow past the screen. Only .k-modal-body scrolls; the title and the
   buttons stay put. */

export default function Modal({ title, onClose, footer, children, maxWidth = 480, zIndex = 60 }) {
  // Escape closes. Kiosks get keyboards attached more often than you'd
  // think (staff diagnostics, an accessibility switch), and a dialog with
  // no keyboard exit is a dead end when the touchscreen is being awkward.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="k-scrim"
      onClick={onClose}
      // position:fixed takes it out of flow but NOT out of the DOM tree, so
      // it's still a descendant of [data-kiosk] and its var() lookups
      // inherit the current scheme. Portalling it to <body> would break
      // exactly that.
      //
      // zIndex is a prop because the score-edit flow stacks two of these:
      // the pin picker opens over the frame list, and closing it has to
      // reveal that list again rather than the lane screen.
      style={{ zIndex }}
    >
      <div
        className="k-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth }}
      >
        <div className="k-modal-head">
          <div style={{ ...LABEL, fontSize: 12 }}>{title}</div>
          <button
            className="k-btn"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 40, height: 40, borderRadius: 20, flexShrink: 0,
              fontSize: 17, color: K.textDim, lineHeight: 1,
            }}
          >✕</button>
        </div>

        <div className="k-modal-body">{children}</div>

        {footer && <div className="k-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* Footer buttons. `tone` picks the fill: null is the quiet one (cancel),
   "accent"/"green"/"danger" are the committing ones. Text colour always
   travels with the fill -- see styles.js's filled(). */
export function ModalButton({ tone = null, wide = false, disabled = false, onClick, children }) {
  const fills = {
    accent: { background: K.accent, color: K.accentInk, border: `1px solid ${K.accent}` },
    green: { background: K.green, color: K.greenInk, border: `1px solid ${K.green}` },
    danger: { background: K.danger, color: K.accentInk, border: `1px solid ${K.danger}` },
  };
  return (
    <button
      className="k-btn"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        flex: wide ? 2 : 1,
        padding: "15px 0",
        fontSize: 15,
        fontWeight: 800,
        letterSpacing: 0.4,
        ...(tone && !disabled ? fills[tone] : {}),
      }}
    >{children}</button>
  );
}
