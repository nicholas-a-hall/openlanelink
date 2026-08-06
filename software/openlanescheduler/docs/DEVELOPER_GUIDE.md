# Developer's Guide - Lunar Lanes

## System Overview

Lunar Lanes is a real-time bowling alley management system built as a **Single Page Application (SPA)** with three distinct components working together through WebSocket-based state synchronization.

### Core Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     WebSocket Layer (Socket.IO)              │
│  Real-time bidirectional communication, state broadcast      │
└────────────┬─────────────────────────────────┬──────────────┘
             │                                 │
   ┌─────────▼─────────┐            ┌─────────▼──────────┐
   │  Frontend Apps    │            │   Backend Server   │
   │  - Manager (8080) │            │   - Express (3001) │
   │  - Display (/disp)│◄──────────►│   - State Manager  │
   │  - Kiosk (8081+)  │   Actions  │   - GCal Sync      │
   └───────────────────┘            └─────────┬──────────┘
                                              │
                                   ┌──────────┴──────────┐
                                   │                     │
                            ┌──────▼─────┐      ┌───────▼────────┐
                            │   Redis    │      │ Google Calendar│
                            │ (Persist)  │      │   (Two-way)    │
                            └────────────┘      └────────────────┘
```

### Key Design Principles

1. **Never Refresh the Page** - Pure SPA with no page reloads, all updates via WebSocket
2. **Single Source of Truth** - Backend holds canonical state, broadcasts to all clients
3. **Optimistic UI** - Actions dispatch immediately, state updates broadcast back
4. **Timezone Aware** - All dates/times handled in America/Chicago timezone
5. **Real-time Sync** - All connected clients see identical state within milliseconds

## State Management

### State Structure

The entire application state is a single JavaScript object managed server-side:

```javascript
state = {
  reservations: [
    {
      id: 'gcal-event-id',        // Google Calendar event ID or null
      lane: 3,                     // Lane number (1-8)
      party: 'Smith Birthday',     // Party name
      start: '14:00',              // Start time (HH:MM, 24-hour)
      end: '16:00',                // End time (HH:MM, 24-hour)
      date: '2024-03-15',          // Date (YYYY-MM-DD)
      contact: '555-1234',         // Contact info
      guests: 12,                  // Guest count
      type: 'reservation',         // 'reservation' | 'hourly' | 'per-game'
      hours: undefined,            // For hourly type
      games: undefined,            // For per-game type
      paid: false,                 // Payment status
      arrived: false,              // Arrival confirmation
      cancelled: false,            // Cancellation flag (soft delete)
      source: 'gcal'               // 'gcal' | 'local'
    }
  ],
  walkIns: [
    {
      lane: 1,                     // Lane number
      openedAt: 1234567890,        // Timestamp when opened
      bowlers: 4,                  // Number of bowlers
      type: 'hourly',              // 'hourly' | 'per-game'
      hours: 2,                    // Hours booked (hourly only)
      games: undefined,            // Games booked (per-game only)
      paid: false,                 // Payment status
      extended: false,             // Extension flag
      serviceCallMs: 0             // Accumulated service call time
    }
  ],
  maintenance: {                   // Lane maintenance status
    5: true                        // Lane 5 is in maintenance
  },
  groups: {                        // Lane groupings for parties
    'g1': { lanes: [3, 4, 5] }    // Group ID -> lane array
  },
  serviceCalls: {                  // Active service calls
    2: {
      start: 1234567890,           // Timestamp when called
      acked: false                 // Staff acknowledgment status
    }
  },
  excludedEvents: [                // No-show GCal event IDs
    'event-id-1'
  ],
  nextGroupId: 1                   // Auto-increment for groups
}
```

### State Flow

```
User Action (Frontend)
    ↓
dispatch('ACTION_TYPE', { payload })
    ↓
Socket.IO → Backend
    ↓
handlers[ACTION_TYPE](payload, socket)
    ↓
Modify state object
    ↓
persistState() → Redis
    ↓
io.emit('state', state) → All Clients
    ↓
React re-renders with new state
```

## Business Logic

### Walk-In Management

**Opening a Walk-In:**
1. User clicks "+ Open" on available lane
2. Select bowlers, type (hourly/per-game), and duration
3. Backend creates walk-in object with `openedAt` timestamp
4. Lane status changes to ACTIVE (red if unpaid, green if paid)

**Duration Calculation:**
```javascript
// Base duration
const baseMins = type === 'hourly'
  ? hours * 60
  : bowlers * games * 10 + 15; // 10min per game per bowler + 15min setup

