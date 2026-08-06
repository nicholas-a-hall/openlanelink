# Mechanics Module Testing Guide (Docker Compose)

This guide provides step-by-step instructions for testing the Lunar Lanes Mechanics Module using Docker Compose.

## Prerequisites

- Docker and Docker Compose installed
- No services running on ports: 6379 (Redis), 27017 (MongoDB), 3001 (Backend), 8080-8084 (Frontend/Kiosks)

## Initial Setup

### 1. Build and Start Services

```bash
# From project root
docker-compose up --build

# Wait for all services to start:
# ✓ redis
# ✓ mongodb
# ✓ backend
# ✓ frontend
# ✓ kiosk-lanes-1-2
# ✓ kiosk-lanes-3-4
# ✓ kiosk-lanes-5-6
# ✓ kiosk-lanes-7-8
```

### 2. Verify Services

```bash
# Check all services are running
docker-compose ps

# Expected output:
# NAME                  STATUS    PORTS
# lunar-lanes-redis     Up        0.0.0.0:6379->6379/tcp
# lunar-lanes-mongodb   Up        0.0.0.0:27017->27017/tcp
# lunar-lanes-backend   Up        0.0.0.0:3001->3001/tcp
# lunar-lanes-frontend  Up        0.0.0.0:8080->80/tcp
# (... kiosks on 8081-8084)
```

### 3. Seed Component Inventory

```bash
# Seed default components to MongoDB
docker-compose exec backend node src/services/seedComponents.js

# Expected output:
# [Seed] Connected to MongoDB
# [Seed] Successfully seeded component inventory to MongoDB:
#   - 10 component types
#   - Categories: pins, mechanical, electronics, supplies
#
# Components by category:
#   PINS:
#     - White Bowling Pins
#   MECHANICAL:
#     - Drive Belt (Small)
#     - Drive Belt (Large)
#     - Pinsetter Motor
#   ELECTRONICS:
#     - Pinsetter Sensor
#     - Ball Return Sensor
#   SUPPLIES:
#     - Lane Conditioning Oil (Bottle)
#     - Ball Return Cleaner
#     - Lane Cleaning Pads
#     - Mechanical Lubricant
#
# [Seed] Done!
```

### 4. Verify MongoDB Connection

```bash
# Check MongoDB logs for connection
docker-compose logs mongodb | grep -i "connection accepted"

# Check backend logs for MongoDB connection
docker-compose logs backend | grep -i "MongoManager"

# Expected: "[MongoManager] Connected to MongoDB"
```

## Test Suite

### Test 1: Access Mechanics UI

**Objective:** Verify mechanics UI loads correctly with CRT effects and cyberpunk styling

