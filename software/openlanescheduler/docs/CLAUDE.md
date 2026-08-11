# OpenLane Scheduler - Project Guide for Claude

## Project Overview

**OpenLane Scheduler** is a real-time bowling alley management system with three main components:
- **Manager Dashboard** - Full control panel for staff to manage lanes, reservations, and operations
- **Lane Kiosks** - Per-lane displays showing status and allowing service calls
- **Backend** - Node.js server handling state management, WebSocket sync, and Google Calendar integration

**Key Features:**
- Real-time state synchronization across all displays via Socket.IO
- Two-way Google Calendar integration (read reservations, create via UI)
- Walk-in session management with time tracking
- Lane grouping for large parties
- Maintenance mode and service call system
- Redis persistence

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Manager UI │────▶│   Backend   │◀────│  Kiosk UIs  │
│ (port 8080) │     │ (port 3001) │     │ (8081-8084) │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    ▼             ▼
              ┌─────────┐   ┌──────────────┐
              │  Redis  │   │ Google Cal   │
              │ (6379)  │   │ (API)        │
              └─────────┘   └──────────────┘
```

**Tech Stack:**
- Frontend: React + Vite, Socket.IO client, inline styling
- Backend: Express + Socket.IO, Redis, MongoDB, Google Calendar API
- Deployment: Docker Compose with 7 services

## Mechanics Module

**IMPORTANT:** The Mechanics module provides a dedicated interface for maintenance staff at `/mechanic` route (separate from manager dashboard).

### Overview

The Mechanics module enables systematic tracking of:
- **Service Call History** - Complete logs of all service issues with categorization
- **Component Inventory** - Parts tracking with low-stock alerts and usage history
- **Maintenance Tasks** - Preventative and general maintenance scheduling
- **Brunswick A2 PM Module** - Auto-generated preventative maintenance based on manufacturer schedules
- **Lane Context** - Per-lane schedules showing maintenance windows

**Access:** Navigate to `http://localhost:8080/mechanic` (or port 8081-8084 from kiosks)

### Data Architecture Split

**CRITICAL:** Mechanics data uses MongoDB for persistence, while real-time state uses Redis:

```
┌─────────────────────────┬──────────────────────────┐
│      Redis (Real-Time)  │  MongoDB (Persistent)    │
├─────────────────────────┼──────────────────────────┤
│ • Walk-ins              │ • Service history        │
│ • Maintenance flags     │ • Component inventory    │
│ • Groups                │ • Component usage log    │
│ • Service calls (active)│ • Maintenance tasks      │
│ • Reservations          │ • PM configuration       │
│ • Excluded events       │                          │
└─────────────────────────┴──────────────────────────┘
```

**Why this split?**
- Redis: Fast read/write for real-time UI updates, ephemeral data
- MongoDB: Document storage for historical data, complex queries, long-term persistence

### MongoDB Collections

**`service_history`** - Historical service call logs
```javascript
{
  _id: 'sc-1234567890-lane3',
  lane: 3,
  startTime: 1234567890,
  endTime: 1234567900,
  duration: 10000,
  acked: true,
  origin: 'kiosk',
  issue: {
    category: 'ball-return',
    severity: 'medium',
    description: 'Ball stuck in return mechanism',
    resolvedBy: 'John D.'
  },
  componentsUsed: [
    { component: 'belt-drive-small', quantity: 1 }
  ],
  createdAt: Date
}
```

**Indexes:** `{ startTime: -1 }`, `{ lane: 1, startTime: -1 }`, `{ 'issue.category': 1 }`

**`components`** - Component inventory
```javascript
{
  _id: 'pins-white',
  name: 'White Bowling Pins',
  quantity: 120,
  minStock: 80,
  category: 'pins',
  unit: 'pieces'
}
```

**`component_usage`** - Usage history log
```javascript
{
  componentId: 'belt-drive-small',
  quantity: 1,
  timestamp: 1234567890,
  lane: 3,
  serviceCallId: 'sc-1234567890-lane3',
  createdAt: Date
}
```

