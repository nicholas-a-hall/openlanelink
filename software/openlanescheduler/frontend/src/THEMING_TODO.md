# Theming TODO — User-Defined Theme Support

## Status: Planned

The dark/light theme infrastructure is functional. This document tracks remaining work to enable fully user-customizable themes.

## 1. Replace Hardcoded Colors (~30 min)

### App.jsx — Week view heat intensity (~line 696)

**Current:** `rgba(0, 180, 255, ${0.15 + intensity * 0.5})` — hardcoded cyan, not theme-aware.

**Fix:** Use `--ll-blue-rgb` CSS variable or compute from `C.blue`:
```js
return `rgba(var(--ll-blue-rgb), ${0.15 + intensity * 0.5})`;
```

### App.jsx — Modal overlay (~line 970)

**Current:** `background: 'rgba(0, 0, 0, 0.7)'`

**Fix:** `background: C.overlayBg` — the palette key already exists in both dark and light themes but isn't used here.

### Kiosk — OpenLaneSchedulerKiosk.jsx CSS `<style>` tags

Hardcoded values in CSS blocks that bypass the theme:
- `color: #555` for disabled button states → use `var(--ll-dim)`
- `background: rgba(0, 0, 0, 0.9)` for overlays → use `var(--ll-overlayBg)` or add a CSS var
- `border: 2px solid rgba(255, 255, 255, 0.3)` and similar white refs → use `var(--ll-mechBtnBorder)` or equivalent CSS vars

## 2. Remove Dead Static `C` from shared.js (~5 min)

Both `frontend/src/shared.js` and `kiosk/src/shared.js` export a static `C` object hardcoded to dark theme values. No components import it — they all use `useColors()` from `theme.jsx`. Delete the `C` export from both files. Keep `F`, `LANES`, `HOURS`, hooks, and utilities.

## 3. Document Hex-Only Contract (~5 min)

The codebase uses a hex alpha suffix pattern 40+ times:
```js
border: `2px solid ${C.blue}55`
background: `${C.red}11`
```

This appends two hex digits to a hex color string for transparency. It works because all palette values are `#rrggbb` hex strings. It breaks silently with `rgb()`, `hsl()`, or named colors.

**Fix:** Add a comment at the top of the palette definitions in both `frontend/src/theme.jsx` and `kiosk/src/theme.jsx`:
```js
// IMPORTANT: All color values must be 6-digit hex strings (e.g. '#00b4ff').
// Components append hex alpha suffixes like `${color}55` for transparency.
// Non-hex formats (rgb, hsl, named colors) will break these patterns.
```

## 4. Define Palette Interface (~15 min)

Add a JSDoc or TypeScript interface documenting the required palette keys so custom themes know what to provide. Place in `theme.jsx`:

```js
/**
 * @typedef {Object} ThemePalette
 * @property {string} bg - Page background
 * @property {string} card - Card/panel background (may be rgba)
 * @property {string} blue - Primary accent
 * @property {string} green - Success / active
 * @property {string} pink - Secondary accent
 * @property {string} red - Error / danger
 * @property {string} maint - Maintenance mode
 * @property {string} orange - Warning accent
 * @property {string} purple - Group / accent
 * @property {string} yellow - Highlight / caution
 * @property {string} amber - Service call
 * @property {string} dim - Disabled / muted backgrounds
 * @property {string} text - Primary text
 * @property {string} serviceAck - Acknowledged service call accent
 * @property {string} cardShadow - Card resting shadow ('none' for no shadow)
 * @property {string} cardShadowHover - Card hover/active shadow
 * @property {string} cardGradient - Card background gradient ('none' for flat)
 * @property {string} headerGradient - Header background gradient
 * @property {string} overlayBg - Modal overlay background (rgba)
 * @property {string} mechText - Mechanics primary text
 * @property {string} mechTextMuted - Mechanics secondary text
 * @property {string} mechTextDim - Mechanics tertiary text
 * @property {string} mechBtnBg - Mechanics button background
 * @property {string} mechBtnBgMed - Mechanics button medium background
 * @property {string} mechBtnBgActive - Mechanics button active background
 * @property {string} mechBtnBgDisabled - Mechanics button disabled background
 * @property {string} mechBtnBorder - Mechanics button border
 * @property {string} mechBtnBorderBright - Mechanics button bright border
 * @property {string} mechBtnBorderDim - Mechanics button dim border
 */
```

Kiosk palette additionally requires:
- `kioskBg`, `kioskBgMid`, `kioskCyan`, `kioskGreen`, `kioskYellow`, `kioskMagenta`, `kioskOrange`

## 5. Add Theme Persistence & Selection (~1 hr)

Currently `localStorage` stores `'dark'` or `'light'`. To support custom themes:

1. Store theme name in `localStorage` key `ll-theme` (e.g. `'dark'`, `'light'`, `'retro'`)
2. Store custom palettes in `localStorage` key `ll-custom-themes` as JSON
3. Update `ThemeProvider` to resolve theme name → palette object
4. Add UI in manager dashboard settings for theme selection
5. Sync across tabs via existing `storage` event listener

## Files to Modify

| File | Changes |
|------|---------|
| `frontend/src/theme.jsx` | Hex-only comment, palette interface, custom theme loading |
| `kiosk/src/theme.jsx` | Hex-only comment, palette interface, custom theme loading |
| `frontend/src/shared.js` | Remove dead `C` export |
| `kiosk/src/shared.js` | Remove dead `C` export |
| `frontend/src/App.jsx` | Fix hardcoded `rgba(0,180,255,...)` and `rgba(0,0,0,0.7)` |
| `kiosk/src/OpenLaneSchedulerKiosk.jsx` | Fix hardcoded `#555`, `rgba(0,0,0,0.9)`, `rgba(255,255,255,...)` in CSS |
