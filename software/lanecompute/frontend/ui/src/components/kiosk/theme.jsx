import { createContext, useContext, useEffect, useMemo, useState } from "react";

/* ═══════════════════════════════════════════════════════════════════
   KIOSK THEME — light + dark, on CSS variables

   Why this screen has its own token set rather than lib/theme.js's:

   1. Contrast. The Midnight Arcade tokens were built for an overhead
      monitor read from thirty feet in a dark house, where dim-on-dim is
      atmospheric. On a lit lane console at arm's length the same palette
      is genuinely hard to read -- the old `muted` (#504860) against
      `surface` (#100e18) is about 2:1, well under the 4.5:1 anyone needs
      for body text. Every colour below is checked against the surface it
      actually sits on.

   2. One elevation system. The old kiosk mixed neumorphic dual-shadow
      surfaces with flat bordered ones, so two things at the same depth
      could look nothing alike. This is flat throughout: a surface is
      distinguished by fill and a 1px border, never by a shadow pair.
      Shadows are reserved for one job -- lifting a modal off the page.

   3. Light mode needs it. Neumorphism is shadow-on-a-single-base-colour,
      which barely survives being inverted; the highlight and shadow
      collapse toward the same near-white and the depth cue disappears.
      Flat surfaces invert cleanly, which is what makes a light kiosk
      possible at all.

   CSS variables rather than a JS token object: switching scheme then costs
   one attribute change on one element instead of re-rendering every styled
   component, and the media query below means a kiosk that has never been
   touched still follows the house's own light/dark setting.
   ═══════════════════════════════════════════════════════════════════ */

const STORAGE_KEY = "openlanelink.kiosk.scheme";

/* Token values live in CSS, not here, so both schemes are declared in one
   place and the cascade does the switching. `K` below is how JSX refers to
   them. */
const THEME_CSS = `
[data-kiosk] {
  /* Dark is the default: a bowling centre is usually a dark room, and an
     unconfigured kiosk should not be the brightest object on the lane. */
  --k-bg:          #0e1016;
  --k-bg-accent:   #151926;
  --k-panel:       #191d27;
  --k-raised:      #222836;
  --k-sunken:      #10131b;
  --k-line:        #303747;
  --k-line-strong: #48526690;

  --k-text:        #f3f5f9;  /* 15:1 on --k-panel */
  --k-text-dim:    #b3bccc;  /* 8.2:1 -- still real body text, not decoration */
  --k-text-faint:  #8a94a6;  /* 5.1:1 -- smallest label size we allow */

  /* Console palette: cyan / amber / crimson, the triad nearly every
     science-fiction interface uses, because each hue is unmistakable at a
     glance in a dark room and none of them is a colour skin or daylight
     produces.

     Every fill/ink pair is measured at roughly 7:1 or better -- above the
     4.5:1 minimum, because this is read at arm's length by people of every
     age, some of them wearing whatever glasses they came in with. The
     fills are bright and the ink near-black rather than the reverse: a
     dark fill with white text hits the same ratio but loses the emissive
     quality the whole palette is for. */
  --k-accent:      #ff5c7f;  /* alarms only */
  --k-accent-ink:  #1a0308;
  --k-green:       #3ad892;
  --k-green-ink:   #02150c;
  --k-yellow:      #f5b53f;  /* amber: the one call that stops the clock */
  --k-yellow-ink:  #1a1200;
  --k-blue:        #3fc9e0;

  --k-hold-bg:     #2a2210;
  --k-danger:      #ff6b57;
  --k-scrim:       rgba(6, 8, 13, 0.72);
  --k-modal-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);

  /* Toast halos. Pre-mixed rather than derived from --k-green/--k-danger at
     the call site: appending an alpha suffix to a var() ("var(--x)66")
     doesn't concatenate, it produces an invalid colour and the whole
     box-shadow declaration is silently dropped -- which is exactly how the
     glow went missing the first time. */
  --k-glow-good:   rgba(47, 209, 138, 0.5);
  --k-glow-bad:    rgba(240, 72, 107, 0.5);

  /* The committing action. A desaturated blue, not the accent: red is the
     loudest colour on the screen and it was carrying selection, confirmation
     AND danger at once, so nothing it marked meant anything in particular.
     Red is now reserved for destructive or alarming things; choosing and
     confirming are this. */
  --k-primary:     #35c6de;  /* cyan: the ordinary action */
  --k-primary-ink: #01161b;

  /* Ending something. A desaturated red -- these are the deliberate,
     reversible-by-staff stops (end the game, hand the lane back), not the
     alarms --k-danger is for, so they read as "this finishes something"
     rather than "something is wrong". */
  --k-stop:        #ff6b85;  /* crimson: end something */
  --k-stop-ink:    #1c0409;
}

[data-kiosk="light"] {
  --k-bg:          #eef1f6;
  --k-bg-accent:   #e3e8f0;
  --k-panel:       #ffffff;
  --k-raised:      #f4f6fa;
  --k-sunken:      #e8ecf3;
  --k-line:        #ccd3de;
  --k-line-strong: #9aa5b6;

  --k-text:        #11151c;  /* 16:1 on --k-panel */
  --k-text-dim:    #475263;  /* 7.9:1 */
  --k-text-faint:  #66717f;  /* 5.2:1 */

  /* Same hue families, taken down in lightness until they hold contrast
     against a white panel. Science-fiction palettes assume a dark room;
     transplanted literally they turn into pastel and stop meaning
     anything, so light mode keeps the hues and loses the glow. */
  --k-accent:      #9c1a45;
  --k-accent-ink:  #ffffff;
  --k-green:       #0b6042;
  --k-green-ink:   #ffffff;
  --k-yellow:      #7a4900;
  --k-yellow-ink:  #ffffff;
  --k-blue:        #0d6d7d;

  --k-hold-bg:     #fdf3d8;
  --k-danger:      #b3271a;
  --k-scrim:       rgba(24, 30, 40, 0.45);
  --k-modal-shadow: 0 24px 60px rgba(30, 40, 60, 0.22);

  /* Stronger than the dark scheme's: a coloured halo has far less to work
     with against a near-white page than against a near-black one. */
  --k-glow-good:   rgba(15, 122, 82, 0.42);
  --k-glow-bad:    rgba(179, 32, 79, 0.42);

  --k-primary:     #0a5a68;
  --k-primary-ink: #ffffff;

  --k-stop:        #96233a;
  --k-stop-ink:    #ffffff;
}
`;

