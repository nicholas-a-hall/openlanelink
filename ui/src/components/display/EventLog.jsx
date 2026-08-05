import { useTheme } from "../../lib/themes.js";

/**
 * EventLog — scrolling list of recent lane events. Not built into
 * <DisplayLane> — it's meant to be passed in as a child for the slot below
 * the bowler scores, alongside whatever else a given screen wants there.
 *
 * Props:
 *   events: { ts, type, msg }[]
 */
export default function EventLog({ events }) {
  const { T, elevation } = useTheme();
  return (
    <div style={{
      ...elevation("card"),
      height: "100%", minWidth: 0,
      borderRadius: "clamp(6px,0.7vmin,12px)", padding: "clamp(6px,0.7vmin,10px) clamp(8px,1vmin,14px)",
      overflow: "hidden",
    }}>
      <div style={{ fontFamily: T.fontMono, fontSize: "clamp(6px,0.78vmin,10px)", color: T.muted, letterSpacing: "0.12em", marginBottom: "0.3vh" }}>
        EVENT STREAM
      </div>
      {events.map((e, i) => (
        <div key={i} style={{
          display: "flex", gap: "0.8vmin", fontFamily: T.fontMono, fontSize: "clamp(7px,0.83vmin,11px)",
          color: e.type === "strike" ? "#8050c8" : e.type === "alert" ? "#a04020" : e.type === "sys" ? T.muted : "#383660",
          padding: "0.1vh 0",
        }}>
          <span style={{ color: T.dim, minWidth: "5.5vmin" }}>{e.ts}</span>
          <span>{e.msg}</span>
        </div>
      ))}
    </div>
  );
}
