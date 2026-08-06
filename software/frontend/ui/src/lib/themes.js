import { createContext, createElement, useContext, useMemo } from "react";

/* ═══════════════════════════════════
   THEME SYSTEM

   A theme is FOUR independent, separately-swappable things, not just a
   color palette:
     1. tokens      — colors + fonts (the `T` object components read)
     2. elevation   — HOW a surface reads as raised/inset/flat. Midnight
                       Arcade uses dual-tone neumorphic shadows; that's a
                       CHOICE this one theme makes, not a property of
                       "theme" in general. A different theme might use flat
                       borders, drop shadows, glass blur — anything.
     3. layout       — structural layout policy, e.g. how wide the
                       scorecard column runs. Midnight Arcade goes edge to
                       edge; a broadcast-style theme might run a narrower
                       centered column instead. This is NOT a color
                       decision and doesn't belong in `tokens`.
     4. assets       — media/branding that belongs to the theme's visual
                       identity, not to any one venue's game content:
                       celebration clips (event type -> webm URL) and the
                       webfont `@import` string. A theme with different
                       fonts than the built-ins, or its own strike/spare
                       celebration clips, ships them here instead of a
                       component reaching for a separate prop or a
                       hardcoded global import. Per-venue CONTENT (ad
                       creative, ticker promo copy) still lives in
                       useTakeoverFeed/DisplayLanePage — that's programming,
                       not identity, and isn't part of a theme.

   Components never hardcode any of these four — they call useTheme() and
   get { T, elevation, layout, assets } for whatever theme is currently
   active, via <ThemeProvider theme={...}> (wired automatically inside
   DisplayLane). Swapping `theme` re-skins, re-lays-out, and re-brands the
   whole screen.
   ═══════════════════════════════════ */

export const FONT_DISPLAY = "'Barlow Condensed', 'Orbitron', sans-serif";
export const FONT_MONO = "'JetBrains Mono', monospace";
export const FONT_UI = "'Rajdhani', sans-serif";

/* Every distinct content block on the overhead display (ticker, each
   bowler's score, whatever's in the slot below the scores) must be at
   least 10% of screen height — a hard floor, owned here so any component
   that needs to enforce it reads the same number rather than each
   guessing at their own wrapper. This is a display-density rule, not a
   per-theme layout choice, so it's not part of `layout` below. */
export const MIN_COMPONENT_VH = 10;

/* ── design tokens: colors + fonts only. No shadows, no widths. ── */
const TOKENS = {
  "midnight-arcade": {
    bg: "#0c0b14", surface: "#100e18", raised: "#181520", inset: "#0a0910",
    border: "#2a2438", border2: "#3a3050",
    shadowD: "rgba(4,3,10,0.75)", shadowL: "rgba(255,240,210,0.045)",
    red: "#e04030", redDim: "#7a1c10",
    yellow: "#e0c030", yellowDim: "#6a5610",
    green: "#38c878", greenDim: "#0e4022",
    blue: "#4090d8",
    text: "#c0c8d8", muted: "#504860", dim: "#28222e",
    fontDisplay: FONT_DISPLAY, fontMono: FONT_MONO, fontUi: FONT_UI,
  },
  "daylight": {
    bg: "#eef0f4", surface: "#ffffff", raised: "#f6f7fa", inset: "#e2e5ec",
    border: "#d4d8e2", border2: "#c0c6d4",
    shadowD: "rgba(30,34,50,0.16)", shadowL: "rgba(255,255,255,0.9)",
    red: "#d3392a", redDim: "#f6d9d5",
    yellow: "#b8860a", yellowDim: "#f3e4bd",
    green: "#1f9d5c", greenDim: "#d6f0e2",
    blue: "#2f72c4",
    text: "#20232c", muted: "#767c8c", dim: "#c4c8d2",
    fontDisplay: FONT_DISPLAY, fontMono: FONT_MONO, fontUi: FONT_UI,
  },
  /* Demonstrates the abstraction actually working: flat elevation (no
     neumorphic shadows) AND a narrower centered scorecard column, in
     contrast to midnight-arcade's dual-tone shadows + full-bleed layout. */
  "broadcast-flat": {
    bg: "#0a0e14", surface: "#12161f", raised: "#171c27", inset: "#0d1017",
    border: "#232a38", border2: "#33404f",
    shadowD: "rgba(0,0,0,0.4)", shadowL: "rgba(255,255,255,0.02)",
    red: "#e8433a", redDim: "#5c1c17",
    yellow: "#e0b030", yellowDim: "#5a4818",
    green: "#33b56a", greenDim: "#123f27",
    blue: "#3d8fd6",
    text: "#dbe1ea", muted: "#5c6678", dim: "#2a3040",
    fontDisplay: FONT_DISPLAY, fontMono: FONT_MONO, fontUi: FONT_UI,
  },
};