/* The one definition of "does this screen get two columns". The CSS below
   interpolates it and useTwoColumn() matches on it, so the layout and any
   component that needs to change SHAPE (not just size) at that breakpoint
   can never disagree about where it is. */
export const TWO_COLUMN_QUERY = "(min-aspect-ratio: 1/1) and (min-width: 860px)";

/* Layout and interaction rules that are the same in both schemes. Kept as
   real CSS rather than inline styles specifically so media queries work --
   the terminal has to fit a portrait lane console AND a landscape monitor,
   and orientation is not something inline styles can answer. */
const LAYOUT_CSS = `
.k-root {
  min-height: 100vh;
  min-height: 100dvh;   /* dvh so mobile browser chrome doesn't cause a scroll */
  width: 100%;
  background: var(--k-bg);
  color: var(--k-text);
  font-family: 'Rajdhani', 'Inter', system-ui, -apple-system, sans-serif;
  padding: clamp(12px, 2.2vmin, 28px);
  padding-bottom: max(clamp(12px, 2.2vmin, 28px), env(safe-area-inset-bottom));
  -webkit-tap-highlight-color: transparent;

  /* Centre the content when it's shorter than the screen -- a landscape
     console is much taller than this UI needs, and top-aligning it leaves
     everything crowded against the ceiling with a field of empty below.
     The "safe" keyword matters: plain "center" overflows equally in BOTH
     directions once the content is taller than the viewport, which puts the
     top of a tall portrait layout above the scroll origin where it cannot be
     reached. A browser that does not support it ignores the whole value and
     falls back to flex-start, which is the correct failure. */
  display: flex;
  flex-direction: column;
  justify-content: safe center;
}

/* Portrait / narrow: one column, capped so text lines stay readable on a
   large portrait panel.

   Three blocks, ordered most-reached-for first: what's happening (clock,
   staff calls), then the game (who's up, end game, pinsetter, scores),
   then the session (time, roster, staff, ending). Landscape re-homes the
   session block rather than reordering it -- see below. */
.k-shell {
  width: 100%;
  max-width: 680px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.k-block { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.k-block--status  { order: 1; }
.k-block--game    { order: 2; }
.k-block--session { order: 3; }

/* Landscape: side-by-side, so a wide console isn't one tall ribbon of
   content with empty space either side. Gated on width too -- a short but
   narrow window should stay single-column. */
@media ${TWO_COLUMN_QUERY} {
  /* The left rail is the lane's own state -- the clock, and the controls
     that act on the SESSION rather than the game (more time, who's on the
     lane, summoning staff, finishing up). The right is the game itself.
     Named areas rather than reordering: the session block keeps its place
     in the source and simply lands under the clock here. */
  .k-shell {
    max-width: 1240px;
    display: grid;
    grid-template-columns: minmax(320px, 400px) 1fr;
    grid-template-rows: auto 1fr;
    grid-template-areas:
      "status game"
      "session game";
    /* stretch, not start: the two sides should read as one panel of
       controls, and a right column that stopped short of the left (or ran
       past it) looked like two unrelated screens beside each other. The
       rail's own height is set by its content; the game column matches it
       by growing its summary card (.k-grow below). */
    align-items: stretch;
    gap: 18px;
  }
  .k-block--status  { grid-area: status; }
  .k-block--session { grid-area: session; align-self: end; }
  .k-block--game    { grid-area: game; }

  /* The one element allowed to absorb the leftover height, so the columns
     end level without stretching every card in the stack. Only applies in
     the two-column layout -- in portrait everything is its natural size and
     the page scrolls. */
  .k-grow { flex: 1 1 auto; min-height: 0; }
  /* An idle lane has nothing to put in the second column -- there are no
     bowlers, no actions, nothing but the clock and what's being bought.
     Left as a two-column grid it rendered a narrow strip pinned to the left
     against 800px of empty background. Solo is one column, centred on both
     axes (the root's justify-content does the vertical half), at a width
     that scales with the screen rather than a fixed one -- a 560px card
     that looks right on a 1280 laptop reads as a sliver on a 1920 console.
     Capped so the type never runs to uncomfortable line lengths. */
  .k-shell--solo {
    display: flex;
    flex-direction: column;
    width: min(100%, max(560px, 42vw));
    max-width: 760px;
    margin-inline: auto;
  }
}

/* The clock sizes itself against ITS OWN width, not the viewport's.

   These are the widest strings on the screen ("12:34:56 PM" is 11
   monospace characters) and they live in a rail that can be as narrow as
   320px, so a vmin-based size that looked right full-width overflowed the
   moment the layout went two-column. Container units tie the type size to
   the box the text is actually in, which is the only thing that can't
   drift out of sync with it.

   Below ~520px the two readouts stack instead of shrinking further: each
   then gets the full width, so the numbers stay large and legible on a
   narrow rail rather than becoming a pair of tiny columns. The two size
   rules reflect exactly that -- roughly half the width each side by side,
   the whole width each when stacked. */
.k-clock { container-type: inline-size; }
.k-clock-row { display: flex; align-items: center; gap: 12px; }
.k-clock-divider { width: 1px; align-self: stretch; background: var(--k-line); flex-shrink: 0; }
.k-clock-readout {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  flex: 1; min-width: 0;
}
.k-clock-value {
  font-size: clamp(20px, 7cqi, 42px);
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
}
@container (max-width: 520px) {
  .k-clock-row { flex-direction: column; gap: 10px; }
  .k-clock-divider { width: 100%; height: 1px; align-self: auto; }
  .k-clock-value { font-size: clamp(24px, 14cqi, 46px); }
}

/* Action grids count columns against the block they're in, not the
   viewport. The session block sits in a ~400px rail while the game block
   gets the rest of a landscape screen, so a viewport-width rule would put
   three columns in a rail that only fits two. */
.k-block { container-type: inline-size; }
.k-actions { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@container (min-width: 620px) { .k-actions { grid-template-columns: repeat(4, 1fr); } }
.k-actions-wide { grid-column: 1 / -1; }

/* Modals: centred overlays. These used to be bottom sheets, which put the
   controls under the user's hand on a phone but stranded them in a strip
   along the bottom edge of a 27" landscape console with the content they
   referred to far above. Centred works at both sizes. */
.k-scrim {
  position: fixed;
  inset: 0;
  /* Opaque enough to separate the dialog from the page on its own. There's
     deliberately no backdrop-filter: a full-viewport blur is one of the
     more expensive things you can ask of the modest GPUs driving lane
     consoles, and it buys nothing a slightly stronger scrim doesn't. */
  background: var(--k-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 3vmin, 40px);
}
.k-modal {
  width: 100%;
  background: var(--k-panel);
  border: 1px solid var(--k-line);
  border-radius: 16px;
  box-shadow: var(--k-modal-shadow);
  display: flex;
  flex-direction: column;
  max-height: 100%;
  overflow: hidden;
}
.k-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--k-line);
  flex-shrink: 0;
}
.k-modal-body { padding: 18px; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.k-modal-foot {
  display: flex;
  gap: 10px;
  padding: 14px 18px;
  border-top: 1px solid var(--k-line);
  flex-shrink: 0;
}

.k-btn {
  font-family: inherit;
  border: 1px solid var(--k-line);
  background: var(--k-raised);
  color: var(--k-text);
  border-radius: 12px;
  cursor: pointer;
  transition: filter 120ms ease, opacity 120ms ease;
}
.k-btn:hover:not(:disabled) { filter: brightness(1.12); }
.k-btn:active:not(:disabled) { transform: translateY(1px); }
.k-btn:disabled { opacity: 0.42; cursor: default; }
.k-btn:focus-visible { outline: 2px solid var(--k-blue); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  .k-root *, .k-scrim * { animation: none !important; transition: none !important; }
}
`;

