import { useCallback, useRef, useState } from "react";
import { K } from "./theme.jsx";

/* Transient confirmations for taps whose effect isn't visible on screen --
   a pinsetter cycle, a staff call going out, a REST call that failed
   because the gateway link is down. Anything that DOES show up in the lane
   snapshot (a bowler appearing, the clock stopping) doesn't get one; the
   state change is its own feedback. */

const DISMISS_MS = 4000;

export function useToasts() {
  const [toasts, setToasts] = useState([]);
  const nextId = useRef(0);

  const push = useCallback((message, tone = "ok") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), DISMISS_MS);
  }, []);

  /* Convenience for the common shape: fire an action, say so if it worked,
     surface the backend's own detail string if it didn't (a 503 from the
     UART bridge being down, or a 400 rejecting an impossible frame, are the
     two bowlers will actually hit). */
  const report = useCallback((promise, okMessage) => {
    promise.then((res) => {
      if (res?.ok) push(okMessage, "ok");
      else push(res?.error || "Something went wrong", "bad");
    });
  }, [push]);

  return { toasts, push, report };
}

/* Top of the screen, not the bottom. A bowler's hands and the ball are at
   the bottom of a lane console, so that's exactly where a confirmation is
   most likely to be missed -- and in landscape the bottom edge is furthest
   from where they're already looking (the clock and who's up). The top edge
   is the one place both orientations agree is in view.

   Loud on purpose: this is the only feedback for taps whose effect isn't
   visible on screen (a pinsetter cycle, a staff call going out), read at
   arm's length in a noisy room, and it's gone in four seconds. The glow is
   a coloured halo in the tone's own colour rather than a neutral drop
   shadow, so success and failure are distinguishable before the text is. */
export default function Toasts({ toasts }) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      style={{
        position: "fixed", left: 0, right: 0, top: "max(16px, env(safe-area-inset-top))",
        zIndex: 80, display: "flex", flexDirection: "column", alignItems: "center", gap: 10,
        pointerEvents: "none", padding: "0 16px",
      }}
    >
      {toasts.map((t) => {
        const bad = t.tone === "bad";
        const tone = bad ? K.danger : K.green;
        // A pre-mixed translucent token, NOT `${tone}66` -- tone is a
        // var() reference, and appending an alpha suffix to one yields an
        // invalid colour that takes the whole box-shadow down with it.
        const glow = bad ? K.glowBad : K.glowGood;
        return (
          <div key={t.id} className="k-toast" style={{
            background: K.panel,
            border: `2px solid ${tone}`,
            borderRadius: 14,
            // Two shadows: a wide halo in the tone's colour for the glow,
            // and a conventional drop shadow underneath so the card still
            // reads as lifted off the page in light mode, where a coloured
            // halo alone is nearly invisible against a white background.
            boxShadow: `0 0 26px 3px ${glow}, 0 10px 30px rgba(0,0,0,0.35)`,
            padding: "16px 26px",
            maxWidth: 620,
            color: K.text,
            fontSize: 17,
            fontWeight: 800,
            letterSpacing: 0.2,
            textAlign: "center",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <span aria-hidden="true" style={{
              width: 10, height: 10, borderRadius: 5, background: tone,
              boxShadow: `0 0 10px 2px ${tone}`, flexShrink: 0,
            }} />
            {t.message}
          </div>
        );
      })}
    </div>
  );
}
