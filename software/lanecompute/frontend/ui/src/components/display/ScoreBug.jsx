import { useTheme } from "../../lib/themes.js";
import { displayTotal } from "../../lib/scoring.js";

/**
 * ScoreBug — compact all-bowlers score strip.
 * Renders standalone in the normal score view's header, and gets reused
 * as the persistent overlay during ad/video/message takeovers (per the
 * product decision: scores are never fully hidden behind sponsor content).
 */
export default function ScoreBug({ laneId, bowlers, activeBowlerId, floating = false }) {
  const { T, elevation } = useTheme();
  if (!bowlers || bowlers.length === 0) return null;
  const card = elevation("card");

  return (
    <div style={{
      ...card,
      display: "flex", alignItems: "center", gap: "clamp(6px,1vmin,14px)",
      // "floating" (used over takeover content) is its own translucent
      // glass treatment, independent of the base elevation strategy.
      background: floating ? "rgba(8,7,14,0.72)" : card.background,
      backdropFilter: floating ? "blur(6px)" : "none",
      borderRadius: "clamp(6px,0.8vmin,12px)",
      padding: "clamp(5px,0.7vmin,10px) clamp(8px,1.1vmin,16px)",
    }}>
      <span style={{
        fontFamily: T.fontMono, fontSize: "clamp(7px,0.9vmin,12px)", color: T.muted,
        letterSpacing: "0.1em", flexShrink: 0, borderRight: `1px solid ${T.border}`, paddingRight: "0.8vmin",
      }}>LANE {laneId}</span>
      {bowlers.map((b) => (
        <span key={b.id} style={{
          display: "flex", alignItems: "baseline", gap: "0.5vmin",
          fontFamily: T.fontDisplay, fontSize: "clamp(9px,1.3vmin,17px)",
          color: b.id === activeBowlerId ? T.yellow : T.text, fontWeight: 600,
          textShadow: b.id === activeBowlerId ? `0 0 8px ${T.yellow}55` : "none",
        }}>
          {b.name}
          {/* The number shown is the one the game is decided on: handicapped
              where a handicap exists, scratch otherwise. The "+N" is what
              stops that being ambiguous -- without it two bowlers on the
              same displayed score look tied when they aren't. See
              displayTotal() in lib/scoring.js. */}
          <span style={{ fontFamily: T.fontMono, fontSize: "clamp(10px,1.6vmin,22px)", fontWeight: 700 }}>
            {displayTotal(b)}
          </span>
          {b.handicap > 0 && (
            /* Labelled for the same reason as the bowler sheet's: a bare
               "+40" beside a score doesn't say what the 40 is. */
            <span style={{
              fontFamily: T.fontMono, fontSize: "clamp(6px,0.85vmin,11px)", fontWeight: 600,
            }}>
              <span style={{ color: T.muted, letterSpacing: "0.06em" }}>HDCP </span>
              <span style={{ color: T.green }}>+{b.handicap}</span>
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
