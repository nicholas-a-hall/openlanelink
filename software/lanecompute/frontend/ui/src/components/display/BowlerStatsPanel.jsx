import { countSpares, countStrikes, pinfall } from "../../lib/scoring.js";
import { useTheme } from "../../lib/themes.js";

function Tile({ label, value, color }) {
  const { T, elevation } = useTheme();
  return (
    <div style={{
      ...elevation("card"),
      flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: "0.3vh",
      borderRadius: "clamp(6px,0.8vmin,12px)",
    }}>
      {/* 3vh/36px measured ~12% taller than its box in practice -- same
          font-metrics-exceed-lineHeight:1 gap as BowlerSheet's total score
          (see DisplayLane.jsx) -- reduced until a live overflow scan came
          back clean rather than estimated. */}
      <div style={{
        fontFamily: T.fontDisplay, fontSize: "clamp(14px,2.6vh,32px)", fontWeight: 700, color: color || T.text,
        lineHeight: 1, textShadow: `0 0 14px ${(color || T.text)}44`, overflow: "hidden",
      }}>{value}</div>
      <div style={{ fontFamily: T.fontMono, fontSize: "clamp(6px,0.9vh,11px)", color: T.muted, letterSpacing: "0.12em" }}>{label}</div>
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
  const { T, elevation } = useTheme();

  if (!bowler) {
    return (
      <div style={{
        ...elevation("panel"),
        height: "100%", display: "flex", alignItems: "center", justifyContent: "center",
        borderRadius: "clamp(6px,0.7vmin,12px)", color: T.muted, fontFamily: T.fontMono, fontSize: "clamp(8px,1vh,12px)",
      }}>No active bowler</div>
    );
  }

  const strikes = countStrikes(bowler.frames);
  const spares = countSpares(bowler.frames);
  const pins = pinfall(bowler.frames);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: "0.4vh" }}>
      <div style={{
        fontFamily: T.fontMono, fontSize: "clamp(6px,0.78vh,10px)", color: T.muted,
        letterSpacing: "0.12em", flexShrink: 0,
      }}>{bowler.name.toUpperCase()} · THIS GAME</div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: "0.6vw" }}>
        <Tile label="BALL SPEED" value={ballSpeed ? `${ballSpeed} mph` : "—"} color={T.blue} />
        <Tile label="PINFALL" value={pins} color={T.red} />
        <Tile label="STRIKES" value={strikes} color={T.yellow} />
        <Tile label="SPARES" value={spares} color={T.green} />
      </div>
    </div>
  );
}
