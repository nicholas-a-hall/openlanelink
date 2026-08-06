# Lunar Lanes — Lane Management Dashboard

Real-time lane management system for Lunar Lanes bowling alley. All connected displays share the same state via WebSocket.

## Architecture

```
ESP32/ESP8266 ←MQTT→ Mosquitto Broker ←MQTT→ Bridge ←WebSocket→ Backend ←→ Redis
Hardware Devices                                 ↕                ↑           ↑
                                                 ↓                ↓           ↓
Manager Dashboard ────────────WebSocket─────────┘         Google Calendar  State
Kiosk Displays (4) ────────────WebSocket─────────┘
```

- **Hardware Devices**: ESP32/ESP8266 microcontrollers, sensors, buttons, displays (optional).
- **MQTT Broker**: Mosquitto handles pub/sub messaging for IoT devices.
- **MQTT Bridge**: Translates between MQTT (hardware) and Socket.IO (backend).
- **Manager Dashboard**: React (Vite) served by nginx. Full control interface for staff.
- **Kiosk Displays**: Per-lane interfaces (4 instances covering 8 lanes) for customer service calls.
- **Backend**: Express + socket.io. Holds canonical state, persists to Redis, broadcasts changes.
- **Redis**: Persists state across pod restarts with separated keys (reservations, walk-ins, etc.).
- **Google Calendar**: Two-way sync for reservation management.

## Quick Start (Docker Compose)

### Basic Setup (No Hardware)

```bash
docker compose up --build
```

**Web Interfaces:**
- Manager Dashboard: http://localhost:8080
- Kiosk Displays: http://localhost:8081-8084 (lanes 1-2, 3-4, 5-6, 7-8)
- Backend API: http://localhost:3001/api/state

Open multiple browser tabs — they all sync in real time.

### With MQTT Hardware Integration

Enable MQTT broker and bridge for ESP32/ESP8266 devices:

```bash
# Option 1: Environment variable
COMPOSE_PROFILES=mqtt docker compose up --build

# Option 2: Create .env file
echo "COMPOSE_PROFILES=mqtt" > .env
docker compose up --build
```

**MQTT Endpoints:**
- MQTT Broker: mqtt://localhost:1883
- MQTT WebSocket: ws://localhost:9001
- Monitor traffic: `mosquitto_sub -h localhost -t lunarlanes/# -v`

See [HARDWARE_INTEGRATION.md](HARDWARE_INTEGRATION.md) for ESP32/ESP8266 examples.

## Quick Start (Local Dev)

```bash
# Terminal 1: Redis
docker run -p 6379:6379 redis:7-alpine

# Terminal 2: Backend
cd backend
npm install
npm run dev

# Terminal 3: Frontend
cd frontend
npm install
npm run dev
```

Dashboard at http://localhost:5173

## Environment Variables

### Backend

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server port |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `GCAL_API_KEY` | _(empty)_ | Google Calendar API key (read-only access) |
| `GCAL_SERVICE_ACCOUNT_JSON` | _(empty)_ | Service account JSON for write access (create/update/delete) |
| `GCAL_MODE` | `single` | `single` or `multi` (per-lane calendars) |
| `GCAL_CALENDAR_ID` | _(empty)_ | Calendar ID for single mode |
| `GCAL_CALENDAR_IDS` | _(empty)_ | Comma-separated calendar IDs for multi mode |
| `GCAL_SYNC_INTERVAL` | `120000` | GCal poll interval in ms |

### Frontend

| Variable | Default | Description |
|---|---|---|
| `VITE_BACKEND_URL` | `http://localhost:3001` | Backend WebSocket URL |

For K8s, you can also set `window.__LUNAR_BACKEND_URL__` at runtime via a ConfigMap-injected script tag, avoiding the need to rebuild the frontend image per environment.

## K8s Deployment Notes

You'll need:
- **Frontend Deployment + Service** (or Ingress) — nginx serving static files
- **Backend Deployment + Service** — single replica is fine for 8 lanes
- **Redis StatefulSet + Service** — with a PVC for persistence

The backend URL must be reachable from the browser (not just inside the cluster). Options:
1. Expose the backend Service via NodePort/LoadBalancer/Ingress
2. Use an Ingress with path-based routing: `/` → frontend, `/socket.io` → backend

## Google Calendar Setup

### Read-Only Sync (View Reservations)

