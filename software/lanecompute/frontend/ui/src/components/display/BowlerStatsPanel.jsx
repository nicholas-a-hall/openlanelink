import { countSpares, countStrikes, pinfall } from "../../lib/scoring.js";
import { useTheme } from "../../lib/themes.js";

/* One stat, laid out on a single line rather than value-over-label.

   This panel is background information -- ball speed, a strike count -- on
   a screen whose job is the scorecards. It used to be a row of raised
   cards with glowing numbers, which read as the most important thing up
   there. Now: no card, no glow, label and value side by side so the whole
   row fits the shorter slot (STATS_SLOT_VH in DisplayLane.jsx), and colour
   used only on the value so the stats are still distinguishable at a
   glance without shouting. */
function Tile({ label, value, color }) {
  const { T } = useTheme();
  return (
    <div style={{
      flex: 1, minWidth: 0, height: "100%",
      display: "flex", alignItems: "center", justifyContent: "center", gap: "0.6vmin",
      borderLeft: `1px solid ${T.border}`, padding: "0 0.6vw", overflow: "hidden",
    }}>
      <span style={{
        fontFamily: T.fontMono, fontSize: "clamp(6px,1.05vh,12px)", color: T.muted,
        letterSpacing: "0.1em", whiteSpace: "nowrap",
      }}>{label}</span>
      <span style={{
        fontFamily: T.fontDisplay, fontSize: "clamp(11px,1.9vh,22px)", fontWeight: 700,
        color: color || T.text, lineHeight: 1, whiteSpace: "nowrap", overflow: "hidden",
      }}>{value}</span>
    </div>
  );
}

/**
 * BowlerStatsPanel — extended stats for whoever's currently up: ball
 * speed (lane-level, tied to the most recent delivery), pinfall, strikes,
 * and spares for their game so far. Renders an empty-state placeholder
 * when there's no active bowler (lane idle / game complete).
 *
 * Props:
 *   bowler: { name, frames } | null — the active bowler
 *   ballSpeed: number | null
 */
export default function BowlerStatsPanel({ bowler, ballSpeed }) {
  const { T } = useTheme();

  if (!bowler) {
    return (
      <div style={{
        height: "100%", display: "flex", alignItems: "center",
        color: T.dim, fontFamily: T.fontMono, fontSize: "clamp(6px,1.05vh,12px)",
        letterSpacing: "0.1em",
      }}>NO ACTIVE BOWLER</div>
    );
  }

  const strikes = countStrikes(bowler.frames);
  const spares = countSpares(bowler.frames);
  const pins = pinfall(bowler.frames);

  // One row, not a heading over a grid: the whole panel is one strip now,
  // so the bowler's name sits inline with the stats it belongs to.
  return (
    <div style={{ height: "100%", display: "flex", alignItems: "center", overflow: "hidden" }}>
      <div style={{
        fontFamily: T.fontMono, fontSize: "clamp(6px,1.05vh,12px)", color: T.dim,
        letterSpacing: "0.1em", flexShrink: 0, paddingRight: "0.8vw",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "22vw",
      }}>{bowler.name.toUpperCase()} · THIS GAME</div>
      <Tile label="SPEED" value={ballSpeed ? `${ballSpeed} mph` : "—"} color={T.blue} />
      <Tile label="PINFALL" value={pins} color={T.red} />
      <Tile label="STRIKES" value={strikes} color={T.yellow} />
      <Tile label="SPARES" value={spares} color={T.green} />
    </div>
  );
}
