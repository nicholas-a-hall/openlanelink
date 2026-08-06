import { createContext, useContext, useState, useEffect, useCallback } from 'react';

// IMPORTANT: All color values must be 6-digit hex strings (e.g. '#00b4ff').
// Components append hex alpha suffixes like `${color}55` for transparency.
// Non-hex formats (rgb, hsl, named colors) will break these patterns.
//
// NEUMORPHIC MODEL: `surface` is the single base color everything sits on. Raised
// and inset elements share that background and read purely via dual shadows —
// `shadowLight` (top-left highlight) and `shadowDark` (bottom-right shadow). Use
// the raised()/inset() helpers below rather than hand-writing box-shadows.
const dark = {
  // Dark charcoal surface — card === bg so neumorphic shadows read correctly.
  // Shadow deltas are intentionally small for a soft, understated extrusion.
  bg:'#191b21', card:'#191b21', surface:'#191b21', surfaceRaised:'#1d2027',
  shadowLight:'#20232b', shadowDark:'#121317',
  green:'#39ff14', pink:'#ff2d7e', blue:'#1fbaff',
  red:'#ff3b3b', maint:'#8595bd', orange:'#ff941f', purple:'#b96bf5',
  yellow:'#ffc61f', amber:'#ff9e2e', dim:'#363c54', text:'#a3adcf',
  cardShadow:'4px 4px 10px #121317, -4px -4px 10px #20232b',
  cardShadowHover:'5px 5px 14px #0f1014, -5px -5px 14px #23262f',
  cardGradient:'none',
  headerGradient:'none',
  // Named colors for hardcoded values
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
};

const light = {
  // Classic soft-grey neumorphic surface — card === bg
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
};

// CSS custom properties for <style> tags and keyframes
function setCSSVars(palette, isDark) {
  const r = document.documentElement;
  for (const [k, v] of Object.entries(palette)) {
    r.style.setProperty(`--ll-${k}`, v);
  }
  // RGB variants for rgba() usage in CSS
  const hexToRgb = h => { const m = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h); return m ? `${parseInt(m[1],16)},${parseInt(m[2],16)},${parseInt(m[3],16)}` : '0,0,0'; };
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
  // CRT effect opacities — disabled (neumorphic surfaces stay flat)
  r.style.setProperty('--ll-scanline-opacity', '0');
  r.style.setProperty('--ll-vignette-opacity', '0');
}

// ── Neumorphic style helpers ──────────────────────────────
// Return inline-style fragments for soft "extruded" (raised) and "carved" (inset)
// surfaces. Both share the palette `surface` background; depth comes only from the
// paired light/dark shadows. Spread the result into an element's style object.
//
//   <div style={{ ...raised(C), padding: 16 }} />
//   <div style={{ ...inset(C, { radius: 8 }), padding: 12 }} />
//
// `accent` adds a faint colored outer glow for status emphasis without a hard border.
export function raised(C, { radius = 8, distance = 4, blur, accent } = {}) {
  const b = blur ?? distance * 2.4;
  const glow = accent ? `, 0 0 14px ${accent}3a` : '';
  return {
    background: C.surface,
    border: 'none',
    borderRadius: radius,
    boxShadow: `${distance}px ${distance}px ${b}px ${C.shadowDark}, -${distance}px -${distance}px ${b}px ${C.shadowLight}${glow}`,
  };
}

export function inset(C, { radius = 7, distance = 3, blur, accent } = {}) {
  const b = blur ?? distance * 2.2;
  const glow = accent ? `, inset 0 0 12px ${accent}2e` : '';
  return {
    background: C.surface,
    border: 'none',
    borderRadius: radius,
    boxShadow: `inset ${distance}px ${distance}px ${b}px ${C.shadowDark}, inset -${distance}px -${distance}px ${b}px ${C.shadowLight}${glow}`,
  };
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

  // Sync across tabs on the same origin (e.g. manager toggle affects display view)
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'll-theme') setIsDark(e.newValue !== 'light');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

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
