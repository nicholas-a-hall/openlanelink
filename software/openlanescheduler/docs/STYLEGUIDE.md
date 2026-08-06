# Lunar Lanes UI/UX Style Guide
**Design System & Visual Standards**

---

## Design Philosophy

Lunar Lanes uses a **cyberpunk-inspired, neon-futuristic aesthetic** that evokes:
- Retro-futuristic bowling alleys
- High-tech arcade environments
- Clear, glowing status indicators
- Space-age typography and color schemes

**Core Principles:**
1. **Clarity** - Status always visible at a glance
2. **Immediacy** - Real-time updates, no page refreshes
3. **Responsiveness** - Adapts from mobile to desktop seamlessly
4. **Accessibility** - High contrast, readable fonts, clear affordances

---

## Color Palette

### Primary Colors

All colors are defined in `shared.js` as the `C` constant object.

```javascript
C.bg      = '#0a0e27'    // Deep space navy - main background
C.card    = 'rgba(10,14,39,0.95)'  // Card backgrounds (semi-transparent)
C.text    = '#8892b8'    // Muted blue-gray - body text
C.dim     = '#2a3060'    // Disabled/inactive elements
```

**Usage:**
- `C.bg` - Page backgrounds, dark sections
- `C.card` - Card backgrounds, overlays, panels
- `C.text` - Default text color for readability
- `C.dim` - Disabled buttons, inactive states, subtle borders

### Accent Colors (Status & Actions)

```javascript
C.blue    = '#00b4ff'    // Electric blue - primary actions, info
C.green   = '#39ff14'    // Neon green - success, active, ready
C.pink    = '#ff006e'    // Hot pink - secondary actions, highlights
C.red     = '#ff2a2a'    // Danger red - errors, warnings, delete
C.purple  = '#a855f7'    // Purple - tertiary actions, duration
C.yellow  = '#ffbe0b'    // Gold - warnings, time, current indicators
C.maint   = '#ff6600'    // Bright orange - maintenance (manager only)
```

**Status Color Mapping:**

