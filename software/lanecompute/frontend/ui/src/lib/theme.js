/* ═══════════════════════════════════
   DESIGN TOKENS — Midnight Arcade
   Shared by the display (16:9 overhead monitor) and control
   (9:16 tablet) screens so both read as one system.
   Ported from scoredash.jsx / openlanescheduler-scoring.jsx.
   ═══════════════════════════════════ */
export const T = {
  bg:      "#0c0b14",
  surface: "#100e18",
  raised:  "#181520",
  inset:   "#0a0910",
  border:  "#2a2438",
  border2: "#3a3050",

  shadowD: "rgba(4,3,10,0.75)",
  shadowL: "rgba(255,240,210,0.045)",

  red:     "#e04030",
  redDim:  "#7a1c10",
  yellow:  "#e0c030",
  yellowDim:"#6a5610",
  green:   "#38c878",
  greenDim:"#0e4022",
  blue:    "#4090d8",

  text:    "#c0c8d8",
  muted:   "#504860",
  dim:     "#28222e",
};

export const FONT_DISPLAY = "'Barlow Condensed', 'Orbitron', sans-serif";
export const FONT_MONO = "'JetBrains Mono', monospace";
export const FONT_UI = "'Rajdhani', sans-serif";

export const nmRaised = (spread = 8) =>
  `${spread}px ${spread}px ${spread * 2.5}px ${T.shadowD}, -${Math.round(spread * 0.55)}px -${Math.round(spread * 0.55)}px ${spread * 1.6}px ${T.shadowL}, inset 0 1px 0 rgba(255,240,210,0.04)`;

export const nmInset = () =>
  `inset 5px 5px 12px ${T.shadowD}, inset -3px -3px 8px ${T.shadowL}`;

export const nmCard = () =>
  `5px 5px 14px ${T.shadowD}, -3px -3px 9px ${T.shadowL}, inset 0 1px 0 rgba(255,240,210,0.03)`;

export const nmPanel = () =>
  `7px 7px 18px ${T.shadowD}, -4px -4px 11px ${T.shadowL}`;

export const GOOGLE_FONTS_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700&family=Barlow+Condensed:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&family=Rajdhani:wght@400;500;600&display=swap');";