**Steps:**
1. Open browser to `http://localhost:8080/mechanic`
2. Verify page loads with:
   - Dark background gradient (#0a0a12 to #12121f)
   - CRT scanlines overlay
   - Vignette effect at edges
   - Orbitron font headers
   - Neon-colored buttons (cyan, green, magenta, orange, yellow)
3. Verify 5 sub-view tabs appear:
   - DASHBOARD (default active)
   - SERVICE LOG
   - COMPONENTS
   - MAINTENANCE
   - LANE CONTEXT
4. Click each tab, verify smooth transitions

**Expected Result:** ✅ Mechanics UI loads with cyberpunk styling, all tabs functional

---

### Test 2: Component Inventory Display

**Objective:** Verify seeded components display correctly with categories

**Steps:**
1. Navigate to `/mechanic`
2. Click "COMPONENTS" tab
3. Verify 4 category sections appear:
   - **PINS** (1 component)
   - **MECHANICAL** (3 components)
   - **ELECTRONICS** (2 components)
   - **SUPPLIES** (4 components)
4. For each component, verify display shows:
   - Component name
   - Current quantity / Min stock
   - Visual indicator (✅ if ok, ⚠️ if low stock)
   - [−] and [+] buttons
5. Check "White Bowling Pins" shows: `100 / 80` with ✅

**Expected Result:** ✅ All 10 seeded components display correctly grouped by category

---

### Test 3: Service Call Creation and Resolution with Logging

**Objective:** Test complete service call workflow with issue logging and component tracking

**Steps:**
1. **Create Service Call from Kiosk:**
   - Open `http://localhost:8081` (kiosk lanes 1-2)
   - Click "SERVICE" button on Lane 1 card
   - Verify red pulsing border appears
   - Verify "SERVICE REQUESTED" banner shows

2. **View in Mechanics Dashboard:**
   - Open `http://localhost:8080/mechanic` in new tab
   - Verify Dashboard shows active service call for Lane 1
   - Check elapsed time counter increments
   - Note "RESOLVE" button appears

3. **Resolve with Issue Logging:**
   - Click "RESOLVE" button on Lane 1 service call
   - Verify QuickIssueLogger modal appears
   - Fill in form:
     - **Category:** Click "Ball Return" button
     - **Severity:** Click "Medium" button
     - **Description:** Type "Ball stuck in return mechanism"
     - **Resolved By:** Type "Test Mechanic"
   - Click "SUBMIT"
   - Verify modal closes
   - Verify service call removed from dashboard

4. **Verify Service History:**
   - Click "SERVICE LOG" tab
   - Verify new entry appears at top:
     - Lane: 1
     - Category: Ball Return
     - Severity: Medium
     - Description: "Ball stuck in return mechanism"
     - Resolved By: Test Mechanic
     - Duration: (elapsed time)

**Expected Result:** ✅ Service call logged with complete issue details

---

### Test 4: Component Usage Tracking

**Objective:** Verify component inventory decrements when parts used in service call

**Steps:**
1. **Note Initial Inventory:**
   - Navigate to `/mechanic` → COMPONENTS tab
   - Find "Drive Belt (Small)"
   - Note current quantity (should be 5)

2. **Create and Resolve Service Call with Component Usage:**
   - Create service call on Lane 2 (via kiosk at `http://localhost:8081`)
   - In `/mechanic`, click "RESOLVE" on Lane 2
   - Fill issue details:
     - Category: Pinsetter
     - Severity: High
     - Description: "Belt failure, replaced drive belt"
     - Resolved By: "Test Mechanic"
   - **Add Component:**
     - Find "Drive Belt (Small)" in component picker
     - Click [+] button to set quantity to 1
     - Verify quantity shows "1" next to component
   - Click "SUBMIT"

3. **Verify Inventory Decremented:**
   - Click "COMPONENTS" tab
   - Find "Drive Belt (Small)"
   - Verify quantity decreased from 5 to 4
   - Verify display shows: `4 / 3` with ✅

4. **Verify Usage History:**
   - In SERVICE LOG tab, find the Lane 2 entry
   - Verify "Components Used" section shows:
     - "Drive Belt (Small) × 1"

**Expected Result:** ✅ Component inventory decrements, usage logged in service history

---

### Test 5: Low Stock Alerts

**Objective:** Verify low-stock warnings when inventory falls below minStock threshold

**Steps:**
1. Navigate to `/mechanic` → COMPONENTS tab
2. Find "Drive Belt (Small)" (current: 4, minStock: 3)
3. Click [−] button twice to reduce quantity to 2
4. Verify visual indicator changes from ✅ to ⚠️ (yellow warning)
5. Verify display shows: `2 / 3` with ⚠️
6. Navigate to DASHBOARD tab
7. Verify "LOW STOCK ALERTS" section appears
8. Verify "Drive Belt (Small)" listed with warning:
   - "Drive Belt (Small): 2 / 3 (LOW)"
   - Yellow/orange warning color

**Expected Result:** ✅ Low-stock alert appears in dashboard and component list

---

### Test 6: Add New Component

**Objective:** Test adding custom component to inventory

**Steps:**
1. Navigate to `/mechanic` → COMPONENTS tab
2. Scroll to bottom, click "ADD COMPONENT" button
3. Verify form appears with fields:
   - Component ID
   - Name
   - Initial Quantity
   - Min Stock
   - Category (dropdown)
   - Unit
4. Fill in form:
   - ID: `pin-cushion-red`
   - Name: `Red Pin Cushion`
   - Quantity: `20`
   - Min Stock: `10`
   - Category: `mechanical`
   - Unit: `pieces`
5. Click "ADD" button
6. Verify form closes
7. Verify new component appears in MECHANICAL category:
   - "Red Pin Cushion"
   - `20 / 10` with ✅

**Expected Result:** ✅ New component added and displays correctly

---

### Test 7: Maintenance Task Creation

**Objective:** Test creating manual maintenance task

**Steps:**
1. Navigate to `/mechanic` → MAINTENANCE tab
2. Click "NEW TASK" button
3. Verify task creation form appears
4. Fill in form:
   - **Type:** Select "Preventative"
   - **Lane:** Select "Lane 3" (or "All Lanes")
   - **Title:** "Weekly lane conditioning - Lane 3"
   - **Description:** "Apply conditioning oil to lane surface"
   - **Priority:** Select "High"
   - **Assigned To:** "Test Mechanic"
   - **Scheduled For:** Select today's date, time: 18:00
   - **Estimated Duration:** 30 minutes
   - **Recurring:** Select "Weekly"
5. Click "CREATE TASK" button
6. Verify form closes
7. Verify new task appears in "PENDING" filter section:
   - Title: "Weekly lane conditioning - Lane 3"
   - Lane: 3
   - Priority: High (red color)
   - Status: Pending
   - Scheduled: Today 18:00
   - Assigned: Test Mechanic

**Expected Result:** ✅ Manual task created and appears in pending tasks list

---

### Test 8: Brunswick A2 PM Module

**Objective:** Test PM auto-generation with Brunswick A2 templates

**Steps:**
1. Navigate to `/mechanic` → MAINTENANCE tab
2. Scroll to "PM MODULE SETTINGS" panel (collapsible section)
3. Verify current settings display:
   - PM Module: Disabled (default)
   - Equipment Type: Generic
4. **Enable PM Module:**
   - Toggle "Enable PM Module" switch to ON
   - Select "Brunswick A2" from equipment type dropdown
   - Click "SAVE PM CONFIG" button
   - Verify success message appears
5. **Generate PM Tasks:**
   - Click "GENERATE TODAY'S PM TASKS" button
   - Verify confirmation message: "Generating PM tasks for 8 lanes..."
   - Wait 2-3 seconds for generation
   - Verify success message: "Generated X PM tasks"
6. **Verify PM Tasks Created:**
   - In task list, verify multiple new tasks appear with:
     - Badge: "AUTO-PM" (distinct color/style)
     - Title: "Daily Pinsetter Inspection - Lane X" (for lanes 1-8)
     - Priority: High
     - Type: Preventative
     - Source: pm-auto
   - Click on one PM task to view details
   - Verify checklist items from Brunswick A2 template appear:
     - "Visual inspection of pin deck"
     - "Verify sweep operation"
     - "Check spotting cups alignment"
     - (etc.)

**Expected Result:** ✅ PM module generates Brunswick A2 daily tasks for all lanes

---

### Test 9: Complete Maintenance Task

**Objective:** Test marking task complete with notes and component usage

**Steps:**
1. Navigate to `/mechanic` → MAINTENANCE tab
2. Find pending task "Weekly lane conditioning - Lane 3" (from Test 7)
3. Click "START" button
4. Verify task status changes to "IN PROGRESS"
5. Verify task moves to "IN PROGRESS" filter section
6. Click "COMPLETE" button
7. Verify completion form appears:
   - **Completed By:** (pre-filled from assignedTo)
   - **Notes:** Textarea
   - **Components Used:** Component picker
8. Fill in form:
   - Notes: "Lane conditioning completed successfully"
   - Add component: "Lane Conditioning Oil (Bottle)" × 1
9. Click "MARK COMPLETE" button
10. Verify task moves to "COMPLETED" filter section
11. Verify task shows:
    - Status: Completed
    - Completed At: (timestamp)
    - Notes: "Lane conditioning completed successfully"
    - Components Used: "Lane Conditioning Oil (Bottle) × 1"
12. Navigate to COMPONENTS tab
13. Verify "Lane Conditioning Oil (Bottle)" quantity decremented by 1

**Expected Result:** ✅ Task completed, notes saved, component inventory updated

---

### Test 10: Lane Context View

**Objective:** Verify per-lane schedule display and maintenance window detection

**Steps:**
1. **Create Reservation for Lane 5:**
   - Open `http://localhost:8080` (manager dashboard)
   - Create a reservation for Lane 5:
     - Today's date
     - Time: 14:00 - 16:00
     - Party: "Test Reservation"

2. **View Lane Context:**
   - Navigate to `/mechanic` → LANE CONTEXT tab
   - Select "Lane 5" from lane selector dropdown
   - Verify today's schedule displays:
     - Current time indicator (vertical line)
     - Reservation block: 14:00-16:00 "Test Reservation"
     - Color-coded: blue for future, gray for past (if time > 16:00)
   - Verify 7-day preview shows reservation on today's row

3. **Check Open Windows:**
   - Verify "OPEN WINDOWS" section displays
   - Verify open times listed (e.g., "6:00-14:00", "16:00-23:00")
   - Verify "No conflicts" indicator for open times

4. **Schedule Maintenance in Open Window:**
   - Click "SCHEDULE MAINTENANCE" button in open window section
   - Verify task creation form opens with:
     - Lane: Pre-filled "Lane 5"
     - Scheduled For: Pre-filled to open window time
   - Create task for 17:00 (after reservation)
   - Verify task appears in Lane 5's schedule

**Expected Result:** ✅ Lane context shows reservations, detects open windows, allows scheduling

---

### Test 11: Real-Time State Synchronization

**Objective:** Verify WebSocket broadcasts update all clients in real-time

**Steps:**
1. **Open Two Browser Windows:**
   - Window A: `http://localhost:8080/mechanic` (Dashboard tab)
   - Window B: `http://localhost:8081` (Kiosk lanes 1-2)

2. **Create Service Call from Kiosk:**
   - In Window B, click "SERVICE" on Lane 1
   - **Immediately check Window A**
   - Verify service call appears in Dashboard within 1 second
   - Verify elapsed time starts counting

3. **Resolve from Mechanics:**
   - In Window A, resolve Lane 1 service call with logging
   - **Immediately check Window B**
   - Verify Lane 1 service button returns to normal within 1 second
   - Verify "SERVICE REQUESTED" banner removed

4. **Update Component Inventory:**
   - Open Window C: `http://localhost:8080/mechanic` (Components tab)
   - In Window C, decrease "White Bowling Pins" quantity by 10
   - **Check Window A (Dashboard tab)**
   - If pins now below minStock, verify low-stock alert appears

5. **Create Maintenance Task:**
   - In Window A, create new maintenance task
   - Switch to Window C
   - Navigate to MAINTENANCE tab
   - Verify new task appears without refresh

**Expected Result:** ✅ All state changes broadcast in real-time to all connected clients

---

### Test 12: Service Call with Walk-In Time Accumulation

**Objective:** Verify service call duration adds to walk-in service time

**Steps:**
1. **Open Walk-In on Lane 4:**
   - Open `http://localhost:8080` (manager dashboard)
   - Find Lane 4
   - Click "OPEN WALK-IN" button
   - Set: 4 bowlers, Hourly, 2 hours
   - Note walk-in start time

2. **Create Service Call:**
   - From kiosk (`http://localhost:8082` lanes 3-4)
   - Click "SERVICE" on Lane 4
   - Wait 30 seconds (let timer run)

3. **Resolve Service Call:**
   - Navigate to `/mechanic`
   - Resolve Lane 4 service call with issue logging
   - Note resolution time (should be ~30 seconds duration)

4. **Check Walk-In Service Time:**
   - Return to manager dashboard (`http://localhost:8080`)
   - Find Lane 4 walk-in card
   - Verify "Service Call Time" section shows:
     - ~30 seconds accumulated service time
     - Service call duration displayed

5. **Close Walk-In:**
   - Click "CLOSE LANE" on Lane 4
   - Verify total service time included in final duration

**Expected Result:** ✅ Service call duration accumulates on walk-in, displays in manager UI

---

### Test 13: Mobile Responsive Design

**Objective:** Verify mechanics UI works on mobile devices/narrow screens

**Steps:**
1. Open `http://localhost:8080/mechanic` in browser
2. Open browser DevTools (F12)
3. Toggle device toolbar (Ctrl+Shift+M or Cmd+Shift+M)
4. Select mobile device (e.g., iPhone 12 Pro - 390×844)
5. **Test Dashboard Tab:**
   - Verify service call cards stack vertically
   - Verify stat boxes stack in single column
   - Verify buttons have adequate touch targets (min 40px height)
   - Test scrolling - should be smooth, no horizontal overflow
6. **Test Components Tab:**
   - Verify category sections stack vertically
   - Verify component cards stack in single column
   - Verify [+] and [−] buttons are tappable (min 40px)
7. **Test Maintenance Tab:**
   - Verify task cards stack vertically
   - Verify "NEW TASK" button remains accessible
   - Open task creation form, verify form fields stack vertically
   - Test scrolling within modal
8. **Test QuickIssueLogger Modal:**
   - Create service call, open resolution modal
   - Verify modal fits within viewport
   - Verify buttons don't overlap
   - Verify component picker scrolls correctly
   - Test closing modal (X button in corner)
9. **Test Sub-View Tabs:**
   - Verify tab navigation works on mobile
   - Check tabs either stack or scroll horizontally
   - Verify active tab highlighted correctly

**Expected Result:** ✅ Entire mechanics UI functional on mobile, no layout issues

---

### Test 14: Service History Filtering

**Objective:** Test filtering and pagination in service log view

**Steps:**
1. **Create Multiple Service Calls:**
   - Create and resolve 5+ service calls on different lanes:
     - Lane 1: Ball Return, Low severity
     - Lane 2: Pinsetter, High severity
     - Lane 3: Ball Return, Medium severity
     - Lane 4: Pinsetter, Low severity
     - Lane 5: Ball Return, High severity

2. **Test Date Range Filter:**
   - Navigate to `/mechanic` → SERVICE LOG tab
   - Verify "Date Range" dropdown shows: Today / Week / Month / Custom
   - Select "Today"
   - Verify all 5 entries appear
   - Change to "Week" - verify same entries (assuming all created today)

3. **Test Lane Filter:**
   - Click "Lane" dropdown
   - Select "Lane 1"
   - Verify only Lane 1 entry appears
   - Select "All Lanes" to reset

4. **Test Category Filter:**
   - Click "Category" dropdown
   - Select "Ball Return"
   - Verify only 3 entries appear (Lanes 1, 3, 5)
   - Select "Pinsetter"
   - Verify only 2 entries appear (Lanes 2, 4)
   - Select "All Categories" to reset

5. **Test Combined Filters:**
   - Set Lane: "Lane 2"
   - Set Category: "Pinsetter"
   - Verify only Lane 2 Pinsetter entry appears

6. **Test Search (if implemented):**
   - Reset all filters
   - Type "Belt" in search box
   - Verify only entries with "belt" in description appear

**Expected Result:** ✅ All filters work correctly, can be combined, results accurate

---

### Test 15: PM Module Auto-Generation on Restart

**Objective:** Verify PM tasks auto-generate on server startup

**Steps:**
1. **Enable PM Module:**
   - Navigate to `/mechanic` → MAINTENANCE
   - Enable PM Module with Brunswick A2 equipment
   - Save configuration

2. **Delete Existing PM Tasks:**
   - Delete all AUTO-PM tasks manually (if any exist)
   - Verify no AUTO-PM tasks remain

3. **Restart Backend Service:**
   ```bash
   docker-compose restart backend
   ```

4. **Wait for Backend to Start:**
   - Check logs: `docker-compose logs -f backend`
   - Wait for: "[MongoManager] Connected to MongoDB"
   - Wait for: "[StateManager] Connected to Redis"

5. **Verify PM Tasks Auto-Generated:**
   - Refresh `/mechanic` → MAINTENANCE tab
   - Verify AUTO-PM tasks appear for today
   - Should see daily tasks for all 8 lanes
   - Verify tasks have:
     - Source: pm-auto
     - Badge: AUTO-PM
     - Template: Brunswick A2 Daily

6. **Test No Duplicate Generation:**
   - Restart backend again: `docker-compose restart backend`
   - Wait for startup
   - Refresh mechanics UI
   - Verify PM tasks NOT duplicated
   - Should still see same PM tasks (not double)

**Expected Result:** ✅ PM tasks auto-generate once on startup, no duplicates

---

## Cleanup and Reset

### Reset All Data

```bash
# Stop all services
docker-compose down

# Remove volumes (deletes all data)
docker-compose down -v

# Rebuild and restart
docker-compose up --build

# Re-seed components
docker-compose exec backend node src/services/seedComponents.js
```

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f backend
docker-compose logs -f mongodb
docker-compose logs -f redis

# Last 100 lines
docker-compose logs --tail=100 backend
```

### MongoDB Direct Access

```bash
# Connect to MongoDB shell
docker-compose exec mongodb mongosh

# In mongosh:
use lunar-lanes

# View collections
show collections

# Query service history
db.service_history.find().pretty()

# Query components
db.components.find().pretty()

# Query maintenance tasks
db.maintenance_tasks.find().pretty()

# Query PM config
db.pm_config.find().pretty()

# Count documents
db.service_history.countDocuments()
```

### Redis Direct Access

```bash
# Connect to Redis CLI
docker-compose exec redis redis-cli

# In redis-cli:
# View all keys
KEYS lunar-lanes:*

# Get walk-ins
GET lunar-lanes:walk-ins

# Get maintenance flags
GET lunar-lanes:maintenance

# Get service calls
GET lunar-lanes:service-calls

# Clear all Redis data (DESTRUCTIVE!)
FLUSHALL
```

## Troubleshooting

### Backend Won't Start

**Symptom:** Backend service exits immediately

**Check logs:**
```bash
docker-compose logs backend
```

**Common issues:**
- MongoDB not ready: Wait 10-15 seconds, restart backend
- Port 3001 in use: Kill process or change port in docker-compose.yml
- Environment variable errors: Check MONGODB_URL, REDIS_URL in docker-compose.yml

**Fix:**
```bash
# Restart backend only
docker-compose restart backend

# Or rebuild
docker-compose up --build backend
```

---

### MongoDB Connection Failed

**Symptom:** Backend logs show "MongoManager unavailable"

**Check MongoDB:**
```bash
docker-compose ps mongodb
docker-compose logs mongodb
```

**Fix:**
```bash
# Restart MongoDB
docker-compose restart mongodb

# Wait 10 seconds, then restart backend
sleep 10
docker-compose restart backend
```

---

### Components Not Seeding

**Symptom:** Seed script shows "Components already seeded"

**Force re-seed:**
```bash
docker-compose exec backend node src/services/seedComponents.js --force
```

**Verify in MongoDB:**
```bash
docker-compose exec mongodb mongosh lunar-lanes --eval "db.components.find().pretty()"
```

---

### Mechanics UI Won't Load

**Symptom:** `/mechanic` shows blank page or errors

**Check browser console:**
- F12 → Console tab
- Look for JavaScript errors

**Common issues:**
- WebSocket connection failed: Check backend running on port 3001
- 404 for `/mechanic`: Rebuild frontend

**Fix:**
```bash
# Rebuild frontend
docker-compose up --build frontend

# Check backend WebSocket
docker-compose logs backend | grep -i socket
```

---

### PM Tasks Not Auto-Generating

**Symptom:** PM module enabled but tasks not created on restart

**Check PM config:**
```bash
docker-compose exec mongodb mongosh lunar-lanes --eval "db.pm_config.findOne()"
```

**Expected:**
```javascript
{
  _id: 'config',
  enabled: true,
  equipmentType: 'brunswick-a2',
  autoGenerate: true
}
```

**Fix:**
- Re-save PM config in mechanics UI
- Check backend logs for PM generation errors
- Verify pmScheduler.js loaded correctly

---

### Real-Time Updates Not Working

**Symptom:** Changes in one browser window don't appear in another

**Check WebSocket connections:**
```bash
# Backend logs should show connections
docker-compose logs backend | grep -i "socket.io"
```

**Browser console:**
- F12 → Console
- Look for WebSocket connection errors
- Should see: "connected to backend"

**Fix:**
- Refresh browser (Ctrl+F5 / Cmd+Shift+R)
- Check VITE_BACKEND_URL in frontend build
- Restart backend: `docker-compose restart backend`

---

## Performance Benchmarks

Expected performance metrics:

- **Service Call Resolution:** < 500ms (create history entry, update inventory)
- **Component Inventory Update:** < 200ms (increment/decrement quantity)
- **Maintenance Task Creation:** < 300ms (insert to MongoDB)
- **PM Task Generation (8 lanes):** < 2 seconds (creates 8+ tasks)
- **Service History Query:** < 500ms (50 results with filters)
- **Real-Time Broadcast:** < 100ms (WebSocket emit to all clients)

If any operation takes significantly longer, check:
- MongoDB indexes are created: `docker-compose logs backend | grep "Indexes created"`
- No network latency: Test on localhost
- Adequate resources: Docker has enough CPU/memory allocated

---

## Success Criteria

Phase 5 is complete when all tests pass:

- [x] Test 1: Mechanics UI loads with cyberpunk styling
- [x] Test 2: Component inventory displays correctly
- [x] Test 3: Service call logging workflow functional
- [x] Test 4: Component usage tracking works
- [x] Test 5: Low-stock alerts appear
- [x] Test 6: Add new component functional
- [x] Test 7: Manual maintenance task creation
- [x] Test 8: Brunswick A2 PM module generates tasks
- [x] Test 9: Complete task with component usage
- [x] Test 10: Lane context view shows schedules
- [x] Test 11: Real-time synchronization works
- [x] Test 12: Walk-in service time accumulation
- [x] Test 13: Mobile responsive design
- [x] Test 14: Service history filtering
- [x] Test 15: PM auto-generation on restart

**All tests passing = Phase 5 complete ✅**

---

**Last Updated:** 2026-02-15
**Tested With:** Docker Compose v2.x, MongoDB 7, Redis 7