1. Go to Google Cloud Console → APIs & Services → Enable "Google Calendar API"
2. Create an API key (restrict to Calendar API)
3. Make your calendar public, or share it with the API's service account
4. Event format for single-calendar mode:
   - **Title**: `Lane 3 - Johnson Birthday`
   - **Description**: `guests:8 type:reservation contact:555-1234 paid:false`
   - Valid types: `reservation` (created via UI), `hourly`, or `per-game` (for walk-ins)
5. Set `GCAL_API_KEY` and `GCAL_CALENDAR_ID` env vars on the backend and restart

### Two-Way Sync (Create Reservations from UI)

To enable creating, updating, and deleting reservations through the management UI:

1. **Create a Service Account**:
   - Go to Google Cloud Console → IAM & Admin → Service Accounts
   - Click "Create Service Account"
   - Name it (e.g., "lunar-lanes-manager")
   - Click "Create and Continue"
   - Skip the optional steps and click "Done"

2. **Download the JSON Key**:
   - Click on your new service account
   - Go to the "Keys" tab
   - Click "Add Key" → "Create new key"
   - Choose JSON format and download the file

3. **Share Calendar with Service Account**:
   - Open Google Calendar settings
   - Find your bowling calendar
   - Click "Share with specific people"
   - Add the service account email (found in the JSON file as `client_email`)
   - Give it "Make changes to events" permission

4. **Configure the Backend**:
   ```bash
   # Option A: Environment variable (entire JSON as string)
   export GCAL_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"...","private_key":"..."}'

   # Option B: In docker-compose.yml
   # Uncomment the GCAL_SERVICE_ACCOUNT_JSON line and set it:
   - GCAL_SERVICE_ACCOUNT_JSON=${GCAL_SERVICE_ACCOUNT_JSON}
   ```

5. **Restart the backend**:
   ```bash
   docker-compose down
   docker-compose up --build
   ```

Once configured, clicking "+ New Reservation" switches to the reservation creation view, allowing staff to create reservations with:
- Date and time selection
- Duration (30min - 4 hours)
- Lane assignment with availability checking
- Party details (name, contact, guest count)
- Billing type (per-game or hourly)

The system automatically prevents double-booking and validates all inputs before creating Google Calendar events.

## Features

### Walk-In Management
- Open/close walk-in sessions (hourly or per-game)
- Estimated close time for hourly sessions
- Mark paid/unpaid (affects entire group when grouped)
- Move sessions between lanes (moves entire group)
- Group lanes for large parties
- Extend sessions (add more games/hours)

### Reservation Management
- **Create reservations** directly from the UI with calendar picker
- **Multi-lane group reservations** - assign multiple lanes to a single party
- **Duration selection** - choose 2, 3, or 4 hour blocks
- **Guest count buttons** - quick selection for 10, 20, 30, 40, or 50 guests
- **Two-way Google Calendar sync** (read + write)
- **Smart conflict detection** - detailed error messages show which party/time is blocking
- **Change lane assignments** - move existing reservations to different lanes
- Automatic double-booking prevention with helpful error messages
- **Cancel reservations** - mark as cancelled while preserving history
- **Mark as no-show** - excludes from future syncs
- Delete reservations (removes from Google Calendar)
- Mark reservations as arrived
- Toggle paid/unpaid status (before or after arrival)
- **Timeline views** - Hour, Day, Week, and Month views
- Interactive timeline - click reservations to view details and take actions
- Reservation modal with all management options in one place

### Timeline Views
- **Hour View** - 2-4 hour window around current time with live "now" indicator
- **Day View** - Full business day (9 AM - 8 PM) with date navigation
- **Week View** - 7-day grid (Sunday-Saturday) showing reservation density per lane
- **Month View** - Calendar overview with daily reservation counts
- Click any reservation block to view details, mark paid, cancel, or delete
- Real-time updates without page refresh

### Lane Operations
- Maintenance mode (blocks lane from use)
- **Service call system** - request assistance from kiosks or manager
  - Acknowledgement workflow for staff
  - Tracks time spent on service calls
  - Visual pulsing indicators on unacknowledged calls
- Visual status indicators (open, active, unpaid, pending arrival)
- **Compact inline status display** - lane number and status tags flow on same row
- **Upcoming reservation notifications** - clear pink badges showing next reservation
- Real-time sync across all displays
- **Per-lane kiosk displays** - Dedicated interfaces at lanes 1-2, 3-4, 5-6, 7-8

