import { createContext, useContext, useState, useEffect, useCallback } from 'react';

// IMPORTANT: All color values must be 6-digit hex strings (e.g. '#00b4ff').
// Components append hex alpha suffixes like `${color}55` for transparency.
// NEUMORPHIC MODEL: `surface` is the single base color everything sits on; depth
// comes only from the paired `shadowLight` (top-left) / `shadowDark` (bottom-right).
const dark = {
  // Dark charcoal neumorphic surface — card === bg
  bg:'#191b21', card:'#191b21', surface:'#191b21', surfaceRaised:'#1d2027',
  shadowLight:'#20232b', shadowDark:'#121317',
  green:'#39ff14', pink:'#ff2d7e', blue:'#1fbaff',
  red:'#ff3b3b', maint:'#8595bd', orange:'#ff941f', purple:'#b96bf5',
  yellow:'#ffc61f', amber:'#ff9e2e', dim:'#363c54', text:'#a3adcf',
  cardShadow:'4px 4px 10px #121317, -4px -4px 10px #20232b',
  cardShadowHover:'5px 5px 14px #0f1014, -5px -5px 14px #23262f',
  cardGradient:'none',
  headerGradient:'none',
  serviceAck:'#e0f0ff',
  mechText:'#e5e7eb',
  mechTextMuted:'#9ca3af',
  mechTextDim:'#6b7280',
  mechBtnBg:'rgba(255,255,255,0.05)',
  mechBtnBgMed:'rgba(255,255,255,0.08)',
  mechBtnBgActive:'rgba(255,255,255,0.15)',
  mechBtnBgDisabled:'rgba(255,255,255,0.03)',
  mechBtnBorder:'rgba(255,255,255,0.2)',
  mechBtnBorderBright:'rgba(255,255,255,0.3)',
  mechBtnBorderDim:'rgba(255,255,255,0.1)',
  overlayBg:'rgba(0,0,0,0.85)',
  // Kiosk-specific — surfaces flattened to the neumorphic base; accents softened
  // from neon to muted tones that sit calmly on the dark surface.
  kioskBg:'#191b21',
  kioskBgMid:'#1d2027',
  kioskCyan:'#5bb8cf',
  kioskGreen:'#5cc98a',
  kioskYellow:'#d9b35a',
  kioskMagenta:'#bd86c4',
  kioskOrange:'#d98f5e',
};

const light = {
  bg:'#e4e9f2', card:'#e4e9f2', surface:'#e4e9f2', surfaceRaised:'#eef1f7',
  shadowLight:'#ffffff', shadowDark:'#bcc4d6',
  green:'#5cb85c', pink:'#e875a0', blue:'#6495ed',
  red:'#e55c5c', maint:'#6b7ea6', orange:'#e8925c', purple:'#9b7ed8',
  yellow:'#d4a843', amber:'#daa04d', dim:'#cbd5e1', text:'#475569',
  serviceAck:'#1e3a5f',
  mechText:'#1e293b',
  mechTextMuted:'#64748b',
  mechTextDim:'#94a3b8',
  mechBtnBg:'rgba(0,0,0,0.03)',
  mechBtnBgMed:'rgba(0,0,0,0.05)',
  mechBtnBgActive:'rgba(0,0,0,0.08)',
  mechBtnBgDisabled:'rgba(0,0,0,0.02)',
  mechBtnBorder:'rgba(0,0,0,0.12)',
  mechBtnBorderBright:'rgba(0,0,0,0.18)',
  mechBtnBorderDim:'rgba(0,0,0,0.06)',
  overlayBg:'rgba(0,0,0,0.5)',
  cardShadow:'6px 6px 14px #bcc4d6, -6px -6px 14px #ffffff',
  cardShadowHover:'8px 8px 20px #b2bacd, -8px -8px 20px #ffffff',
  cardGradient:'none',
  headerGradient:'none',
  // Kiosk-specific (light) — surfaces flattened to the neumorphic base
  kioskBg:'#e4e9f2',
  kioskBgMid:'#eef1f7',
  kioskCyan:'#0891b2',
  kioskGreen:'#5cb85c',
  kioskYellow:'#d4a843',
  kioskMagenta:'#c76cc8',
  kioskOrange:'#e8925c',
};

function hexToRgb(h) {
  const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
  return m ? `${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)}` : '0,0,0';
}

function setCSSVars(palette, isDark) {
  const r = document.documentElement;
  for (const [k, v] of Object.entries(palette)) {
    r.style.setProperty(`--ll-${k}`, v);
  }
  // RGB variants for rgba() in CSS
  r.style.setProperty('--ll-amber-rgb', hexToRgb(palette.amber));
  r.style.setProperty('--ll-bg-rgb', hexToRgb(palette.bg));
  r.style.setProperty('--ll-blue-rgb', hexToRgb(palette.blue));
  r.style.setProperty('--ll-green-rgb', hexToRgb(palette.green));
  r.style.setProperty('--ll-red-rgb', hexToRgb(palette.red));
  r.style.setProperty('--ll-yellow-rgb', hexToRgb(palette.yellow));
  r.style.setProperty('--ll-pink-rgb', hexToRgb(palette.pink));
  r.style.setProperty('--ll-purple-rgb', hexToRgb(palette.purple));
  r.style.setProperty('--ll-text-rgb', hexToRgb(palette.text));
  r.style.setProperty('--ll-serviceAck-rgb', hexToRgb(palette.serviceAck));
  // Kiosk-specific RGB
  r.style.setProperty('--ll-kioskCyan-rgb', hexToRgb(palette.kioskCyan));
  r.style.setProperty('--ll-kioskGreen-rgb', hexToRgb(palette.kioskGreen));
  r.style.setProperty('--ll-kioskYellow-rgb', hexToRgb(palette.kioskYellow));
  r.style.setProperty('--ll-kioskMagenta-rgb', hexToRgb(palette.kioskMagenta));
  r.style.setProperty('--ll-kioskOrange-rgb', hexToRgb(palette.kioskOrange));
  r.style.setProperty('--ll-kioskBg-rgb', hexToRgb(palette.kioskBg));
  r.style.setProperty('--ll-kioskBgMid-rgb', hexToRgb(palette.kioskBgMid));
  r.style.setProperty('--ll-maint-rgb', hexToRgb(palette.maint));
  r.style.setProperty('--ll-dim-rgb', hexToRgb(palette.dim));
  // Neumorphic shadow tokens for use in CSS class blocks
  r.style.setProperty('--ll-surface', palette.surface);
  r.style.setProperty('--ll-surfaceRaised', palette.surfaceRaised);
  r.style.setProperty('--ll-shadowLight', palette.shadowLight);
  r.style.setProperty('--ll-shadowDark', palette.shadowDark);
  // CRT effects — disabled (neumorphic surfaces stay flat)
  r.style.setProperty('--ll-scanline-opacity', '0');
  r.style.setProperty('--ll-vignette-opacity', '0');
}

const ThemeContext = createContext({ isDark: true, toggleTheme: () => {} });

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    try { return localStorage.getItem('ll-theme') !== 'light'; } catch { return true; }
  });

  const palette = isDark ? dark : light;

  useEffect(() => {
    setCSSVars(palette, isDark);
    try { localStorage.setItem('ll-theme', isDark ? 'dark' : 'light'); } catch {}
  }, [isDark]);

  const toggleTheme = useCallback(() => setIsDark(d => !d), []);

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme, palette }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useColors() {
  return useContext(ThemeContext).palette;
}
