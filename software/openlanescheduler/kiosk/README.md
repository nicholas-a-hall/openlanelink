# Lunar Lanes Customer Service Kiosk

Tablet-based customer service UI for lane-side use at Lunar Lanes bowling alley.

## Aesthetic
- Retro-futurism / sci-fi with CRT effects, scan lines, vignette overlay
- Neon retrowave palette: cyan primary, magenta for pinsetter, green for add functions, orange for staff alerts
- Orbitron font throughout
- Matches existing Lunar Lanes dashboard aesthetic

## Current Features

### Main Actions
- **Cycle Pinsetter** (full-width, top) — Most used. Triggers pin reset with animated feedback
- **Add Game** — Confirmation modal, adds game for all current bowlers
- **Add Player** — Notifies staff to assist
- **Notify Staff** (full-width, bottom) — Opens panel with categorized issues:
  - Pinsetter Issue (urgent)
  - Ball Return (urgent)
  - Scoring Problem
  - Spill / Cleanup
  - General Question
  - Other Issue

### Status Banner
Displays between header and action buttons. Three states:
- **Ready to Bowl** (green) — Default, good to go
- **Please Wait** (yellow, pulsing) — Pinsetter resetting, staff needs moment
- **Message** (cyan) — Notifications from Front Desk or Mechanic with source badge

Status is controlled via state:
```js
setLaneStatus({
  state: 'ready' | 'wait' | 'message',
  message: string | null,
  source: 'desk' | 'mechanic' | null
})
```

### Boot Sequence
2-second animated boot screen when tablet initializes.

## Planned Features (Context for Future Development)

### Food & Drink Ordering
- Integration with Clover POS
- Menu display with categories
- Order submission to kitchen/bar
- Order status tracking

### Scoring System Controls
- Integration with lane scoring system
- Player name editing
- Score corrections
- Game reset options

## Configuration

Lane number is currently hardcoded:
```js
const laneNumber = 4; // Would be configured per tablet
```

Consider environment variable or URL parameter for production deployment.

## Tech Stack
- React 18
- Vite
- No external UI libraries (custom styled components)

## Getting Started

```bash
npm install
npm run dev
```

Opens at http://localhost:3000

## File Structure
```
src/
  LunarLanesKiosk.jsx  # Main component with all styles inline
  main.jsx             # React entry point
index.html             # HTML template with tablet meta tags
```

## Integration Points

### Backend Communication (TODO)
- WebSocket or polling for lane status updates
- API calls for:
  - Pinsetter cycle trigger
  - Staff notifications
  - Add game/player requests
  - (Future) Clover POS orders
  - (Future) Scoring system integration

### Lane Configuration
Each tablet needs to know its lane number. Options:
- URL parameter: `?lane=4`
- Local storage on initial setup
- Device-specific config file
- Backend assignment by device ID