### Technical Features
- **Single Page Application (SPA)** - Never refreshes, all updates via WebSocket
- **Delta-based state updates** - Only changed data transmitted for efficiency
- **Real-time synchronization** - Reservations appear immediately across all displays
- **Smart state merging** - Modal forms persist during socket updates
- Redis persistence across restarts with separated state keys
- Mobile-responsive design with text overflow protection
- Compact mode for smaller screens (max-width: 639px)
- Timezone support (America/Chicago)
- Smart date parsing - handles local vs UTC timezone correctly
- Service call tracking with elapsed time accumulation
- Extend session functionality for walk-ins (add hours/games, mark unpaid)

## Using the Reservation System

### Creating a Reservation

1. Click the **"+ New Reservation"** button in the header
2. **Select a date** from the calendar (past dates are disabled, week starts Sunday)
3. **Select duration**: Choose 2, 3, or 4 hours
4. **Choose a time slot** based on selected duration
5. **Pick available lanes** (click multiple lanes for group reservations)
   - Unavailable lanes show reason: maintenance, walk-in, or reserved
   - Lanes with walk-ins become available after their estimated close time
   - Selected lanes are highlighted with green glow
6. **Enter party details**:
   - Party name (required, 2-50 characters)
   - Contact information (phone or email)
   - **Guest count**: Click 10, 20, 30, 40, or 50 (defaults to 10)
7. Click **"Create Reservation"**

**Multi-Lane Reservations:**
- Click multiple lanes to create a group reservation
- All selected lanes must be available for the chosen time slot
- Creates separate but linked reservations for each lane

**Smart Conflict Detection:**
- Lanes with active walk-ins are available if your reservation starts after the walk-in's estimated close time
- Accounts for service call delays in walk-in duration
- No artificial buffers - uses exact estimated close time from lane card
- **Clear error messages** when conflicts occur:
  - Shows exactly which party is blocking (e.g., "Conflicts with 'Smith Birthday' (2:00pm - 4:00pm)")
  - Prominent "SCHEDULING CONFLICT" banner with red border
  - Dismiss button to clear error and try again
  - Form preserves all your selections

Note: Reservations are their own category, separate from walk-in billing types (per-game/hourly).

The reservation will:
- Appear immediately in the timeline and lane views
- Be created in Google Calendar automatically
- Prevent conflicting reservations on the same lane
- Show in all connected displays in real-time

### Managing Reservations

- **View upcoming**: Reservations show in the lane's upcoming section with pink "UPCOMING" badge
- **Mark arrived**: Click "✓ Arrived" when the party arrives (turns green)
- **Toggle paid**: Click "Mark Paid" before or after arrival to track payment status
- **Interactive timeline**: Click any reservation block in timeline views to see details and actions
- **Change lane assignment**:
  - Click "Change Lane" button in reservation modal
  - System shows only available lanes for that time slot
  - Select new lane and confirm
  - Updates Google Calendar automatically
  - Perfect for accommodating customer requests or optimizing lane usage
- **Cancel**: Click "Cancel" button to mark reservation as cancelled (keeps record visible)
  - Cancelled reservations show with dimmed colors and "CANCELLED" tag
  - Prevents accidental deletion while maintaining history
- **Delete**: Click "Delete" button to permanently remove (removes from UI and Google Calendar)
- **Mark no-show**: Removes reservation and excludes it from future syncs

**Conflict Prevention with Clear Feedback:**
- When scheduling conflicts occur, a prominent error displays:
  - Exact conflicting party name and time slot
  - Instructions to try a different time or lane
  - Dismiss button to clear error and adjust selection
- All validation happens before attempting to create Google Calendar event

### Using Timeline Views

Switch between timeline modes using the buttons at the top of the timeline section:

- **Hour View** (default):
  - Shows 2-4 hour window around current time
  - Live yellow "now" indicator line
  - Color-coded: Green (paid), Red (unpaid), Pink (upcoming reservations)
  - Auto-scrolls with current time

- **Day View**:
  - Full business day from 9 AM to 8 PM
  - Navigate between days with Prev/Next/Today buttons
  - Shows all reservations for selected date
  - Walk-ins only visible for today

- **Week View**:
  - 7-day grid starting Sunday
  - Shows reservation count per lane per day
  - Color intensity indicates density
  - Click any cell to jump to detailed Day view

- **Month View**:
  - Calendar month overview
  - Shows total reservations per day (all lanes combined)
  - Today highlighted in green
  - Click any date to view detailed Day timeline