/* Almost everything responsive here is plain CSS -- a kiosk can be rotated
   after boot and the cascade handles that on its own. This exists for the
   cases where the difference isn't styling but structure: the roster
   summary is a one-line button in portrait and a full standings panel in
   landscape, which is different markup, not a different rule. matchMedia
   still fires on rotation, so it stays rotation-safe. */
export function useTwoColumn() {
  const [match, setMatch] = useState(
    () => (typeof window !== "undefined" && window.matchMedia?.(TWO_COLUMN_QUERY).matches) || false
  );
  useEffect(() => {
    const mq = window.matchMedia(TWO_COLUMN_QUERY);
    const onChange = (e) => setMatch(e.matches);
    setMatch(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return match;
}

const KioskThemeContext = createContext(null);

function initialScheme() {
  if (typeof window === "undefined") return "dark";
  const saved = window.localStorage?.getItem(STORAGE_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function KioskThemeProvider({ children }) {
  const [scheme, setScheme] = useState(initialScheme);

  useEffect(() => {
    try { window.localStorage?.setItem(STORAGE_KEY, scheme); } catch { /* private mode -- not worth failing over */ }
  }, [scheme]);

  // Paint the document itself to match. Without this the overscroll area
  // (and the split-second before React paints) stays the dark default from
  // index.html while a light kiosk is on screen. Reverted on unmount so the
  // display/control routes aren't left light.
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue("--app-bg");
    root.style.setProperty("--app-bg", scheme === "light" ? "#eef1f6" : "#0e1016");
    root.style.colorScheme = scheme;
    return () => {
      root.style.setProperty("--app-bg", previous);
      root.style.colorScheme = "";
    };
  }, [scheme]);

  const value = useMemo(() => ({
    scheme,
    setScheme,
    toggle: () => setScheme((s) => (s === "light" ? "dark" : "light")),
  }), [scheme]);

  return (
    <KioskThemeContext.Provider value={value}>
      <style>{THEME_CSS}{LAYOUT_CSS}</style>
      <div data-kiosk={scheme} className="k-root">{children}</div>
    </KioskThemeContext.Provider>
  );
}

export function useKioskTheme() {
  const ctx = useContext(KioskThemeContext);
  if (!ctx) throw new Error("useKioskTheme must be used inside <KioskThemeProvider>");
  return ctx;
}

/* Token references for inline styles. These are var() strings, not colour
   literals -- the value is resolved by the cascade, so a scheme switch
   needs no re-render and no component ever holds a hex code. */
export const K = {
  bg: "var(--k-bg)",
  bgAccent: "var(--k-bg-accent)",
  panel: "var(--k-panel)",
  raised: "var(--k-raised)",
  sunken: "var(--k-sunken)",
  line: "var(--k-line)",
  lineStrong: "var(--k-line-strong)",

  text: "var(--k-text)",
  textDim: "var(--k-text-dim)",
  textFaint: "var(--k-text-faint)",

  accent: "var(--k-accent)",
  accentInk: "var(--k-accent-ink)",
  green: "var(--k-green)",
  greenInk: "var(--k-green-ink)",
  yellow: "var(--k-yellow)",
  yellowInk: "var(--k-yellow-ink)",
  blue: "var(--k-blue)",

  holdBg: "var(--k-hold-bg)",
  danger: "var(--k-danger)",
  glowGood: "var(--k-glow-good)",
  glowBad: "var(--k-glow-bad)",
  primary: "var(--k-primary)",
  primaryInk: "var(--k-primary-ink)",
  stop: "var(--k-stop)",
  stopInk: "var(--k-stop-ink)",
};
