import { useTheme } from "../../lib/themes.js";

/**
 * MiniAd — small persistent ad slot within the normal layout (distinct
 * from <TakeoverLayer>'s full-screen ads). Renders nothing if no ad is
 * supplied, so it's always safe to mount.
 *
 * Lives at the left of the bottom ticker strip (DisplayLane's `tickerLead`),
 * which gives it a fixed box. It FILLS that box rather than sizing itself:
 * the image is cropped to fit, and the label overlays a corner instead of
 * stacking underneath, because a stacked label plus an aspect-correct image
 * would need more height than the strip has and would take it from the
 * scorecards.
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
      overflow: "hidden", position: "relative",
      width: "100%", height: "100%",
    }}>
      <img
        src={ad.imageUrl}
        alt={ad.label || "sponsor"}
        style={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }}
      />
      {ad.label && (
        <div style={{
          position: "absolute", left: 0, bottom: 0,
          fontFamily: T.fontMono, fontSize: "clamp(5px,0.65vmin,9px)", color: T.text,
          letterSpacing: "0.1em", padding: "0.2vh 0.5vw",
          background: "rgba(0,0,0,0.55)", borderTopRightRadius: 5,
        }}>{ad.label}</div>
      )}
    </div>
  );
}