### Kiosk Displays

Per-lane kiosk interfaces for customer service requests:

**Local Access (same machine):**
- **http://localhost:8081** - Lanes 1-2
- **http://localhost:8082** - Lanes 3-4
- **http://localhost:8083** - Lanes 5-6
- **http://localhost:8084** - Lanes 7-8

**Network Access (from tablets/displays on LAN):**

Replace `localhost` with your server's IP address or hostname:
- **http://192.168.1.100:8081** - Lanes 1-2 (example IP)
- **http://bowlingserver.local:8081** - Lanes 1-2 (example hostname)

The kiosks automatically connect to the backend using the same hostname you access them from.

**Example Setup:**
```bash
# Find your server's IP
ip addr show | grep "inet "
# or on macOS:
ipconfig getifaddr en0

# Access kiosks from tablets at:
# http://<your-server-ip>:8081
# http://<your-server-ip>:8082
# etc.
```

**Features:**
- Shows current status for assigned lanes
- **Service call button** - Request staff assistance
- Visual confirmation when service call is acknowledged by staff
- Displays upcoming reservations
- Real-time updates via WebSocket
- Designed for touchscreen displays at each lane pair

**Service Call Workflow:**
1. Customer presses "Service" button on kiosk
2. Manager dashboard shows pulsing amber alert on affected lane
3. Staff clicks "Acknowledge" (changes to blue, stops pulsing)
4. Staff addresses issue and clicks "Repaired" to clear
5. Service time is tracked and added to walk-in duration estimates

### Conflict Prevention

The system automatically prevents:
- Creating reservations in the past
- Double-booking the same lane
- Reserving lanes in maintenance mode
- Overlapping with active walk-ins or other reservations

**Smart Walk-In Handling:**
- Same-day walk-ins only block reservation times that overlap with their estimated close time
- If your reservation starts after a walk-in's estimated end time (including service calls), the lane is available
- Future dates are never blocked by today's walk-ins

All validation happens in real-time as you select options.

## Troubleshooting

### Reservation Creation Fails

**Error: "Failed to create reservation in Google Calendar"**
- Check that `GCAL_SERVICE_ACCOUNT_JSON` is set correctly
- Verify the service account JSON is valid (test with `echo $GCAL_SERVICE_ACCOUNT_JSON | jq`)
- Ensure the calendar is shared with the service account email
- Check service account has "Make changes to events" permission

**Error: "SCHEDULING CONFLICT" with party details**
- The error message shows exactly which party is blocking the time slot
- Click "Dismiss" and try:
  - A different time slot
  - A different lane
  - Adjusting the duration
- The conflicting reservation details include party name and exact times
- No need to refresh - the form preserves your selections

**Button doesn't appear**
- Verify you're on the manager UI (port 8080), not the kiosk UI
- Check browser console for JavaScript errors
- Ensure frontend dependencies are installed (`npm install` in frontend/)

### Calendar Sync Issues

**Reservations not appearing**
- Check `GCAL_API_KEY` and `GCAL_CALENDAR_ID` are set
- Verify calendar ID is correct (found in Google Calendar settings)
- Check backend logs: `docker-compose logs backend`
- Sync interval is 2 minutes by default, wait or trigger manual sync: `curl -X POST http://localhost:3001/api/sync`

**Created reservations don't show in Google Calendar**
- Service account must be configured for write access
- Calendar must be shared with service account email
- Check backend logs for API errors
- Verify Google Calendar API is enabled in Google Cloud Console

### Redis Connection Issues

**State not persisting across restarts**
- Verify Redis container is running: `docker-compose ps`
- Check Redis logs: `docker-compose logs redis`
- Ensure Redis volume is mounted correctly
- Test connection: `redis-cli -h localhost ping`

### Network Access Issues

**Kiosks can't connect when accessed from other devices**
- The kiosks automatically use the same hostname you access them from
- If you access via `http://192.168.1.100:8081`, it connects to `http://192.168.1.100:3001`
- Ensure port **3001** (backend) is accessible on your network
- Check firewall rules allow incoming connections on ports 3001, 8081-8084
- Test backend accessibility: `curl http://<server-ip>:3001/api/state`

**WebSocket connection failed**
- Verify backend is running: `docker-compose ps backend`
- Check backend logs: `docker-compose logs backend`
- Ensure no reverse proxy is blocking WebSocket upgrades
- Test Socket.IO endpoint: `curl http://<server-ip>:3001/socket.io/`

