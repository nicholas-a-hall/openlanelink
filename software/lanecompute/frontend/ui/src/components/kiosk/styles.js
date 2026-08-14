import { K } from "./theme.jsx";

/* Surface helpers for the bowler terminal.

   One elevation system, flat: depth reads from fill + a 1px border, never
   from a shadow pair. See theme.jsx for why the neumorphic pair this
   replaced couldn't survive either the contrast requirement or light mode.

   Three levels, and that's deliberately all:
   - panel()  a block of the page (the clock, the action grid's container)
   - card()   something inside a panel that can be pressed or selected
   - sunken() a field or readout -- something you put a value INTO
*/

export const panel = (radius = 16) => ({
  background: K.panel,
  border: `1px solid ${K.line}`,
  borderRadius: radius,
});

export const card = (radius = 12) => ({
  background: K.raised,
  border: `1px solid ${K.line}`,
  borderRadius: radius,
});

export const sunken = (radius = 12) => ({
  background: K.sunken,
  border: `1px solid ${K.line}`,
  borderRadius: radius,
});

/* A filled accent surface. `ink` is the text colour that belongs with that
   fill -- passed together so a caller can never pair a fill with unreadable
   text on it, which is exactly what went wrong before (dark text on a dark
   accent in one scheme, invisible in the other). */
export const filled = (fill, ink, radius = 12) => ({
  background: fill,
  border: `1px solid ${fill}`,
  borderRadius: radius,
  color: ink,
});

export const LABEL = {
  fontSize: 11,
  letterSpacing: 1.8,
  textTransform: "uppercase",
  color: K.textFaint,
  fontWeight: 700,
};

export const MONO = "'JetBrains Mono','SF Mono',ui-monospace,monospace";

/* mm:ss, or h:mm:ss once there's an hour or more left -- matching what the
   openlanescheduler kiosk showed, since bowlers read this at a glance from
   several feet away and a bare seconds count is useless there. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatClock(date) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
