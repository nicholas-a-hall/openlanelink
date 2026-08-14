import { useEffect, useState } from "react";
import { K } from "./theme.jsx";
import { LABEL, MONO, panel } from "./styles.js";
import { formatClock, formatDuration } from "./styles.js";

/* Wall clock + session countdown.

   The countdown is derived from the session snapshot, never accumulated
   locally, so a tab that was asleep or a client whose clock drifted still
   shows what the compute node actually thinks:

   - Running: count down to `endsAtMs`. That instant moves later every time
     the session is held, which is exactly why we count to it rather than
     subtracting elapsed time from a duration.
   - Held (a problem is open): `remainingMs` is frozen by the backend, so we
     render it verbatim and stop doing arithmetic entirely. This is the
     visible half of "the time stops while waiting for staff" -- the number
     sits still and says why.

   Per-game sessions have no clock at all; they show games remaining
   instead, and the wall clock stays either way.

   Sizing is clamp()ed against the viewport rather than fixed: this is the
   one thing on the terminal that gets read from several feet away, so it
   should grow into a large landscape console instead of sitting there at
   phone size. */

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/* Type size comes from .k-clock-value, which scales against the clock
   panel's own width rather than the viewport -- see theme.jsx. These are
   the widest strings on the screen and they sit in a rail that can be
   320px, so anything viewport-derived overflows as soon as the layout
   goes two-column. */
function Readout({ label, value, color, dim = false }) {
  return (
    <div className="k-clock-readout">
      <div style={LABEL}>{label}</div>
      <div className="k-clock-value" style={{
        fontFamily: MONO,
        fontWeight: 800,
        color: color ?? K.text,
        opacity: dim ? 0.72 : 1,
      }}>{value}</div>
    </div>
  );
}

export default function SessionClock({ session, active, held }) {
  const now = useNow();

  let label = "Time left";
  let value = "—";
  let color = K.text;

  if (!active || !session) {
    label = "Lane";
    value = "Open";
    color = K.textDim;
  } else if (session.mode === "games") {
    label = "Games left";
    value = String(session.gamesRemaining ?? 0);
    color = session.gamesRemaining > 0 ? K.text : K.danger;
  } else if (held) {
    value = formatDuration(session.remainingMs ?? 0);
    color = K.yellow;
  } else {
    const remaining = Math.max(0, (session.endsAtMs ?? now) - now);
    value = formatDuration(remaining);
    color = remaining === 0 ? K.danger : remaining <= 5 * 60_000 ? K.yellow : K.green;
  }

  return (
    <div className="k-clock" style={{ ...panel(16), padding: "16px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="k-clock-row">
        <Readout label="Now" value={formatClock(new Date(now))} />
        <div className="k-clock-divider" />
        <Readout label={label} value={value} color={color} dim={held} />
      </div>

      {held && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
          padding: "10px 12px", borderRadius: 10,
          background: K.holdBg, border: `1px solid ${K.yellow}`, color: K.yellow,
          fontSize: 14, fontWeight: 700, textAlign: "center",
        }}>
          <span aria-hidden="true" style={{
            width: 9, height: 9, borderRadius: 5, background: K.yellow, flexShrink: 0,
          }} />
          Help is on the way — your clock is stopped
        </div>
      )}
    </div>
  );
}