// Add grace period
const totalMins = baseMins + 5;

// Add service call time if applicable
if (serviceCall) {
  totalMins += serviceCallDuration;
}

// Calculate estimated close time
const estClose = openedAt + (totalMins * 60 * 1000);
```

**Extension Logic:**
- Can extend active walk-ins (add hours or games)
- Sets `paid: false` on extension (requires new payment)
- Sets `extended: true` flag for tracking

### Reservation System

**Creation Flow:**

1. **Date Selection:**
   - Calendar shows available dates (week starts Sunday)
   - Past dates disabled
   - Shows density indicators for busy days

2. **Time Selection:**
   - Choose duration (2, 3, or 4 hours)
   - Select start time from available slots
   - Times filtered by business hours (9am-8pm typically)

3. **Lane Selection:**
   - Shows availability for each lane
   - **Smart Conflict Detection:**
     ```javascript
     // Lane is available if:
     - Not in maintenance
     - No overlapping reservations
     - Walk-in ends BEFORE reservation starts (if same day)
     ```

4. **Party Details:**
   - Party name (required)
   - Contact info
   - Guest count: 10, 20, 30, 40, or 50 (discrete buttons)

5. **Backend Validation:**
   ```javascript
   validateReservationInput(data):
     - Party name 2-50 chars
     - Valid date (not in past)
     - Valid time format (HH:MM)
     - Duration 0.5-8 hours
     - Lane 1-8

   isTimeSlotAvailable(lane, date, startTime, duration):
     - Check maintenance
     - Check walk-in end time (same day only)
     - Check reservation overlaps
   ```

6. **Google Calendar Sync:**
   ```javascript
   // Create event with timeout protection
   const event = await Promise.race([
     gcalClient.createEvent(reservation),
     timeout(30000)
   ]);

   // Event format:
   summary: "Lane 3 - Smith Birthday"
   description: "guests: 12\ntype: reservation\ncontact: 555-1234\npaid: false"
   timeZone: "America/Chicago"
   ```

7. **Local Fallback:**
   - If GCal fails, creates local reservation
   - Source field: 'gcal' vs 'local'
   - Both types function identically in UI

### Conflict Detection Logic

**Same-Day Walk-In Check:**
```javascript
if (selectedDate === today) {
  const walkIn = walkIns.find(w => w.lane === lane);
  if (walkIn) {
    const walkInEndTime = calculateEndTime(walkIn);
    if (requestedStartTime < walkInEndTime) {
      return { available: false, reason: 'Walk-in active' };
    }
  }
}
```

**Reservation Overlap Check:**
```javascript
for (const res of reservations) {
  if (res.lane !== lane || res.date !== selectedDate) continue;

  const resStart = timeToNum(res.start);
  const resEnd = timeToNum(res.end);

  // Check for any overlap
  if (requestedStart < resEnd && requestedEnd > resStart) {
    return { available: false, reason: 'Reserved' };
  }
}
```

### Timeline View Modes

**Four View Modes:**

1. **Hour View (Default):**
   - Dynamic 2-4 hour window around current time
   - Live "now" indicator (yellow line)
   - Auto-scrolls with time progression
   - Color coding: Green (paid), Red (unpaid), Pink (upcoming)

2. **Day View:**
   - Fixed business hours (9am-8pm)
   - Date navigation (prev/next/today)
   - Only shows selected date's reservations
   - Walk-ins only for today

3. **Week View:**
   - 7-day grid (Sunday-Saturday)
   - Shows reservation count per lane per day
   - Heat map coloring by density
   - Click cell to jump to Day view

4. **Month View:**
   - Calendar grid with leading/trailing days
   - Daily total across all lanes
   - Today highlighted in green
   - Click date to view Day timeline

**Rendering Logic:**
```javascript
const [timelineViewMode, setTimelineViewMode] = useState('hour');

{timelineViewMode === 'hour' && renderHourView()}
{timelineViewMode === 'day' && renderDayView()}
{timelineViewMode === 'week' && renderWeekView()}
{timelineViewMode === 'month' && renderMonthView()}
```

## Date and Time Handling

### Critical Timezone Issues

**Problem:** JavaScript's `new Date("2026-02-15")` parses as UTC midnight, which in America/Chicago (UTC-6) becomes the previous day.

**Solution:**
```javascript
// ❌ WRONG - UTC parsing
new Date("2026-02-15") // Feb 15 00:00 UTC = Feb 14 18:00 CST