**Indexes:** `{ timestamp: -1 }`, `{ componentId: 1, timestamp: -1 }`

**`maintenance_tasks`** - Task tracking
```javascript
{
  _id: 'mt-1234567890',
  type: 'preventative',
  title: 'Weekly lane oil application',
  description: 'Apply conditioning oil to lanes 1-8',
  lane: null, // null = facility-wide
  priority: 'high',
  status: 'pending',
  assignedTo: 'John D.',
  scheduledFor: 1234567890,
  estimatedDuration: 3600000,
  recurringPattern: 'weekly',
  source: 'pm-auto', // 'pm-auto' | 'manual'
  pmTemplateId: 'brunswick-a2-weekly',
  createdAt: Date,
  completedAt: Date | null
}
```

**Indexes:** `{ status: 1 }`, `{ scheduledFor: 1 }`, `{ lane: 1 }`

**`pm_config`** - PM module configuration
```javascript
{
  _id: 'config',
  enabled: true,
  equipmentType: 'brunswick-a2',
  autoGenerate: true,
  autoGenTime: '06:00',
  lastGenerated: 1234567890,
  skipWeekends: false,
  updatedAt: Date
}
```

### Mechanics Socket.IO Actions

**Service History:**
```javascript
dispatch('GET_SERVICE_HISTORY', {
  startTime, endTime, lane, category, limit, offset
});
```

**Component Management:**
```javascript
dispatch('GET_COMPONENTS', {});
dispatch('UPDATE_COMPONENT_INVENTORY', {
  componentId: 'pins-white',
  quantity: 10 // positive = add, negative = subtract
});
dispatch('ADD_COMPONENT', {
  componentId: 'new-part-id',
  component: { name, quantity, minStock, category, unit }
});
```

**Maintenance Tasks:**
```javascript
dispatch('GET_MAINTENANCE_TASKS', { status, lane });
dispatch('CREATE_MAINTENANCE_TASK', {
  type, title, description, lane, priority,
  assignedTo, scheduledFor, estimatedDuration, recurringPattern
});
dispatch('UPDATE_MAINTENANCE_TASK', { taskId, updates });
dispatch('COMPLETE_MAINTENANCE_TASK', {
  taskId, completedBy, notes, componentsUsed
});
dispatch('DELETE_MAINTENANCE_TASK', { taskId });
```

**PM Module:**
```javascript
dispatch('GET_PM_CONFIG', {});
dispatch('UPDATE_PM_CONFIG', {
  enabled, equipmentType, autoGenerate, autoGenTime
});
dispatch('GENERATE_PM_TASKS', { date }); // Manual generation
```

**Enhanced Service Call Resolution:**
```javascript
// Old: dispatch('RESOLVE_SERVICE_CALL', { lane });
// New: Includes issue logging and component tracking
dispatch('RESOLVE_SERVICE_CALL', {
  lane,
  issue: {
    category: 'ball-return' | 'pinsetter',
    severity: 'low' | 'medium' | 'high',
    description: 'Detailed issue description',
    resolvedBy: 'Mechanic Name'
  },
  componentsUsed: [
    { component: 'belt-drive-small', quantity: 1 }
  ]
});
```

### Component Inventory Seeding

**Initial Setup:**
```bash
# Seed default component inventory to MongoDB
docker-compose exec backend node src/services/seedComponents.js

# Force overwrite existing components
docker-compose exec backend node src/services/seedComponents.js --force
```

**Default Components:**
- **Pins:** White bowling pins (100 qty, min 80)
- **Mechanical:** Drive belts small/large, pinsetter motor
- **Electronics:** Pinsetter sensor, ball return sensor
- **Supplies:** Lane oil, cleaners, lubricant spray, cleaning pads

**Adding Custom Components:**
Use the mechanics UI (`/mechanic` → Components tab → Add Component button)

### Brunswick A2 PM Module

**Preventative Maintenance Templates:**

The system includes manufacturer-based PM schedules for Brunswick A2 pinsetters:

- **Daily Tasks** (per lane, ~11 minutes):
  - Visual inspection of pin deck
  - Verify sweep operation
  - Check spotting cups alignment
  - Inspect cushions and rails
  - Test safety switches

- **Weekly Tasks** (per lane, ~30 minutes):
  - Lubricate moving parts
  - Check belt tension
  - Clean pin elevator
  - Inspect electrical connections
  - Calibrate sensors

- **Monthly Tasks** (per lane, ~60 minutes):
  - Comprehensive mechanical inspection
  - Clean and adjust all sensors
  - Check motor operation
  - Inspect wiring and connections
  - Replace worn components

- **Quarterly Tasks** (facility-wide, ~120 minutes):
  - Deep cleaning of all pinsetters
  - Major component inspection
  - Calibration procedures
  - Preventative part replacement

**Auto-Generation:**

When enabled, the PM module automatically creates tasks:
1. On server startup, checks if today's PM tasks exist
2. If not, generates from templates based on equipment type
3. Runs daily at configured time (default: 6:00 AM)
4. Skips weekends if configured

**Configuration:**

Environment variables (optional):
```bash
PM_MODULE_ENABLED=true                    # Enable auto-generation
EQUIPMENT_TYPE=brunswick-a2               # or 'generic'
PM_AUTO_GEN_TIME=06:00                    # Daily generation time
```

Runtime configuration via Mechanics UI:
- Navigate to `/mechanic` → Maintenance tab
- Toggle "Enable PM Module"
- Select equipment type
- Click "Generate Today's PM Tasks" for manual generation

**PM Template Format:**
```javascript
{
  id: 'brunswick-a2-daily',
  equipmentType: 'brunswick-a2',
  category: 'daily',
  title: 'Daily Pinsetter Inspection',
  checklistItems: [
    {
      task: 'Visual inspection of pin deck',
      procedure: 'Check for damage, proper alignment',
      estimatedMinutes: 3,
      critical: true
    }
    // ... more checklist items
  ],
  frequency: 'daily',
  estimatedDuration: 660000, // 11 minutes
  priority: 'high',
  perLane: true,
  manualReference: 'Brunswick A2 Manual Section 4.2'
}
```

### Mechanics UI Components

**Route:** `/mechanic` (separate from manager dashboard)