/* ── elevation strategies: how a "card/raised/inset/panel" surface
   actually renders, as a function of the token set. Each returns a
   style object per variant meant to be spread directly into a
   component's style — it owns background/border/boxShadow together so a
   strategy can commit fully to its own visual language (e.g. flat: a
   border with no shadow at all; neumorphic: a shadow with no visible
   border) rather than components mixing their own background/border
   with a shadow that assumes a specific look. ── */
function neumorphicElevation(T) {
  const nmRaised = (spread = 8) =>
    `${spread}px ${spread}px ${spread * 2.5}px ${T.shadowD}, -${Math.round(spread * 0.55)}px -${Math.round(spread * 0.55)}px ${spread * 1.6}px ${T.shadowL}, inset 0 1px 0 ${T.shadowL}`;
  return {
    card: { background: T.raised, border: `1px solid ${T.border}`, boxShadow: `5px 5px 14px ${T.shadowD}, -3px -3px 9px ${T.shadowL}, inset 0 1px 0 ${T.shadowL}` },
    raised: { background: T.raised, border: "none", boxShadow: nmRaised(8) },
    inset: { background: T.inset, border: "none", boxShadow: `inset 5px 5px 12px ${T.shadowD}, inset -3px -3px 8px ${T.shadowL}` },
    panel: { background: T.raised, border: `1px solid ${T.border}`, boxShadow: `7px 7px 18px ${T.shadowD}, -4px -4px 11px ${T.shadowL}` },
  };
}

function flatElevation(T) {
  return {
    card: { background: T.raised, border: `1px solid ${T.border2}`, boxShadow: "none" },
    raised: { background: T.raised, border: `1px solid ${T.border2}`, boxShadow: `0 2px 6px ${T.shadowD}` },
    inset: { background: T.inset, border: `1px solid ${T.border}`, boxShadow: "none" },
    panel: { background: T.raised, border: `1px solid ${T.border2}`, boxShadow: `0 1px 4px ${T.shadowD}` },
  };
}

const ELEVATION_STRATEGIES = {
  neumorphic: neumorphicElevation,
  flat: flatElevation,
};

/* ── layout policy: structural choices, not colors. `scorecardWidth` /
   `scorecardAlign` control how wide the bowler-scorecard column runs and
   how it's positioned within the display — see DisplayLane.jsx, which
   reads these instead of hardcoding full-width. ── */
const LAYOUTS = {
  "full-bleed": { scorecardWidth: "100%", scorecardAlign: "stretch" },
  "compact-centered": { scorecardWidth: "66%", scorecardAlign: "center" },
};

/* Shared by all three built-in presets today — Orbitron/Barlow Condensed,
   JetBrains Mono, Rajdhani. A theme with its own font choices supplies its
   own `fontImport` string instead (see `assets` below); nothing requires
   every theme to share this one. */
export const GOOGLE_FONTS_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Barlow+Condensed:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&family=Rajdhani:wght@400;500;600&display=swap');";

/* ── asset bundles: media + branding that belongs to a theme's visual
   identity rather than to a venue's game content. `celebrationAssets` is
   an event-type -> webm URL map (see CelebrationLayer); `fontImport` is
   the CSS `@import` string DisplayLane injects. No real celebration clips
   exist yet, so every built-in preset ships an empty map (CelebrationLayer
   already no-ops on a missing key) — this is where a theme would attach
   its own clips once media exists, without touching any component. ── */
const ASSETS = {
  "midnight-arcade": { celebrationAssets: {}, fontImport: GOOGLE_FONTS_IMPORT },
  "daylight": { celebrationAssets: {}, fontImport: GOOGLE_FONTS_IMPORT },
  "broadcast-flat": { celebrationAssets: {}, fontImport: GOOGLE_FONTS_IMPORT },
};

/* ── theme presets: bind a token set to an elevation strategy, a layout
   policy, and an asset bundle. This is the unit named by the `theme`
   prop. ── */