// ✅ CORRECT - Local parsing
const [year, month, day] = "2026-02-15".split('-').map(Number);
const localDate = new Date(year, month - 1, day);

// ✅ Use formatDateDisplay from shared.js
formatDateDisplay("2026-02-15") // Handles timezone automatically
```

### Date Utilities (shared.js)

```javascript
// Get Sunday of the week containing date
getWeekStart(date)
  const day = date.getDay(); // 0=Sunday, 1=Monday, etc.
  const diff = -day; // Go back to Sunday
  return new Date(date.getTime() + diff * 86400000);

// Format date to YYYY-MM-DD (local timezone)
formatDateYYYYMMDD(date)
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;

// Check if date string is today (local comparison)
isToday(dateString)
  const today = formatDateYYYYMMDD(new Date());
  return dateString === today;

// Add/subtract days (handles month boundaries)
addDays(date, days)
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
```

### Time Conversion

```javascript
// Time string to decimal hours
timeToNum("14:30") → 14.5

// Current time as decimal
nowNum() → 15.25

// Format for display
fmt("14:00") → "2:00p"
fmt("09:00") → "9:00a"
```

### Upcoming Reservation Filtering

**CRITICAL:** Must filter by both date AND time:

```javascript
// ❌ WRONG - Only checks time
const upcoming = reservations.filter(r =>
  r.lane === lane && timeToNum(r.start) > nowNum()
);

// ✅ CORRECT - Checks date AND time
const todayStr = formatDateYYYYMMDD(new Date());
const isToday = r => (r.date || todayStr) === todayStr;
const upcoming = reservations.filter(r =>
  r.lane === lane && isToday(r) && timeToNum(r.start) > nowNum()
);
```

## Google Calendar Integration

### Read-Only Sync (API Key)

**Polling Loop:**
```javascript
setInterval(async () => {
  const events = await fetchEvents(timeMin, timeMax);
  const parsed = events.map(parseEvent);
  mergeIntoState(parsed);
}, 120000); // Every 2 minutes
```

**Event Parsing:**
```javascript
parseEvent(gcalEvent) {
  // Extract from title: "Lane 3 - Smith Birthday"
  const lane = parseInt(title.match(/Lane (\d+)/)[1]);
  const party = title.split(' - ')[1];

  // Parse description key-value pairs
  const guests = parseInt(get('guests')) || 4;
  const type = get('type') || 'reservation';
  const paid = get('paid') === 'true';

  return { lane, party, guests, type, paid, ... };
}
```

### Two-Way Sync (Service Account)

**Event Creation:**
```javascript
async createEvent(reservation) {
  const event = {
    summary: `Lane ${lane} - ${party}`,
    description: `guests: ${guests}\ntype: ${type}\ncontact: ${contact}\npaid: false`,
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: 'America/Chicago'
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: 'America/Chicago'
    }
  };

  // With timeout protection
  const response = await Promise.race([
    calendar.events.insert({ calendarId, resource: event }),
    timeout(30000)
  ]);

  return response.data.id;
}
```

**Multi-Lane Reservations:**
- Creates separate event per lane
- All events have same party details
- Each gets unique event ID
- Canceling one doesn't affect others

## Real-Time Synchronization

### WebSocket Events

**Client → Server:**
```javascript
socket.emit('action', {
  type: 'CREATE_RESERVATION',
  date: '2026-02-15',
  startTime: '14:00',
  duration: 2,
  lanes: [3, 4],
  party: 'Birthday Party',
  guests: 20,
  contact: '555-1234'
});
```

**Server → All Clients:**
```javascript
// After every action
io.emit('state', state);

// Errors to specific socket
socket.emit('error', {
  type: 'validation',
  message: 'Invalid input',
  errors: ['Party name required']
});

// Success confirmations
socket.emit('reservationCreated', {
  success: true,
  reservations: [...]
});
```

### State Updates

**No Refresh Required:**
```javascript
// Frontend receives state broadcast
socket.on('state', (newState) => {
  setServerState(newState); // React state update
  // Component automatically re-renders
});
```

**Optimistic UI:**
- Action dispatched immediately
- UI shows loading state
- Wait for state broadcast
- If error, show notification

## UI/UX Logic

### Responsive Design

**Breakpoints:**
```javascript
const compact = useCompact(); // true if max-width: 639px

