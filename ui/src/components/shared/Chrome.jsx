import { useEffect, useState } from "react";
import { useTheme } from "../../lib/themes.js";

function fmtTime() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}
function fmtDate() {
  return new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
}

export function Clock() {
  const { T } = useTheme();
  const [time, setTime] = useState(fmtTime());
  const [date, setDate] = useState(fmtDate());
  useEffect(() => {
    const t = setInterval(() => { setTime(fmtTime()); setDate(fmtDate()); }, 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontFamily: T.fontMono, fontSize: "clamp(10px,1.6vmin,22px)", color: T.muted, letterSpacing: "0.1em" }}>{time}</div>
      <div style={{ fontFamily: T.fontMono, fontSize: "clamp(8px,0.9vmin,13px)", color: T.dim, letterSpacing: "0.08em", marginTop: 2 }}>{date}</div>
    </div>
  );
}

export function LivePill() {
  const { T } = useTheme();
  const [bright, setBright] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setBright((b) => !b), 900);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: "0.6vmin",
      fontFamily: T.fontMono, fontSize: "clamp(8px,1.1vmin,14px)",
      color: T.red, background: "rgba(224,64,48,0.12)",
      border: "1px solid rgba(224,64,48,0.28)", borderRadius: 20,
      padding: "0.35vmin 1vmin", letterSpacing: "0.06em",
      boxShadow: "0 0 10px rgba(224,64,48,0.12)",
    }}>
      <div style={{
        width: "0.7vmin", height: "0.7vmin", minWidth: 6, minHeight: 6, borderRadius: "50%",
        background: T.red, opacity: bright ? 1 : 0.2, transition: "opacity 0.4s",
        boxShadow: bright ? `0 0 6px ${T.red}` : "none",
      }} />
      LIVE
    </div>
  );
}