**Finding your server IP:**
```bash
# Linux
ip addr show | grep "inet "

# macOS
ipconfig getifaddr en0

# Or use hostname
hostname -I
```

## Project Structure

```
lunar-lanes/
├── backend/
│   ├── server.js              # Main Express + Socket.IO server
│   ├── googleCalendar.js      # Google Calendar API client
│   ├── package.json           # Backend dependencies
│   └── Dockerfile
│
├── mqtt-bridge/
│   ├── index.js               # MQTT ↔ Socket.IO bridge service
│   ├── package.json           # Bridge dependencies
│   ├── Dockerfile
│   └── README.md              # Bridge documentation
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # Main manager UI component
│   │   ├── shared.js          # WebSocket hook, constants, utilities
│   │   └── components/
│   │       ├── CalendarPicker.jsx    # Date selection component
│   │       ├── TimeSelector.jsx      # Time slot picker
│   │       ├── LaneSelector.jsx      # Lane availability selector
│   │       └── ReservationForm.jsx   # Complete reservation form
│   ├── package.json           # Frontend dependencies
│   ├── vite.config.js
│   └── Dockerfile
│
├── kiosk/
│   ├── src/
│   │   └── App.jsx            # Kiosk UI (per-lane displays)
│   └── package.json
│
├── mosquitto.conf             # MQTT broker configuration
├── docker-compose.yml         # Full stack orchestration
├── README.md                  # Main documentation
└── HARDWARE_INTEGRATION.md    # ESP32/ESP8266 integration guide
```

### Key Files

- **`backend/server.js`**: Core state management, Socket.IO handlers, Google Calendar sync
- **`backend/googleCalendar.js`**: Service account auth, event CRUD operations
- **`frontend/src/App.jsx`**: Manager dashboard with lanes/timeline views
- **`frontend/src/components/ReservationForm.jsx`**: Complete reservation creation flow
- **`frontend/src/shared.js`**: WebSocket connection, color/font constants

### State Management

All state is managed server-side in `backend/server.js`:
- **`reservations`**: Array of reservations (from GCal + locally created), organized by date
- **`walkIns`**: Array of active walk-in sessions
- **`maintenance`**: Object mapping lane numbers to boolean
- **`groups`**: Object mapping group IDs to lane arrays
- **`serviceCalls`**: Object mapping lanes to call timestamps and acknowledgement status
- **`excludedEvents`**: Array of Google Calendar event IDs to skip (no-shows)

**Redis Architecture:**
- Separated keys for each state type (e.g., `lunar-lanes:reservations:2026-02-15`)
- Date-based reservation keys for efficient querying
- Delta updates broadcast via WebSocket (only changed data)
- Full state snapshot on initial connection

## Dependencies

### Backend
- `express` - Web server
- `socket.io` - Real-time communication
- `redis` - State persistence
- `googleapis` - Google Calendar API client (write access)

### MQTT Bridge
- `mqtt` - MQTT client library
- `socket.io-client` - WebSocket client to backend

### Frontend
- `react` + `vite` - UI framework and build tool
- `socket.io-client` - WebSocket client
- `react-calendar` - Date picker component
- `lucide-react` - Icon library

### Infrastructure
- `eclipse-mosquitto` - MQTT broker (Docker image)
- `redis` - State persistence (Docker image)

## Hardware Integration

Lunar Lanes supports **optional** integration with ESP32/ESP8266 microcontrollers and PLCs for enhanced automation and customer experience. See **[HARDWARE_INTEGRATION.md](HARDWARE_INTEGRATION.md)** for complete guide.

**Supported Features:**
- Physical service call buttons at each lane
- RGB LED status indicators
- LCD displays showing next reservation
- Ball return sensors
- Automated access control
- Environmental monitoring
- PLC integration via MQTT

**Enable MQTT (Required for Hardware):**
```bash
# Start with MQTT enabled
COMPOSE_PROFILES=mqtt docker-compose up --build

# Or create .env file with:
# COMPOSE_PROFILES=mqtt

# Deploy ESP32 with service call button (5 minutes)
# See HARDWARE_INTEGRATION.md for code examples
```

**Note:** MQTT is disabled by default to keep the stack simple. Enable it only when you're ready to integrate hardware devices.

---

## License

Proprietary - Lunar Lanes Bowling Alley
