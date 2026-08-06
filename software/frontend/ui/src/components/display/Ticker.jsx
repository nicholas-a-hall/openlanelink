import { useTheme, MIN_COMPONENT_VH } from "../../lib/themes.js";

/**
 * Ticker — scrolling banner strip. Deliberately dumb: it just renders
 * `items` in a loop. The caller (DisplayLane) is responsible for merging
 * built-in lane-stat items with externally supplied banner messages before
 * handing them down, so this component's contract stays simple.
 *
 * Owns its own MIN_COMPONENT_VH floor directly (rather than relying on a
 * caller-side wrapper) so it can't silently render short inside a tall,
 * invisible box the way it did the first time this was wired up.
 *
 * Hidden entirely unless `enabled` — this isn't the same thing as having
 * no items; a venue that doesn't want a ticker shouldn't have one occupy
 * screen space at all.
 *
 * The scroll loop duplicates `items` and animates by exactly -50% of the
 * doubled row's width, which only loops seamlessly if the two halves are
 * really identical in width. Spacing between items is baked into each
 * item as its own trailing padding (not a `gap` on the shared flex row) —
 * a flex `gap` only sits *between* children, so N items get N-1 gaps but
 * 2N duplicated items get 2N-1, one extra gap at the seam, which is
 * exactly wide enough to produce a visible jump every loop. Padding
 * avoids that because it travels with each item, so the halves are
 * provably equal regardless of how any individual item's text changes.
 *
 * Props:
 *   items: { id, text, color?: 'accent' | 'warn' | undefined }[]
 *   enabled?: boolean — default false; the ticker renders nothing (and
 *     claims no layout space) unless explicitly turned on
 */
export default function Ticker({ items, enabled = false }) {
  const { T, elevation } = useTheme();
  if (!enabled || !items || items.length === 0) return null;
  const doubled = [...items, ...items];

  const colorFor = (c) => (c === "accent" ? T.green : c === "warn" ? T.yellow : T.text);

  return (
    <div style={{
      ...elevation("inset"),
      flexShrink: 0, minHeight: `${MIN_COMPONENT_VH}vh`, overflow: "hidden",
      borderRadius: "clamp(4px,0.5vmin,8px)",
      padding: "0 1.2vw",
      display: "flex", alignItems: "center", gap: "1.2vw",
    }}>
      <span style={{
        fontFamily: T.fontMono, fontSize: "clamp(10px,1.6vh,20px)", color: T.red, fontWeight: 700,
        letterSpacing: "0.12em", flexShrink: 0, borderRight: `1px solid ${T.border}`, paddingRight: "1vw",
      }}>NOW</span>
      <div style={{ overflow: "hidden", flex: 1 }}>
        <div style={{ display: "flex", whiteSpace: "nowrap", animation: "ll-ticker 36s linear infinite" }}>
          {doubled.map((item, i) => (
            <span key={`${item.id}-${i}`} style={{
              fontFamily: T.fontMono, fontSize: "clamp(12px,2vh,24px)", color: colorFor(item.color),
              letterSpacing: "0.04em", paddingRight: "4vw",
            }}>{item.text}</span>
          ))}
        </div>
      </div>
      <style>{`@keyframes ll-ticker { 0%{transform:translateX(0)} 100%{transform:translateX(-50%)} }`}</style>
    </div>
  );
}