| Status | Color | Meaning | Usage |
|--------|-------|---------|-------|
| Idle | `C.dim` (#2a3060) | Lane empty | Default state |
| Active | `C.green` (#39ff14) | Walk-in in progress | Green glow |
| Reservation | `C.blue` (#00b4ff) | Booked party | Blue glow |
| Service Call | `C.yellow` (#ffc800) | Help requested | Yellow/amber pulse |
| Staff Responding | `C.yellow` (#ffc800) | Help acknowledged | Amber fade |
| Maintenance | `C.maint` (#ff6600) or `#6b7ea6` | Lane offline | Orange (manager) / muted gray-blue (kiosk) |
| Error | `C.red` (#ff2a2a) | Problem/warning | Red glow |

### Color Opacity Modifiers

Colors can be appended with hex opacity for transparency:

```javascript
// Syntax: color + opacity (00-FF in hex)
`${C.blue}11`  // 11 = ~7% opacity - very subtle backgrounds
`${C.blue}22`  // 22 = ~13% opacity - hover states
`${C.blue}55`  // 55 = ~33% opacity - borders, inactive states
`${C.blue}88`  // 88 = ~53% opacity - semi-transparent overlays
```

**Common Patterns:**
- `08` - Very subtle button backgrounds
- `22` - Active button backgrounds, glow boxes
- `55` - Borders on inactive elements
- `FF` - Full opacity (can be omitted)

---

## Typography

### Font Families

Defined in `shared.js` as the `F` constant object.

```javascript
F.head = '"Orbitron", sans-serif'           // Headers, titles, numbers
F.mono = '"Share Tech Mono", monospace'     // Body text, labels, buttons
```

**Font Loading:**
Both fonts are loaded via Google Fonts CDN in `index.html`:
```html
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap" rel="stylesheet">
```

### Font Usage Guidelines

| Element | Font | Weight | Size | Usage |
|---------|------|--------|------|-------|
| **Large Lane Numbers** | `F.head` | 700-900 | 96px+ | Kiosk lane identifiers |
| **Section Headers** | `F.head` | 700 | 1.2-1.5rem | View titles, step headers |
| **Status Text** | `F.head` | 700 | 18-24px | Lane status messages |
| **Countdown Timers** | `F.head` | 400 | 42px+ | Large numeric displays |
| **Buttons** | `F.mono` | 400 | 0.65-0.85rem | All interactive buttons |
| **Body Text** | `F.mono` | 400 | 0.7-0.9rem | Labels, descriptions, info |
| **Small Labels** | `F.mono` | 400 | 0.55-0.65rem | Field labels, metadata |

### Text Effects

**Glow Effects (Status Text):**
```javascript
// Soft glow for readability
textShadow: `0 0 10px ${color}, 0 0 20px ${color}`

// Strong glow for emphasis
textShadow: `0 0 15px ${color}66, 0 0 30px ${color}44, 0 0 50px ${color}22`

// Countdown timer glow (animated)
textShadow: '0 0 15px rgba(255, 149, 0, 0.6), 0 0 30px rgba(255, 149, 0, 0.3)'
```

**Letter Spacing:**
```javascript
letterSpacing: '0.05em'   // Buttons (slight spacing)
letterSpacing: '0.08em'   // Labels (moderate spacing)
letterSpacing: '0.1em'    // Small labels (wide spacing)
letterSpacing: '2-3px'    // Status text (pixel values for larger text)
```

**Text Transform:**
```javascript
textTransform: 'uppercase'  // All buttons, labels, status text
```

---

## Responsive Design

### Breakpoints

The system uses a single breakpoint for compact/mobile layouts:

```javascript
// In shared.js
export const useCompact = () => {
  const [compact, setCompact] = useState(window.innerWidth <= 639);
  // ... resize listener
  return compact;
};
```

**Breakpoint:**
- **Desktop:** > 639px width
- **Compact/Mobile:** ≤ 639px width

### Responsive Patterns

**Always use the `useCompact()` hook:**
```javascript
const compact = useCompact();

// Then conditionally apply styles:
<div style={{
  padding: compact ? 12 : 24,
  fontSize: compact ? '0.7rem' : '0.9rem',
  gap: compact ? 6 : 12
}}>
```

**Common Responsive Adjustments:**

| Property | Desktop | Compact |
|----------|---------|---------|
| **Padding** | 20-24px | 12-16px |
| **Gap** | 12-16px | 6-8px |
| **Font Size (Body)** | 0.8-0.9rem | 0.65-0.75rem |
| **Font Size (Headers)** | 1.2-1.5rem | 0.95-1.1rem |
| **Button Padding** | 10-14px | 8-10px |
| **Button Min-Width** | 48px | 40px |
| **Button Min-Height** | 48px | 40px |
| **Border Width** | 2px | 1.5px |

**Layout Changes:**
```javascript
// Grid columns
gridTemplateColumns: compact ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)'

// Flex direction
flexDirection: compact ? 'column' : 'row'

// Max width
maxWidth: compact ? '100%' : 600

// Conditional rendering
{compact ? <MobileDropdown /> : <DesktopButtonGroup />}
```

---

## Components

### Buttons (`Btn`)

**Standard Button Pattern:**
```javascript
const Btn = ({ children, color, onClick, active, disabled, w, compact }) => (
  <button
    onClick={(e) => {
      e.stopPropagation();
      if (!disabled) onClick?.();
    }}
    disabled={disabled}
    style={{
      fontFamily: F.mono,
      fontSize: compact ? '0.65rem' : '0.72rem',
      letterSpacing: '0.06em',
      padding: compact ? '8px 10px' : '10px 14px',
      minHeight: compact ? 40 : 48,
      minWidth: w || (compact ? 40 : 48),
      border: `1.5px solid ${disabled ? C.dim : active ? color : color + '55'}`,
      background: active ? `${color}22` : disabled ? `${C.dim}11` : `${color}08`,
      color: disabled ? C.dim : color,
      borderRadius: 5,
      cursor: disabled ? 'default' : 'pointer',
      textTransform: 'uppercase',
      boxShadow: active ? `0 0 8px ${color}22` : 'none',
      transition: 'all 0.15s',
      whiteSpace: compact ? 'normal' : 'nowrap',
    }}
  >
    {children}
  </button>
);
```

**Button States:**

| State | Border | Background | Color | Shadow | Cursor |
|-------|--------|------------|-------|--------|--------|
| **Default** | `color + '55'` (33%) | `color + '08'` (5%) | `color` | None | pointer |
| **Active** | `color` (100%) | `color + '22'` (13%) | `color` | `0 0 8px ${color}22` | pointer |
| **Disabled** | `C.dim` | `C.dim + '11'` | `C.dim` | None | default |
| **Hover** | (inherit) | (inherit) | (inherit) | (inherit) | pointer |

**Button Sizing:**
```javascript
// Minimum touch target: 48px desktop, 40px mobile
minHeight: compact ? 40 : 48,
minWidth: compact ? 40 : 48,

// Custom width via `w` prop
w={200}  // Sets minWidth to 200px
```

### Input Fields

**Standard Input Pattern:**
```javascript
const Input = ({ value, onChange, placeholder, type = 'text', compact }) => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    style={{
      fontFamily: F.mono,
      fontSize: compact ? '0.7rem' : '0.8rem',
      padding: compact ? '10px 12px' : '12px 14px',
      background: C.bg,
      border: `1.5px solid ${C.blue}55`,
      borderRadius: 5,
      color: C.text,
      width: '100%',
      outline: 'none',
      transition: 'all 0.15s',
    }}
    onFocus={(e) => {
      e.target.style.borderColor = C.blue;
      e.target.style.boxShadow = `0 0 8px ${C.blue}22`;
    }}
    onBlur={(e) => {
      e.target.style.borderColor = `${C.blue}55`;
      e.target.style.boxShadow = 'none';
    }}
  />
);
```

**Input States:**
- **Default:** Blue border (33% opacity)
- **Focus:** Full blue border + soft glow
- **Blur:** Returns to default

### Stepper Controls

**For numeric inputs:**
```javascript
const Stepper = ({ value, onChange, min = 1, max = 20, color, label, compact }) => (
  <div style={{ display:'flex', alignItems:'center', gap: 6 }}>
    <span style={{
      fontFamily: F.mono,
      fontSize: '0.6rem',
      color: C.text,
      letterSpacing: '0.1em',
      minWidth: compact ? 45 : 55
    }}>
      {label}
    </span>
    <button onClick={() => onChange(Math.max(min, value - 1))} style={{
      width: compact ? 36 : 44,
      height: compact ? 36 : 44,
      border: `1px solid ${color}55`,
      background: `${color}11`,
      color,
      borderRadius: 4,
      cursor: 'pointer',
      fontSize: 18
    }}>
      −
    </button>
    <span style={{
      fontFamily: F.head,
      fontSize: '1rem',
      fontWeight: 700,
      color,
      textShadow: `0 0 6px ${color}66`,
      minWidth: 24,
      textAlign: 'center'
    }}>
      {value}
    </span>
    <button onClick={() => onChange(Math.min(max, value + 1))} style={{
      width: compact ? 36 : 44,
      height: compact ? 36 : 44,
      border: `1px solid ${color}55`,
      background: `${color}11`,
      color,
      borderRadius: 4,
      cursor: 'pointer',
      fontSize: 18
    }}>
      +
    </button>
  </div>
);
```

### Cards

**Lane Card Pattern:**
```javascript
<div style={{
  background: C.card,
  border: `2px solid ${statusColor}55`,
  borderRadius: 8,
  padding: compact ? 12 : 16,
  boxShadow: `0 0 15px ${statusColor}22`,
  transition: 'all 0.15s'
}}>
```

**Card Borders:**
- Use `2px solid` with 33% opacity of status color
- `borderRadius: 8` for all cards
- Add glow shadow matching border color

---

## Spacing & Layout

### Spacing Scale

```javascript
// Gap between elements
gap: compact ? 6 : 12     // Small gaps (buttons in a row)
gap: compact ? 12 : 16    // Medium gaps (sections)
gap: compact ? 16 : 24    // Large gaps (major sections)

// Padding
padding: compact ? 12 : 16    // Card padding
padding: compact ? 16 : 24    // Container padding
padding: compact ? 20 : 28    // Large container padding

// Margin
marginBottom: compact ? 12 : 16   // Between form sections
marginBottom: compact ? 24 : 28   // Between major sections
marginTop: compact ? 16 : 20      // After headers
```

### Grid Layouts

```javascript
// Lane grid (4 lanes per row on desktop, 2 on mobile)
display: 'grid',
gridTemplateColumns: compact ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
gap: compact ? 8 : 12

// Week view (8 lanes x 7 days)
gridTemplateColumns: compact ? '50px repeat(7, 1fr)' : '70px repeat(7, 1fr)',
gap: compact ? 4 : 6

// Duration buttons (3 columns)
gridTemplateColumns: 'repeat(3, 1fr)',
gap: 10
```

### Flexbox Patterns

```javascript
// Horizontal row with items
display: 'flex',
alignItems: 'center',
gap: 12,
flexWrap: 'wrap'

// Right-aligned buttons
display: 'flex',
justifyContent: 'flex-end',
gap: 16

// Centered content
display: 'flex',
justifyContent: 'center',
alignItems: 'center'

// Space between items
display: 'flex',
justifyContent: 'space-between',
alignItems: 'center'

// Auto-margin for right alignment
display: 'flex',
marginLeft: 'auto'
```

---

## Animations & Transitions

### CSS Transitions

**Standard Transition:**
```javascript
transition: 'all 0.15s'  // Default for most interactive elements
transition: 'all 0.3s ease'  // Slower for major state changes
```

**Avoid transitions on:**
- Dynamic timeline blocks (causes re-animation on state updates)
- Frequently updating elements

### CSS Animations

**Pulse Effect (Service Call):**
```css
@keyframes statusPulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.7;
    transform: scale(0.98);
  }
}
animation: statusPulse 1s ease-in-out infinite;
```

**Fade Effect (Staff Responding):**
```css
@keyframes statusFade1 {
  0%, 100% { opacity: 1; }
  25% { opacity: 0; }
  50%, 75% { opacity: 0; }
}
animation: statusFade1 4s ease-in-out infinite;
```

**Countdown Pulse:**
```css
@keyframes countdownPulse {
  0%, 100% {
    text-shadow: 0 0 15px rgba(255, 149, 0, 0.6), 0 0 30px rgba(255, 149, 0, 0.3);
  }
  50% {
    text-shadow: 0 0 20px rgba(255, 149, 0, 0.8), 0 0 40px rgba(255, 149, 0, 0.5), 0 0 60px rgba(255, 149, 0, 0.2);
  }
}
animation: countdownPulse 2s ease-in-out infinite;
```

**Warning Pulse:**
```css
@keyframes warningPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
animation: warningPulse 1s ease-in-out infinite;
```

---

## Borders & Shadows

### Border Radius

```javascript
borderRadius: 4   // Small elements (stepper buttons)
borderRadius: 5   // Buttons, inputs
borderRadius: 6   // Week/month view cells
borderRadius: 8   // Cards, major containers
borderRadius: 12  // Large kiosk buttons
```

### Box Shadows

**Subtle Glow:**
```javascript
boxShadow: `0 0 8px ${color}22`  // Active buttons, focus states
```

**Medium Glow:**
```javascript
boxShadow: `0 0 15px ${color}22`  // Cards with status
```

**Strong Glow:**
```javascript
boxShadow: `0 0 20px ${color}44, 0 0 40px ${color}22`  // Prominent status indicators
```

**Kiosk Hover:**
```javascript
boxShadow: '0 0 30px rgba(0, 255, 255, 0.3)'  // Strong interactive feedback
```

### Borders

**Standard Border:**
```javascript
border: `1.5px solid ${color}55`  // Default inactive
border: `2px solid ${color}`      // Active/selected
border: `2px solid ${color}22`    // Subtle dividers
```

---

## Kiosk-Specific Styling

### Maintenance Caution Stripes

```css
.lane-column.maintenance::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 20px;
  background: repeating-linear-gradient(
    45deg,
    rgba(107, 126, 166, 0.3),
    rgba(107, 126, 166, 0.3) 15px,
    rgba(42, 48, 96, 0.3) 15px,
    rgba(42, 48, 96, 0.3) 30px
  );
  z-index: 10;
  pointer-events: none;
}

.lane-column.maintenance::after {
  /* Same but on right side with -45deg */
}
```

### Large Status Numbers

```javascript
// Kiosk lane numbers (zero-padded)
String(laneNum).padStart(2, '0')  // 01, 02, ... 08

style={{
  fontSize: 96,
  fontWeight: 'bold',
  fontFamily: F.head,
  color: statusColor,
  textShadow: `0 0 30px ${statusColor}, 0 0 60px ${statusColor}`
}}
```

### Subdued Maintenance (Kiosk)

```javascript
// Maintenance mode in kiosk uses muted colors
color: '#6b7ea6',
textShadow: '0 0 10px rgba(107, 126, 166, 0.3)',
opacity: 0.6  // Lane numbers
opacity: 0.7  // Status text
```

---

## Accessibility Guidelines

### Color Contrast

✅ **All text meets WCAG AA standards:**
- Text on dark background: Use bright accent colors
- Small text: Minimum 4.5:1 contrast ratio
- Large text (18px+): Minimum 3:1 contrast ratio

### Touch Targets

✅ **Minimum 48px × 48px** on desktop (40px on mobile)
```javascript
minWidth: compact ? 40 : 48,
minHeight: compact ? 40 : 48
```

### Focus States

✅ **All interactive elements have focus states:**
```javascript
onFocus={(e) => {
  e.target.style.borderColor = C.blue;
  e.target.style.boxShadow = `0 0 8px ${C.blue}22`;
}}
```

### Disabled States

✅ **Visually distinct disabled states:**
```javascript
disabled={someCondition}
style={{
  color: disabled ? C.dim : color,
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.5 : 1
}}
```

---

## Text Overflow Handling

### Ellipsis Truncation

For dynamic content that may overflow:
```javascript
<div style={{
  maxWidth: compact ? '150px' : '200px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}} title={fullText}>
  {fullText}
</div>
```

### Prevent Overlap

Use flexbox with `flexShrink: 0` for fixed elements:
```javascript
<div style={{ display: 'flex', gap: 12 }}>
  <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
    Long text here...
  </div>
  <button style={{ flexShrink: 0 }}>
    Button
  </button>
</div>
```

---

## Code Style Conventions

### Inline Styles Only

❌ **NEVER use external CSS files or className-based styles**
```javascript
// WRONG
<div className="my-component">

// WRONG
import './styles.css';
```

✅ **ALWAYS use inline styles with shared constants**
```javascript
// CORRECT
<div style={{
  fontFamily: F.mono,
  color: C.text,
  padding: compact ? 12 : 16
}}>
```

### Conditional Styling

```javascript
// Ternary for single property
color: active ? C.green : C.dim

// Object spreading for multiple properties
{...(compact && {
  fontSize: '0.7rem',
  padding: '8px 10px'
})}

// Computed values
border: `2px solid ${status === 'active' ? C.green : C.dim}55`
```

### Consistent Ordering

Style properties in consistent order:
1. Layout (display, position, flexbox/grid)
2. Sizing (width, height, padding, margin)
3. Typography (font, size, weight, spacing)
4. Colors (color, background, border)
5. Visual effects (shadow, border-radius, opacity)
6. Interactions (cursor, transition, animation)

---

## Common Patterns

### Section Headers

```javascript
<div style={{
  fontFamily: F.head,
  fontSize: compact ? '0.95rem' : '1.2rem',
  fontWeight: 700,
  color: C.blue,
  marginBottom: compact ? 12 : 16,
  textTransform: 'uppercase',
  letterSpacing: '0.05em'
}}>
  Section Title
</div>
```

### Info Labels

```javascript
<div style={{
  fontFamily: F.mono,
  fontSize: '0.6rem',
  color: C.text,
  letterSpacing: '0.08em',
  marginBottom: 8,
  textTransform: 'uppercase'
}}>
  Field Label
</div>
```

### Status Indicators

```javascript
<div style={{
  fontFamily: F.head,
  fontSize: '1.1rem',
  fontWeight: 700,
  color: statusColor,
  textShadow: `0 0 10px ${statusColor}, 0 0 20px ${statusColor}`,
  letterSpacing: '2px',
  textTransform: 'uppercase'
}}>
  {statusText}
</div>
```

### Error Messages

```javascript
<div style={{
  background: `${C.red}15`,
  border: `2px solid ${C.red}55`,
  borderRadius: 8,
  padding: 16,
  marginBottom: 24
}}>
  <div style={{
    fontFamily: F.mono,
    fontSize: '0.7rem',
    color: C.red,
    marginBottom: 8,
    letterSpacing: '0.05em'
  }}>
    • Error message here
  </div>
</div>
```

---

## Visual Hierarchy

### Size Hierarchy (Desktop)

1. **Extra Large** - 96px+ (Kiosk lane numbers)
2. **Large** - 42-48px (Countdown timers, major displays)
3. **Medium-Large** - 18-24px (Status text, lane status)
4. **Medium** - 1.2-1.5rem (Section headers)
5. **Base** - 0.8-0.9rem (Body text)
6. **Small** - 0.65-0.75rem (Button text)
7. **Extra Small** - 0.55-0.65rem (Labels, metadata)

### Color Hierarchy

1. **Primary Focus** - Full brightness accent color
2. **Secondary Focus** - Accent color with glow
3. **Tertiary** - Accent color at 33% opacity
4. **Default** - C.text (#8892b8)
5. **Disabled** - C.dim (#2a3060)

### Weight Hierarchy

1. **Critical Status** - Bold (700-900) + glow + animation
2. **Important Info** - Bold (700) + color
3. **Headers** - Bold (700) + uppercase
4. **Body** - Regular (400)
5. **Subdued** - Regular (400) + opacity 0.6-0.7

---

## Best Practices

### ✅ DO

- Use shared constants (`C.*`, `F.*`) exclusively
- Apply responsive styles via `useCompact()` hook
- Use uppercase for buttons, labels, and status text
- Add glow effects to status indicators
- Provide focus states for all interactive elements
- Use minimum 48px touch targets (40px mobile)
- Keep transitions subtle (0.15s default)
- Handle text overflow with ellipsis
- Use flexShrink: 0 to prevent button squishing

### ❌ DON'T

- Create external CSS files or use classNames
- Use arbitrary colors outside the palette
- Add transitions to frequently updating elements
- Forget responsive styling for mobile
- Mix fonts (only Orbitron and Share Tech Mono)
- Use lowercase for UI text (except party names)
- Create touch targets smaller than 40px
- Let text overflow onto buttons
- Use opacity below 0.5 for readable text

---

## Testing Checklist

When adding new components, verify:

- [ ] Uses `C.*` and `F.*` constants only
- [ ] Responsive with `useCompact()` hook
- [ ] Touch targets ≥ 48px (40px mobile)
- [ ] Focus states on interactive elements
- [ ] Disabled states clearly distinguished
- [ ] Text doesn't overflow or overlap buttons
- [ ] Colors have sufficient contrast
- [ ] Uppercase applied to UI text
- [ ] Transitions are smooth but not distracting
- [ ] Consistent with existing component patterns

---

## Quick Reference

### Common Snippets

**Button:**
```javascript
<Btn color={C.blue} active={isActive} onClick={handleClick} compact={compact}>
  Action
</Btn>
```

**Input:**
```javascript
<Input value={text} onChange={setText} placeholder="Enter..." compact={compact} />
```

**Card:**
```javascript
<div style={{
  background: C.card,
  border: `2px solid ${C.blue}55`,
  borderRadius: 8,
  padding: compact ? 12 : 16
}}>
```

**Section Header:**
```javascript
<div style={{
  fontFamily: F.head,
  fontSize: compact ? '0.95rem' : '1.2rem',
  fontWeight: 700,
  color: C.blue,
  marginBottom: compact ? 12 : 16,
  textTransform: 'uppercase',
  letterSpacing: '0.05em'
}}>
```

---

**Last Updated:** February 2026
**Version:** 1.0
