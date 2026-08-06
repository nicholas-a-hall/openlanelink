import { useTheme } from "../../lib/themes.js";

/**
 * MiniAd — small persistent ad slot within the normal layout (distinct
 * from <TakeoverLayer>'s full-screen ads). Renders nothing if no ad is
 * supplied, so it's always safe to mount.
 *
 * Props:
 *   ad: { imageUrl, label? } | null
 */
export default function MiniAd({ ad }) {
  const { T, elevation } = useTheme();
  if (!ad) return null;
  return (
    <div style={{
      ...elevation("card"),
      borderRadius: "clamp(6px,0.8vmin,12px)",
      overflow: "hidden", display: "flex", flexDirection: "column",
    }}>
      <img src={ad.imageUrl} alt={ad.label || "sponsor"} style={{ width: "100%", display: "block", objectFit: "cover" }} />
      {ad.label && (
        <div style={{ fontFamily: T.fontMono, fontSize: "clamp(6px,0.7vmin,10px)", color: T.dim, letterSpacing: "0.1em", padding: "0.4vh 0.6vw" }}>
          {ad.label}
        </div>
      )}
    </div>
  );
}