**Styling:** Cyberpunk/terminal aesthetic with CRT effects:
- Orbitron font for headers
- Neon colors (#00ffff, #00ff88, #ff00ff, #ff6600, #ffc800)
- Scanlines and vignette overlay
- Dark background gradients
- High contrast borders

**Sub-Views:**
1. **Dashboard** - Active service calls, stats, upcoming events, low-stock alerts
2. **Service Log** - Historical service data with date/lane/category filters
3. **Components** - Inventory management grouped by category with +/- controls
4. **Maintenance** - Task manager with PM settings panel
5. **Lane Context** - Per-lane schedules showing maintenance windows

**Files:**
- `/frontend/src/Mechanic.jsx` - Route wrapper with CRT effects
- `/frontend/src/MechanicsView.jsx` - Main container with sub-view routing
- `/frontend/src/components/mechanics/ServiceCallDashboard.jsx`
- `/frontend/src/components/mechanics/QuickIssueLogger.jsx` - Service call resolution modal
- `/frontend/src/components/mechanics/ServiceLogView.jsx`
- `/frontend/src/components/mechanics/ComponentInventory.jsx`
- `/frontend/src/components/mechanics/MaintenanceTaskManager.jsx`
- `/frontend/src/components/mechanics/LaneContextView.jsx`

### Mechanics Testing Checklist

**Service Call Workflow:**
- [ ] Create service call from kiosk
- [ ] Navigate to `/mechanic`, verify call appears in dashboard
- [ ] Click "Resolve" and open QuickIssueLogger modal
- [ ] Select category, severity, add description
- [ ] Select components used with quantities
- [ ] Submit and verify:
  - Service call removed from active list
  - History entry created in Service Log view
  - Component inventory decremented
  - Walk-in service time accumulated (if applicable)

**Component Inventory:**
- [ ] Navigate to Components tab
- [ ] Verify all seeded components display with quantities
- [ ] Add quantity to a component, verify update
- [ ] Subtract quantity, verify low-stock warning when below minStock
- [ ] Add new component type, verify appears in correct category
- [ ] View component usage history after using in service call

**Maintenance Tasks:**
- [ ] Navigate to Maintenance tab
- [ ] Create new preventative task for specific lane
- [ ] Schedule task during open time window (check Lane Context)
- [ ] Mark task as "In Progress"
- [ ] Complete task with notes and components used
- [ ] Verify components decremented
- [ ] Check recurring task creates next occurrence

**PM Module:**
- [ ] Enable PM module in Maintenance settings panel
- [ ] Select equipment type: Brunswick A2
- [ ] Click "Generate Today's PM Tasks"
- [ ] Verify daily tasks created for all 8 lanes
- [ ] Check task details show Brunswick A2 checklist items
- [ ] Complete a PM task, verify marked as completed
- [ ] Restart backend, verify auto-generation on startup
- [ ] Disable PM module, verify no auto-generation

**Real-Time Sync:**
- [ ] Open two browser windows (both on `/mechanic`)
- [ ] Create service call in window 1
- [ ] Verify window 2 shows new call immediately
- [ ] Resolve service call in window 2 with logging
- [ ] Verify window 1 updates when resolved

**Mobile/Responsive:**
- [ ] Resize browser to mobile width (< 640px)
- [ ] Verify sub-view tabs work on mobile
- [ ] Verify service call cards stack vertically
- [ ] Test modal overlays on mobile
- [ ] Check button touch targets are adequate

## Key Directories & Files

### Backend (`/backend`)
- **`server.js`** - Main server with state management, Socket.IO handlers, GCal sync
- **`googleCalendar.js`** - Service account auth and event CRUD operations
- **`package.json`** - Dependencies: express, socket.io, redis, googleapis

### Frontend (`/frontend`)
- **`src/App.jsx`** - Main manager dashboard with multiple views:
  - Lanes view - grid of all 8 lanes with status and controls
  - Timeline view - Hour/Day/Week/Month views of reservations
  - Reservation creation view - step-by-step form
- **`src/Display.jsx`** - Read-only display panel for `/display` route
- **`src/shared.js`** - WebSocket hook, color/font constants, date utilities
- **`src/components/`** - Reservation form components:
  - `ReservationForm.jsx` - Main form with progressive steps
  - `CalendarPicker.jsx` - Date picker with react-calendar (week starts Sunday)
  - `TimeSelector.jsx` - Time slot availability checker
  - `LaneSelector.jsx` - Lane availability with smart walk-in conflict detection

### Kiosk (`/kiosk`)
- Similar structure to frontend but simplified for per-lane display
- Shows lane status, service call button, upcoming reservations
- **NOT the same as Display.jsx** - kiosks are interactive terminals

## Coding Conventions

### Single Page Application (SPA) Design
**CRITICAL:** This application **NEVER refreshes the page**. All updates happen via WebSocket.

- ✅ All interactions are client-side with Socket.IO state updates
- ✅ View switching uses React state (`setView`), not URL navigation
- ✅ No `<form>` submissions - use controlled components and onClick handlers
- ✅ No `window.location` changes or `.reload()` calls
- ✅ Real-time updates via WebSocket broadcasts, never polling
- ❌ Never use form submissions that cause page refresh
- ❌ Never use anchor tags with href that navigate away
- ❌ Never add any code that would break the SPA flow

### Styling Pattern
**CRITICAL:** This project uses **inline styles exclusively**. No CSS files, no styled-components.

```javascript
// ✅ CORRECT - Inline styles with shared constants
<div style={{
  fontFamily: F.mono,
  fontSize: compact ? '0.7rem' : '0.85rem',
  color: C.blue,
  padding: compact ? 12 : 16,
  border: `2px solid ${C.blue}55`,
  borderRadius: 8,
}}>
```

```javascript
// ❌ WRONG - External CSS classes
<div className="my-component">
```

### Color & Font Constants

Always use constants from `shared.js`:

```javascript
// Colors
C.bg        // Background: #0a0e27
C.card      // Card background: rgba(10,14,39,0.95)
C.blue      // Primary: #00b4ff
C.green     // Success: #39ff14
C.pink      // Secondary: #ff006e
C.red       // Error: #ff2a2a
C.purple    // Accent: #a855f7
C.yellow    // Warning: #ffbe0b
C.dim       // Disabled: #2a3060
C.text      // Text: #8892b8

// Fonts
F.head      // "Orbitron" - Headers
F.mono      // "Share Tech Mono" - Body text
```

### Responsive Design

Use the `useCompact()` hook for mobile responsiveness:

```javascript
const compact = useCompact(); // true on mobile (max-width: 639px)

<div style={{
  padding: compact ? 12 : 24,
  fontSize: compact ? '0.7rem' : '0.9rem'
}}>
```

### Text Overflow Protection

**CRITICAL:** Always prevent text overflow to keep buttons accessible:

```javascript
// ✅ CORRECT - Text truncation with ellipsis and tooltip
<div style={{
  maxWidth: compact ? '150px' : '200px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}} title={fullText}>
  {fullText}
</div>

// ✅ INFO section constraints
<div style={{
  flex: '1 1 auto',
  minWidth: 0,
  maxWidth: compact ? '100%' : '65%',  // Don't squeeze buttons
  flexWrap: 'wrap'
}}>

// ✅ BUTTONS section protection
<div style={{
  display: 'flex',
  flexWrap: 'wrap',
  flexShrink: 0,  // Never compress buttons
  minWidth: 'fit-content'
}}>
```

### Component Patterns

**Button Component:**
```javascript
const Btn = ({ children, color, onClick, active, disabled }) => (
  <button onClick={e => { e.stopPropagation(); if (!disabled) onClick?.(); }}
    disabled={disabled}
    style={{
      fontFamily: F.mono,
      fontSize: compact ? '0.65rem' : '0.72rem',
      padding: compact ? '8px 10px' : '10px 14px',
      border: `1.5px solid ${disabled ? C.dim : active ? color : color + '55'}`,
      background: active ? `${color}22` : disabled ? `${C.dim}11` : `${color}08`,
      color: disabled ? C.dim : color,
      borderRadius: 5,
      cursor: disabled ? 'default' : 'pointer',
      textTransform: 'uppercase',
      transition: 'all 0.15s',
    }}>
    {children}
  </button>
);
```

**Stepper Component:**
```javascript
const Stepper = ({ value, onChange, min, max, color, label }) => (
  <div style={{ display:'flex', alignItems:'center', gap:6 }}>
    <span style={{ fontFamily: F.mono, fontSize:'0.6rem' }}>{label}</span>
    <button onClick={() => onChange(Math.max(min, value - 1))}>−</button>
    <span style={{ fontFamily: F.head, color, fontWeight:700 }}>{value}</span>
    <button onClick={() => onChange(Math.min(max, value + 1))}>+</button>
  </div>
);
```

## State Management

### Backend State Structure

```javascript
state = {
  reservations: [
    {
      id: 'gcal-event-id',
      lane: 3,
      party: 'Smith Birthday',
      start: '14:00',
      end: '16:00',
      date: '2024-03-15',
      contact: '555-1234',
      guests: 12,
      type: 'reservation', // 'reservation' | 'hourly' | 'per-game'
      paid: false,
      arrived: false,
      cancelled: false,
      source: 'gcal'
    }
  ],
  walkIns: [
    {
      lane: 1,
      openedAt: 1234567890,
      bowlers: 4,
      type: 'hourly',
      hours: 2,
      paid: false
    }
  ],
  maintenance: { 5: true }, // lane 5 in maintenance
  groups: { 'g1': { lanes: [3, 4, 5] } },
  serviceCalls: { 2: { start: 1234567890, acked: false } },
  excludedEvents: ['event-id-1'], // No-show exclusions
  nextGroupId: 1
};
```

### Socket.IO Actions

All state changes go through Socket.IO actions:

```javascript
// Frontend
dispatch('ACTION_TYPE', { payload });

// Backend
handlers = {
  OPEN_WALKIN({ lane, bowlers, walkType, games, hours }) { },
  CLOSE_WALKIN({ lane }) { },
  CREATE_RESERVATION(data, socket) { }, // async
  DELETE_RESERVATION({ lane, start }) { }, // async
  CANCEL_RESERVATION({ lane, start }) { },
  MARK_ARRIVED({ lane, start }) { },
  TOGGLE_WALK_PAID({ lane }) { },
  TOGGLE_RES_PAID({ lane }) { },
  TOGGLE_MAINTENANCE({ lane }) { },
  // ... more actions
};
```

## Google Calendar Integration

### Read-Only Sync (Current Setup)
- Uses API key authentication
- Polls every 2 minutes (configurable)
- Parses events with format: `Lane 3 - Party Name`
- Description format: `guests:8 type:reservation contact:555-1234 paid:false`

### Two-Way Sync (Write Access)
- Requires service account JSON in `GCAL_SERVICE_ACCOUNT_JSON` env var
- Calendar must be shared with service account email
- Creates/updates/deletes events programmatically
- Each reservation creates a separate event per lane

### Event Format

**Title:** `Lane 3 - Johnson Birthday`

**Description:**
```
guests: 12
type: reservation
contact: 555-1234
paid: false
```

**Valid Types:**
- `reservation` - Created via UI
- `hourly` - Walk-in hourly billing
- `per-game` - Walk-in per-game billing

## Common Tasks

### Adding a New Socket.IO Action

1. **Backend** (`server.js`):
```javascript
handlers.MY_ACTION = async function({ param1, param2 }, socket) {
  // Modify state
  state.someArray.push({ param1, param2 });

  // Optionally emit errors
  if (error) {
    socket.emit('error', { type: 'validation', message: 'Error msg' });
    return;
  }

  // State broadcast happens automatically after handler
};
```

2. **Frontend** (any component):
```javascript
const { dispatch } = useSocket();
dispatch('MY_ACTION', { param1: 'value', param2: 123 });
```

### Adding a New View

1. **Add view state** in `App.jsx`:
```javascript
const [view, setView] = useState('lanes');
// views: 'lanes', 'timeline', 'new-reservation', 'my-new-view'
```

2. **Add view toggle or button**:
```javascript
<Btn color={C.blue} onClick={() => setView('my-new-view')}>
  My View
</Btn>
```

3. **Add view rendering**:
```javascript
{view === 'lanes' ? (
  <LanesView />
) : view === 'timeline' ? (
  <TimelineView />
) : view === 'my-new-view' ? (
  <MyNewView />
) : null}
```

### Creating a New Component

1. Create in `frontend/src/components/MyComponent.jsx`
2. Import dependencies:
```javascript
import { useState } from 'react';
import { C, F, useCompact } from '../shared';
```

3. Use inline styles with responsive design:
```javascript
export default function MyComponent({ prop1, prop2 }) {
  const compact = useCompact();

  return (
    <div style={{
      padding: compact ? 12 : 20,
      fontFamily: F.mono,
      color: C.text
    }}>
      {/* Component content */}
    </div>
  );
}
```

4. Import and use in parent component

### Modifying Reservation Form Flow

The reservation form (`ReservationForm.jsx`) uses progressive disclosure:

```javascript
// Step 1: Date & Duration
{selectedDate && (
  // Step 2: Time Selection
)}

{selectedDate && selectedDuration && selectedTime && (
  // Step 3: Lane Selection
)}

{selectedLanes.length > 0 && (
  // Step 4: Party Details
)}
```

To add a new step:
1. Add state for the new field
2. Add conditional rendering based on previous steps
3. Update validation in `validate()` function
4. Include in `onSubmit()` payload

## Important Patterns & Gotchas

### Date & Time Handling

**CRITICAL: Date Parsing - Always parse YYYY-MM-DD as local time, not UTC:**

```javascript
// ❌ WRONG - Parses as UTC, shifts to previous day in America/Chicago
new Date("2026-02-15") // Feb 15 UTC = Feb 14 in CST

// ✅ CORRECT - Parse as local date
const [year, month, day] = "2026-02-15".split('-').map(Number);
const localDate = new Date(year, month - 1, day);

// ✅ Use formatDateDisplay from shared.js (handles this automatically)
import { formatDateDisplay } from './shared';
formatDateDisplay("2026-02-15") // Correctly shows "Sat, Feb 15, 2026"
```

**Date Utilities in shared.js:**
```javascript
getWeekStart(date)        // Get Sunday of the week containing date
formatDateYYYYMMDD(date)  // Format to YYYY-MM-DD string
isToday(date)             // Check if date is today
addDays(date, days)       // Add/subtract days
formatDateDisplay(date)   // Format for display (handles timezone correctly)
```

**Always use America/Chicago timezone:**
```javascript
// When creating GCal events
start: {
  dateTime: startDateTime.toISOString(),
  timeZone: 'America/Chicago',
}
```

**Time format:** `HH:MM` (24-hour, zero-padded)
```javascript
const timeToNum = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h + m / 60; // 14:30 → 14.5
};
```

**Current/Upcoming Reservation Filtering:**
```javascript
// CRITICAL: Always filter by date AND time
const todayStr = now.toISOString().split('T')[0];
const isToday = r => (r.date || todayStr) === todayStr;
const curRes = l => res.find(r => r.lane === l && isToday(r) && nn >= tn(r.start) && nn < tn(r.end));
const upcoming = l => res.filter(r => r.lane === l && isToday(r) && tn(r.start) > nn).sort((a, b) => tn(a.start) - tn(b.start))[0];
```

### Timeline Views

**Four view modes in App.jsx:**
- `timelineViewMode` state: 'hour' | 'day' | 'week' | 'month'
- Separate render functions: `renderHourView()`, `renderDayView()`, `renderWeekView()`, `renderMonthView()`
- Date navigation state: `selectedDate`, `selectedWeekStart`, `selectedMonth`

**Week starts on Sunday** (visual only in calendar, doesn't affect date calculations):
```javascript
// getWeekStart returns Sunday of the week
const diff = -day; // Sunday = 0, Monday = 1, etc.
```

**Timeline block styling:**
```javascript
// ❌ WRONG - Causes re-animation on every state update
<div style={{ transition: 'all 0.15s' }}>

// ✅ CORRECT - No transition on timeline blocks
<div style={{ /* no transition property */ }}>
```

### Reservation Types

**Critical distinction:**
- `type: 'reservation'` - Pre-booked via UI, duration-based
- `type: 'hourly'` - Walk-in with hourly billing
- `type: 'per-game'` - Walk-in with per-game billing

**Never confuse these!** Walk-ins have `openedAt` timestamp, reservations have `start/end` times.

### Multi-Lane Reservations

When creating multi-lane reservations:
```javascript
lanes: [3, 4, 5] // Creates 3 separate reservations
```

Backend creates one GCal event per lane, all with same party details.

### State Persistence

- State persists in Redis at key `openlanescheduler:state`
- Saved after every action via `persistState()`
- Restored on server startup
- GCal sync runs every 120s and merges with local state

### Conflict Detection

**LaneSelector Smart Walk-In Detection:**

```javascript
// ✅ CORRECT - Only blocks if reservation overlaps with walk-in estimated close
const getWalkInEndTime = (walkIn) => {
  const openedAt = new Date(walkIn.openedAt);
  const durationMins = walkMins(walkIn);
  const serviceCallMinutes = serviceCallMins(walkIn); // Include service call time!
  const totalMins = durationMins + serviceCallMinutes;
  const endTime = new Date(openedAt.getTime() + totalMins * 60000);
  return endTime.getHours() + endTime.getMinutes() / 60;
};

// Only block if reservation starts BEFORE walk-in ends
if (selectedDate === today) {
  const walkIn = walkIns.find(w => w.lane === lane);
  if (walkIn) {
    const walkInEnd = getWalkInEndTime(walkIn);
    if (startNum < walkInEnd) return false; // Blocked
    // Otherwise, lane is available after walk-in ends
  }
}
```

**Key Points:**
- Walk-ins only block same-day reservations
- Lane is available if reservation starts after estimated close time
- Includes service call time in calculation
- No artificial buffers - uses exact estimated close time
- Must pass `serviceCalls` prop to LaneSelector component

## Development Workflow

### Local Development

```bash
# Start Redis
docker run -p 6379:6379 redis:7-alpine

# Backend
cd backend
npm install
npm run dev

# Frontend
cd frontend
npm install
npm run dev
```

### Docker Compose

```bash
# Build and start all services
docker-compose up --build

# Services:
# - redis:6379
# - backend:3001
# - frontend:8080 (manager)
# - kiosk-lanes-1-2:8081
# - kiosk-lanes-3-4:8082
# - kiosk-lanes-5-6:8083
# - kiosk-lanes-7-8:8084
```

### Environment Variables

**Backend:**
```bash
GCAL_API_KEY=<key>                    # Read-only access
GCAL_SERVICE_ACCOUNT_JSON=<json>      # Write access
GCAL_CALENDAR_ID=<calendar-id>
GCAL_SYNC_INTERVAL=120000             # 2 minutes
REDIS_URL=redis://redis:6379
TZ=America/Chicago
```

**Frontend:**
```bash
VITE_BACKEND_URL=http://localhost:3001
```

## Testing Checklist

When modifying the reservation system:

- [ ] Create reservation for today
- [ ] Create reservation for future date
- [ ] Verify GCal event created correctly
- [ ] Multi-lane reservation (select 2+ lanes)
- [ ] Conflict detection (try overlapping times)
- [ ] Cancel reservation (visual indication)
- [ ] Delete reservation (removes from GCal)
- [ ] Mark as arrived
- [ ] Toggle paid status
- [ ] Mobile view (test compact mode)
- [ ] Verify reservation appears in timeline
- [ ] Verify reservation shows in lane's upcoming section

## Troubleshooting

### "Module not found" errors
```bash
# Install dependencies
cd frontend && npm install
cd backend && npm install
```

### Calendar not loading
- Check `react-calendar` is installed: `npm list react-calendar`
- Verify no console errors about missing CSS

### Reservations not syncing
- Check `GCAL_API_KEY` is set and valid
- Check calendar is shared/public
- Check backend logs: `docker-compose logs backend`
- Trigger manual sync: `curl -X POST http://localhost:3001/api/sync`

### Can't create reservations
- Verify `GCAL_SERVICE_ACCOUNT_JSON` is set
- Check service account has calendar write permissions
- Check backend logs for GCal API errors

### State not persisting
- Verify Redis is running: `docker-compose ps redis`
- Check Redis logs: `docker-compose logs redis`

## Code Style Guidelines

1. **Always use inline styles** - No CSS files
2. **Use shared constants** - C for colors, F for fonts
3. **Responsive design** - Use `useCompact()` hook
4. **Time format** - Always 24-hour `HH:MM`
5. **Socket.IO for state** - All changes via dispatch
6. **Async handlers** - Mark with `async`, emit errors to socket
7. **Component naming** - PascalCase for components, camelCase for functions
8. **No external dependencies** unless necessary - Keep it lean

## Resources

- Socket.IO Docs: https://socket.io/docs/v4/
- React Calendar: https://github.com/wojtekmaj/react-calendar
- Google Calendar API: https://developers.google.com/calendar/api
- Redis Commands: https://redis.io/commands

## Getting Help

When asking Claude for help:
1. Specify which component you're working on
2. Mention if it's backend (server.js) or frontend (App.jsx/components)
3. Include any error messages from browser console or backend logs
4. Reference this guide for conventions

---

**Last Updated:** 2026-02-14
**Maintained by:** OpenLane Scheduler Development Team