export const PRESETS = {
  "midnight-arcade": { tokens: TOKENS["midnight-arcade"], elevationStrategy: "neumorphic", layout: LAYOUTS["full-bleed"], assets: ASSETS["midnight-arcade"] },
  "daylight": { tokens: TOKENS["daylight"], elevationStrategy: "neumorphic", layout: LAYOUTS["full-bleed"], assets: ASSETS["daylight"] },
  "broadcast-flat": { tokens: TOKENS["broadcast-flat"], elevationStrategy: "flat", layout: LAYOUTS["compact-centered"], assets: ASSETS["broadcast-flat"] },
};

export const DEFAULT_PRESET = "midnight-arcade";

/* Resolve the `theme` prop accepted by <DisplayLane>. Three forms:
     - a preset name string: "midnight-arcade" | "daylight" | "broadcast-flat"
     - { preset?, overrides?, elevationStrategy?, layout?, assets? } — layer
       any of these on top of a named preset (preset defaults to
       DEFAULT_PRESET). `assets` is shallow-merged the same way `layout`
       is, so a custom theme can supply just `{ fontImport }` and inherit
       the base preset's (empty) `celebrationAssets`, or vice versa.
     - a flat token object (back-compat: `{ red: "#f00" }`) — treated as
       `overrides` merged onto the default preset's tokens, keeping
       elevation/layout/assets unchanged

   This is also the "create a theme" path: a venue-specific theme is just a
   descriptor object built by hand (or, eventually, by a picker UI) — no
   entry in PRESETS is required unless the look should be a reusable named
   built-in. */
export function resolveTheme(theme) {
  const isThemeDescriptor = theme != null && typeof theme === "object" &&
    ("preset" in theme || "overrides" in theme || "elevationStrategy" in theme || "layout" in theme || "assets" in theme);

  if (theme == null) return PRESETS[DEFAULT_PRESET];
  if (typeof theme === "string") return PRESETS[theme] || PRESETS[DEFAULT_PRESET];

  const base = isThemeDescriptor
    ? PRESETS[theme.preset] || PRESETS[DEFAULT_PRESET]
    : PRESETS[DEFAULT_PRESET];
  const tokenOverrides = isThemeDescriptor ? theme.overrides : theme;

  return {
    tokens: { ...base.tokens, ...tokenOverrides },
    elevationStrategy: (isThemeDescriptor && theme.elevationStrategy) || base.elevationStrategy,
    layout: { ...base.layout, ...(isThemeDescriptor ? theme.layout : null) },
    assets: { ...base.assets, ...(isThemeDescriptor ? theme.assets : null) },
  };
}

function buildElevation(elevationStrategy, T) {
  const strategyFn = typeof elevationStrategy === "function"
    ? elevationStrategy
    : ELEVATION_STRATEGIES[elevationStrategy] || ELEVATION_STRATEGIES.neumorphic;
  const variants = strategyFn(T);
  return (variant) => variants[variant] || variants.card;
}

const DEFAULT_RESOLVED = PRESETS[DEFAULT_PRESET];
const ThemeContext = createContext({
  T: DEFAULT_RESOLVED.tokens,
  elevation: buildElevation(DEFAULT_RESOLVED.elevationStrategy, DEFAULT_RESOLVED.tokens),
  layout: DEFAULT_RESOLVED.layout,
  assets: DEFAULT_RESOLVED.assets,
});

export function ThemeProvider({ theme, children }) {
  const value = useMemo(() => {
    const resolved = resolveTheme(theme);
    return {
      T: resolved.tokens,
      elevation: buildElevation(resolved.elevationStrategy, resolved.tokens),
      layout: resolved.layout,
      assets: resolved.assets,
    };
  }, [theme]);
  return createElement(ThemeContext.Provider, { value }, children);
}

/** Standard hook every display sub-component uses instead of importing
 *  static tokens — returns:
 *    T         — flat color/font tokens
 *    elevation — elevation(variant) => style object; variant is one of
 *                "card" | "raised" | "inset" | "panel". Spread the
 *                result directly into a component's style (it owns
 *                background/border/boxShadow as a unit).
 *    layout    — structural policy for the current theme, currently
 *                { scorecardWidth, scorecardAlign } — see DisplayLane.jsx
 *    assets    — theme-owned media/branding: { celebrationAssets, fontImport }
 */
export function useTheme() {
  return useContext(ThemeContext);
}