// Conditional styling
style={{
  padding: compact ? 12 : 24,
  fontSize: compact ? '0.7rem' : '0.9rem',
  gridTemplateColumns: compact ? '1fr' : 'repeat(3, 1fr)'
}}
```

### Text Overflow Protection

**CRITICAL:** Prevent long text from pushing buttons off-screen:

```javascript
// Info component with ellipsis
<div style={{
  maxWidth: compact ? '150px' : '200px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}} title={fullText}>
  {fullText}
</div>

// Container constraints
<div style={{
  flex: '1 1 auto',
  minWidth: 0,
  maxWidth: compact ? '100%' : '65%'  // Don't squeeze buttons
}}>

// Buttons never shrink
<div style={{
  display: 'flex',
  flexShrink: 0,
  marginLeft: 'auto',  // Right-align on desktop
  justifyContent: 'flex-end'  // Right-align on compact
}}>
```

### Button Alignment

**Consistent Pattern:**
- All button sections right-aligned
- Calendar panel centered (exception)
- Responsive: `marginLeft: 'auto'` (desktop) or `justifyContent: 'flex-end'` (compact)

### Status Indicators

**Lane Status Logic:**
```javascript
let accent = C.blue, status = 'OPEN';

if (maintenance[lane]) {
  accent = C.maint;
  status = 'MAINTENANCE';
} else if (walkIn && walkIn.paid) {
  accent = C.green;
  status = 'ACTIVE';
} else if (walkIn && !walkIn.paid) {
  accent = C.red;
  status = 'UNPAID';
} else if (reservation && reservation.arrived) {
  accent = reservation.paid ? C.green : C.red;
  status = reservation.paid ? 'ACTIVE' : 'UNPAID';
}

// Override for service calls
if (serviceCall && !serviceCall.acked) {
  accent = C.amber;
  // Pulse animation applied
}
```

**Upcoming Notifications:**
- Pink badge below main status
- Shows next reservation details
- Only for today's reservations
- Does not change lane status to "RESERVED"

## Performance Optimizations

### Preventing Re-animations

**Problem:** Timeline blocks re-animate on every state update.

**Solution:** Remove CSS transitions from dynamic elements:
```javascript
// ❌ WRONG - Causes re-animation
<div style={{ transition: 'all 0.15s' }}>

// ✅ CORRECT - Static positioning
<div style={{ /* no transition */ }}>
```

### Efficient Re-renders

**Use useMemo for expensive calculations:**
```javascript
const weekDays = useMemo(() =>
  Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
  [weekStart]
);
```

**Avoid inline function definitions in renders:**
```javascript
// ❌ WRONG - New function every render
onClick={() => handleClick(item)}

// ✅ CORRECT - Stable reference
const handleItemClick = useCallback((item) => ..., []);
onClick={handleItemClick}
```

## Error Handling

### Validation Layers

1. **Frontend Validation:**
   - Immediate feedback
   - Prevent invalid submissions
   - UX-focused messages

2. **Backend Validation:**
   - Security boundary
   - Data integrity
   - Returns structured errors

3. **Google Calendar Errors:**
   - Timeout protection (30s)
   - Graceful degradation to local
   - User notification

### Error Display

```javascript
// Backend error
socket.emit('error', {
  type: 'validation',
  message: 'Validation failed',
  errors: ['Party name required', 'Invalid date']
});

// Frontend handling
socket.on('error', (error) => {
  setLastError(error);
  // Show notification modal
});
```

## Testing Scenarios

### Walk-In Flow
1. Open walk-in (hourly, 2 hours, 4 bowlers)
2. Verify estimated close time calculation
3. Create service call, verify time added
4. Extend walk-in, verify new close time
5. Mark paid, verify status change
6. Close walk-in, verify lane becomes available

### Reservation Flow
1. Select tomorrow's date
2. Choose 2-hour duration, 2pm start
3. Select lane with active walk-in (should be blocked)
4. Select time after walk-in close (should work)
5. Enter party details, submit
6. Verify appears in timeline
7. Check Google Calendar event created
8. Mark arrived, verify status change
9. Cancel reservation, verify soft delete

### Conflict Detection
1. Create reservation: Lane 3, 2pm-4pm
2. Try creating overlapping: Lane 3, 3pm-5pm (should fail)
3. Try non-overlapping: Lane 3, 4pm-6pm (should work)
4. Open walk-in on Lane 4
5. Try reservation before close time (should fail)
6. Try reservation after close time (should work)

### Timezone Edge Cases
1. Create reservation for today near midnight
2. Verify date displays correctly (not previous day)
3. Check upcoming filters only show today's reservations
4. Verify week view shows correct Sunday start

## Common Pitfalls

### ❌ Using UTC instead of Local Time
```javascript
// WRONG
const today = new Date().toISOString().split('T')[0];

// RIGHT
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
```

### ❌ Filtering Without Date Check
```javascript
// WRONG - Shows yesterday's reservations as upcoming
const upcoming = res.filter(r => timeToNum(r.start) > nowNum());

// RIGHT - Only today's future reservations
const upcoming = res.filter(r => isToday(r) && timeToNum(r.start) > nowNum());
```

### ❌ Blocking Walk-ins Without Time Check
```javascript
// WRONG - Blocks lane even after walk-in ends
if (walkIn) return { available: false };

// RIGHT - Only blocks if overlapping
if (walkIn && requestedStart < getWalkInEndTime(walkIn)) {
  return { available: false };
}
```

### ❌ Breaking SPA with Form Submissions
```javascript
// WRONG - Causes page refresh
<form onSubmit={handleSubmit}>

// RIGHT - Use buttons with onClick
<button onClick={handleSubmit}>
```

### ❌ Using External CSS
```javascript
// WRONG - Against project conventions
<div className="my-class">

// RIGHT - Inline styles with constants
<div style={{ color: C.blue, fontFamily: F.mono }}>
```

## Debugging Tips

### Check Backend Logs
```bash
docker-compose logs backend -f

# Look for:
- "Google Calendar write access enabled" (GCal configured)
- "CREATE_RESERVATION received data: ..." (Action received)
- "Validation errors: []" (Validation passed)
- "[GCal] Created Google Calendar event: xyz" (GCal success)
- "[GCal] Failed to create: ..." (GCal errors)
```

### Inspect State
```javascript
// In browser console
localStorage.debug = 'socket.io-client:*';

// Socket events will log to console
```

### Common Issues

1. **Reservations not appearing:**
   - Check date field on reservation objects
   - Verify `isToday()` filter logic
   - Confirm timezone parsing

2. **Lane availability wrong:**
   - Check walk-in end time calculation
   - Verify service call time included
   - Compare frontend vs backend logic

3. **Google Calendar not syncing:**
   - Check service account JSON configured
   - Verify calendar shared with service account
   - Check for timeout errors in logs

4. **Timeline re-animating:**
   - Remove CSS transitions from timeline blocks
   - Check for unnecessary re-renders

## Maintenance

### Adding a New Action

1. Define handler in `backend/server.js`:
```javascript
handlers.MY_ACTION = async function(data, socket) {
  // Validate input
  if (!data.param) {
    socket.emit('error', { message: 'Missing param' });
    return;
  }

  // Modify state
  state.myArray.push(data.param);

  // State broadcast happens automatically
};
```

2. Dispatch from frontend:
```javascript
const { dispatch } = useSocket();
dispatch('MY_ACTION', { param: 'value' });
```

### Adding a New View Mode

1. Add state:
```javascript
const [myViewMode, setMyViewMode] = useState(false);
```

2. Add toggle:
```javascript
<Btn onClick={() => setMyViewMode(true)}>My View</Btn>
```

3. Add rendering:
```javascript
{myViewMode ? <MyView /> : <DefaultView />}
```

### Updating Google Calendar Format

Modify `formatReservationToEvent()` in `backend/googleCalendar.js`:
```javascript
description: [
  `guests: ${guests}`,
  `type: ${type}`,
  `myNewField: ${value}`, // Add here
  contact ? `contact: ${contact}` : null,
  `paid: false`
].filter(Boolean).join('\n');
```

## Deployment Checklist

- [ ] Set `GCAL_SERVICE_ACCOUNT_JSON` environment variable
- [ ] Set `GCAL_CALENDAR_ID` environment variable
- [ ] Share calendar with service account email
- [ ] Configure Redis persistence (volume mount)
- [ ] Set timezone to America/Chicago in containers
- [ ] Configure CORS if backend on different domain
- [ ] Test WebSocket connection through proxy/firewall
- [ ] Verify mobile responsive layout
- [ ] Check all button sections right-aligned
- [ ] Confirm calendar panel centered
- [ ] Test walk-in conflict detection
- [ ] Verify timezone handling for midnight edge cases

---

**Last Updated:** 2026-02-15
**Architecture Version:** 2.0
