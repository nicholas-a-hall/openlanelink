const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const GoogleCalendarClient = require('./googleCalendar');
const StateManager = require('./src/services/StateManager');
const MongoManager = require('./src/services/MongoManager');
const { LANES } = require('./src/config/lanes');

// ── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGODB_URL = process.env.MONGODB_URL || 'mongodb://localhost:27017';
const GCAL_API_KEY = process.env.GCAL_API_KEY || '';
const GCAL_MODE = process.env.GCAL_MODE || 'single';
const GCAL_CALENDAR_ID = process.env.GCAL_CALENDAR_ID || '';
const GCAL_CALENDAR_IDS = (process.env.GCAL_CALENDAR_IDS || '').split(',').map(s => s.trim());
const GCAL_SYNC_INTERVAL = parseInt(process.env.GCAL_SYNC_INTERVAL || '120000');
const GCAL_SERVICE_ACCOUNT_JSON = process.env.GCAL_SERVICE_ACCOUNT_JSON || '';

// Initialize Google Calendar client
let gcalClient = null;
if (GCAL_SERVICE_ACCOUNT_JSON) {
  try {
    gcalClient = new GoogleCalendarClient(GCAL_SERVICE_ACCOUNT_JSON, GCAL_CALENDAR_ID);
    console.log('Google Calendar write access enabled');
  } catch (error) {
    console.warn('Failed to initialize Google Calendar client:', error.message);
  }
}

// Initialize MongoManager and StateManager
const mongoManager = new MongoManager(MONGODB_URL);
const stateManager = new StateManager(REDIS_URL, mongoManager);

// ── Express & Socket.IO setup ───────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    redis: stateManager.connected,
    gcal: !!gcalClient,
    timestamp: Date.now()
  });
});

// Trigger manual sync endpoint
app.post('/api/sync', async (req, res) => {
  try {
    await syncGoogleCalendar();
    res.json({ success: true, message: 'Sync triggered' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Config endpoint - serves configurable values to frontend
app.get('/api/config', (req, res) => {
  const raw = process.env.SERVICE_CATEGORIES || 'BALL RETURN,PINSETTER,SCORING,MECHANICAL,ELECTRICAL,OTHER';
  const categories = raw.split(',').map(s => s.trim()).filter(Boolean);
  res.json({ serviceCategories: categories });
});

// Service history endpoint
app.get('/api/service-history', async (req, res) => {
  try {
    const options = {
      startTime: req.query.startTime ? parseInt(req.query.startTime) : undefined,
      endTime: req.query.endTime ? parseInt(req.query.endTime) : undefined,
      lane: req.query.lane ? parseInt(req.query.lane) : undefined,
      category: req.query.category,
      limit: req.query.limit ? parseInt(req.query.limit) : 50,
      offset: req.query.offset ? parseInt(req.query.offset) : 0
    };

    const history = await stateManager.getServiceHistory(options);
    const count = await stateManager.getServiceHistoryCount(options);

    res.json({
      history,
      count,
      options
    });
  } catch (err) {
    console.error('[API] Error fetching service history:', err);
    res.status(500).json({ error: err.message });
  }
});

// Clear service history
app.delete('/api/service-history', async (req, res) => {
  try {
    if (!stateManager.mongoManager || !stateManager.mongoManager.db) {
      return res.status(503).json({ error: 'MongoDB not connected' });
    }
    const result = await stateManager.mongoManager.db.collection('service_history').deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    console.error('[API] Error clearing service history:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── State helpers ───────────────────────────────────────

function timeToNum(t) {
  const [h, m] = t.split(':').map(Number);
  return h + m / 60;
}

function nowNum() {
  const n = new Date();
  return n.getHours() + n.getMinutes() / 60;
}

async function getCurrentRes(lane) {
  const nn = nowNum();
  const today = new Date().toISOString().split('T')[0];
  const reservations = await stateManager.getReservationsForDate(today);
  return reservations.find(r => r.lane === lane && nn >= timeToNum(r.start) && nn < timeToNum(r.end));
}

async function getWalkIn(lane) {
  return await stateManager.getWalkIn(lane);
}

async function soonRes(lane) {
  const nn = nowNum();
  const today = new Date().toISOString().split('T')[0];
  const reservations = await stateManager.getReservationsForDate(today);
  return reservations.find(r => r.lane === lane && timeToNum(r.start) > nn && timeToNum(r.start) - nn <= 0.25);
}

async function isLaneOpen(lane) {
  const inMaint = await stateManager.isInMaintenance(lane);
  const walkIn = await getWalkIn(lane);
  const curRes = await getCurrentRes(lane);
  const soon = await soonRes(lane);
  return !inMaint && !walkIn && !curRes && !soon;
}

async function getGroupForLane(lane) {
  return await stateManager.getGroupForLane(lane);
}

async function getGroupLanes(lane) {
  const g = await getGroupForLane(lane);
  return g ? [...g.lanes] : [lane];
}

// ── Validation helpers ──────────────────────────────────

function walkMins(w) {
  const baseMins = w.type === 'hourly' ? (w.hours || 1) * 60 : ((w.bowlers || 1) * (w.games || 1) * 10 + 15);
  return baseMins + 5;
}

function serviceCallMins(walkIn) {
  const serviceCalls = {};
  let ms = walkIn.serviceCallMs || 0;
  const serviceCall = serviceCalls[walkIn.lane];
  if (serviceCall) {
    ms += Date.now() - serviceCall.start;
  }
  return ms / 60000;
}

function getWalkInEndTime(walkIn, serviceCalls) {
  const openedAt = new Date(walkIn.openedAt);
  const durationMins = walkMins(walkIn);
  const serviceCallMinutes = serviceCallMins(walkIn);
  const totalMins = durationMins + serviceCallMinutes;
  const endTime = new Date(openedAt.getTime() + totalMins * 60000);
  return endTime.getHours() + endTime.getMinutes() / 60;
}

async function isTimeSlotAvailable(lane, date, startTime, duration) {
  const requestedStart = timeToNum(startTime);
  const requestedEnd = requestedStart + duration;

  // Check maintenance
  if (await stateManager.isInMaintenance(lane)) {
    return { available: false, reason: 'Lane in maintenance' };
  }

  // Check walk-ins (same day only)
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  if (date === today) {
    const walkIn = await getWalkIn(lane);
    if (walkIn) {
      const serviceCalls = await stateManager.getServiceCalls();
      const walkInEnd = getWalkInEndTime(walkIn, serviceCalls);
      if (requestedStart < walkInEnd) {
        return { available: false, reason: 'Lane currently has a walk-in' };
      }
    }
  }

  // Check existing reservations on same date
  const reservations = await stateManager.getReservationsForDate(date);
  for (const r of reservations) {
    if (r.lane !== lane || r.cancelled) continue;
    const existingStart = timeToNum(r.start);
    const existingEnd = timeToNum(r.end);

    // Check for overlap
    if (
      (requestedStart >= existingStart && requestedStart < existingEnd) ||
      (requestedEnd > existingStart && requestedEnd <= existingEnd) ||
      (requestedStart <= existingStart && requestedEnd >= existingEnd)
    ) {
      const formatTime = (t) => {
        const [h, m] = t.split(':');
        const hr = parseInt(h);
        return `${hr > 12 ? hr - 12 : hr || 12}:${m}${hr >= 12 ? 'pm' : 'am'}`;
      };
      return {
        available: false,
        reason: `Conflicts with "${r.party}" (${formatTime(r.start)} - ${formatTime(r.end)})`
      };
    }
  }

  return { available: true };
}

// ── Broadcast helper (delta updates) ────────────────────

function broadcastUpdate(type, data) {
  console.log(`[Broadcast] ${type}:`, JSON.stringify(data).substring(0, 200));
  io.emit('stateUpdate', {
    type,
    data,
    timestamp: Date.now()
  });
}

function broadcastFullState() {
  stateManager.getFullState().then(state => {
    io.emit('state', state);
  });
}

// ── Socket.IO handlers ──────────────────────────────────

const handlers = {};

// Walk-in handlers
handlers.OPEN_WALKIN = async function({ lane, bowlers, walkType, games, hours }, socket) {
  const walkIn = {
    lane,
    bowlers: bowlers || 1,
    type: walkType,
    games: walkType === 'per-game' ? (games || 1) : undefined,
    hours: walkType === 'hourly' ? (hours || 1) : undefined,
    openedAt: Date.now(),
    paid: false,
    serviceCallMs: 0
  };

  await stateManager.addWalkIn(walkIn);
  broadcastUpdate('WALK_IN_OPENED', { lane, walkIn });
};

handlers.CLOSE_WALKIN = async function({ lane }) {
  const group = await getGroupForLane(lane);
  const lanes = group ? group.lanes : [lane];

  for (const l of lanes) {
    const w = await getWalkIn(l);
    if (w) {
      await stateManager.removeWalkIn(l);
      const serviceCalls = await stateManager.getServiceCalls();
      if (serviceCalls[l]) {
        await stateManager.removeServiceCall(l);
        broadcastUpdate('SERVICE_CALL_RESOLVED', { lane: l });
      }
      broadcastUpdate('WALK_IN_CLOSED', { lane: l, walkIn: w });
    }
  }

  if (group) {
    await stateManager.removeGroup(group.gid);
    broadcastUpdate('GROUP_REMOVED', { groupId: group.gid, lanes: group.lanes });
  }
};

handlers.TOGGLE_WALK_PAID = async function({ lane }) {
  const walkIn = await getWalkIn(lane);
  if (!walkIn) return;

  const group = await getGroupForLane(lane);
  const lanes = group ? group.lanes : [lane];
  const newPaid = !walkIn.paid;

  for (const l of lanes) {
    const w = await getWalkIn(l);
    if (w) {
      w.paid = newPaid;
      await stateManager.updateWalkIn(l, { paid: newPaid });
      broadcastUpdate('WALK_IN_UPDATED', { lane: l, walkIn: w });
    }
  }
};

handlers.UPDATE_WALKIN = async function({ lane, updates }) {
  const walkIn = await getWalkIn(lane);
  if (walkIn) {
    await stateManager.updateWalkIn(lane, updates);
    const updatedWalkIn = await getWalkIn(lane);
    broadcastUpdate('WALK_IN_UPDATED', { lane, walkIn: updatedWalkIn });
  }
};

handlers.EXTEND_SESSION = async function({ lane }) {
  const walkIn = await getWalkIn(lane);
  if (!walkIn) return;

  // Get all lanes in group (if grouped)
  const group = await getGroupForLane(lane);
  const lanes = group ? group.lanes : [lane];

  // Extend all walk-ins in the group
  for (const laneNum of lanes) {
    const w = await getWalkIn(laneNum);
    if (w) {
      const updates = {
        paid: false,
        extended: true,
        lastExtendedAt: Date.now()
      };

      if (w.type === 'hourly') {
        updates.hours = (w.hours || 1) + 1;
      } else {
        updates.games = (w.games || 1) + 1;
      }

      await stateManager.updateWalkIn(laneNum, updates);
      const updatedWalkIn = await getWalkIn(laneNum);
      broadcastUpdate('WALK_IN_UPDATED', { lane: laneNum, walkIn: updatedWalkIn });
    }
  }
};

// Maintenance handlers
handlers.TOGGLE_MAINTENANCE = async function({ lane }) {
  const enabled = await stateManager.toggleMaintenance(lane);

  // Close any walk-in on this lane
  const walkIn = await getWalkIn(lane);
  if (walkIn && enabled) {
    await stateManager.removeWalkIn(lane);
  }

  broadcastUpdate('MAINTENANCE_TOGGLED', { lane, enabled });
};

// Service call handlers
handlers.SERVICE_CALL = async function({ lane }) {
  const serviceCalls = await stateManager.getServiceCalls();
  if (!serviceCalls[lane]) {
    await stateManager.addServiceCall(lane, {
      start: Date.now(),
      acked: false,
      origin: 'kiosk'
    });
    broadcastUpdate('SERVICE_CALL_CREATED', { lane });
  }
};

handlers.MANAGER_SERVICE_CALL = async function({ lane }) {
  const serviceCalls = await stateManager.getServiceCalls();
  if (!serviceCalls[lane]) {
    await stateManager.addServiceCall(lane, {
      start: Date.now(),
      acked: false,
      origin: 'manager'
    });
    broadcastUpdate('SERVICE_CALL_CREATED', { lane, origin: 'manager' });
  }
};

handlers.ACKNOWLEDGE_SERVICE_CALL = async function({ lane }) {
  await stateManager.updateServiceCall(lane, { acked: true });
  broadcastUpdate('SERVICE_CALL_ACKED', { lane });
};

handlers.RESOLVE_SERVICE_CALL = async function({ lane, issue, componentsUsed, resolvedBy }) {
  const serviceCalls = await stateManager.getServiceCalls();
  const serviceCall = serviceCalls[lane];
  if (serviceCall) {
    const endTime = Date.now();
    const duration = endTime - serviceCall.start;

    // Accumulate service time on walk-in (existing behavior)
    const walkIn = await getWalkIn(lane);
    if (walkIn) {
      walkIn.serviceCallMs = (walkIn.serviceCallMs || 0) + duration;
      await stateManager.updateWalkIn(lane, { serviceCallMs: walkIn.serviceCallMs });
    }

    // Create service history entry (new behavior)
    if (issue) {
      const historyEntry = {
        lane,
        startTime: serviceCall.start,
        endTime,
        duration,
        acked: serviceCall.acked || false,
        origin: serviceCall.origin || 'unknown',
        issue: {
          category: issue.category || 'other',
          severity: issue.severity || 'medium',
          description: issue.description || '',
          resolvedBy: resolvedBy || 'Unknown'
        },
        componentsUsed: componentsUsed || []
      };

      await stateManager.addServiceHistory(historyEntry);

      // Update component inventory and log usage
      if (componentsUsed && componentsUsed.length > 0) {
        for (const { component, quantity } of componentsUsed) {
          const comp = await stateManager.findComponentBySlug(component);
          if (comp) {
            await stateManager.updateComponentQuantity(comp._id.toString(), -quantity);
            await stateManager.logComponentUsage(comp._id.toString(), component, quantity, {
              lane,
              serviceCallId: historyEntry.id,
              category: issue.category,
              resolvedBy: resolvedBy || 'Unknown'
            });
          }
        }
      }
    }

    await stateManager.removeServiceCall(lane);
    broadcastUpdate('SERVICE_CALL_RESOLVED', { lane });

    // Broadcast mechanics update
    broadcastUpdate('MECHANICS_UPDATE', {
      type: 'service-resolved',
      lane,
      issue
    });
  }
};

handlers.TOGGLE_SERVICE_CALL = async function({ lane, origin }) {
  const serviceCalls = await stateManager.getServiceCalls();
  if (serviceCalls[lane]) {
    // Turning off - accumulate elapsed time onto the walk-in
    const serviceCall = serviceCalls[lane];
    if (serviceCall.start) {
      const walkIn = await getWalkIn(lane);
      if (walkIn) {
        const elapsed = Date.now() - serviceCall.start;
        walkIn.serviceCallMs = (walkIn.serviceCallMs || 0) + elapsed;
        await stateManager.updateWalkIn(lane, { serviceCallMs: walkIn.serviceCallMs });
      }
    }
    await stateManager.removeServiceCall(lane);
    broadcastUpdate('SERVICE_CALL_RESOLVED', { lane });
  } else {
    // Turning on - create service call
    await stateManager.addServiceCall(lane, {
      start: Date.now(),
      acked: false,
      origin: origin || 'manager'
    });
    broadcastUpdate('SERVICE_CALL_CREATED', { lane, origin: origin || 'manager' });
  }
};

// Reservation handlers
handlers.CREATE_RESERVATION = async function(data, socket) {
  console.log('[CREATE_RESERVATION] Received data:', data);

  const errors = [];
  const { date, startTime, duration, lanes, party, contact, guests } = data;

  // Validation
  if (!date) errors.push('Date is required');
  if (!startTime) errors.push('Start time is required');
  if (!duration) errors.push('Duration is required');
  if (!lanes || lanes.length === 0) errors.push('At least one lane is required');
  if (!party || party.length < 2) errors.push('Party name is required');
  if (!contact) errors.push('Contact information is required');

  console.log('[CREATE_RESERVATION] Validation errors:', errors);

  if (errors.length > 0) {
    socket.emit('error', { type: 'validation', errors });
    return;
  }

  // Check availability for all lanes
  for (const lane of lanes) {
    const available = await isTimeSlotAvailable(lane, date, startTime, duration);
    if (!available.available) {
      socket.emit('error', {
        type: 'availability',
        message: `Lane ${lane}: ${available.reason}`
      });
      return;
    }
  }

  // Calculate end time
  const [h, m] = startTime.split(':').map(Number);
  const endHour = Math.floor(h + duration);
  const endMin = Math.round(((h + duration) % 1) * 60);
  const endTime = `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`;

  const createdReservations = [];

  // Create reservation for each lane
  for (const lane of lanes) {
    const reservation = {
      id: null,
      lane,
      party,
      start: startTime,
      end: endTime,
      date,
      guests: guests || 10,
      contact,
      type: 'reservation',
      paid: false,
      arrived: false,
      cancelled: false,
      source: gcalClient ? 'ui' : 'manual'
    };

    try {
      // Create Google Calendar event if client is available
      if (gcalClient) {
        console.log(`[CREATE_RESERVATION] Creating Google Calendar event for lane ${lane}`);
        const result = await gcalClient.createEvent(reservation);
        if (result.success && result.eventId) {
          reservation.id = result.eventId;
          reservation.source = 'gcal';
          console.log(`[CREATE_RESERVATION] Created Google Calendar event: ${result.eventId}`);
        } else {
          console.warn(`[CREATE_RESERVATION] Failed to create Google Calendar event: ${result.error}`);
        }
      }

      // Add to state
      await stateManager.addReservation(reservation);
      createdReservations.push(reservation);

    } catch (err) {
      console.error(`[CREATE_RESERVATION] Failed to create reservation for lane ${lane}:`, err);
      socket.emit('error', {
        type: 'creation',
        message: `Failed to create reservation for lane ${lane}: ${err.message}`
      });
      return;
    }
  }

  console.log(`[CREATE_RESERVATION] Successfully created ${createdReservations.length} reservations`);
  broadcastUpdate('RESERVATIONS_CREATED', { reservations: createdReservations });

  socket.emit('reservationCreated', {
    success: true,
    reservations: createdReservations
  });
};

handlers.DELETE_RESERVATION = async function({ lane, start, date }, socket) {
  // Default to today if no date provided
  const today = new Date().toISOString().split('T')[0];
  const targetDate = date || today;

  const reservations = await stateManager.getReservationsForDate(targetDate);
  const reservation = reservations.find(r => r.lane === lane && r.start === start);

  if (reservation) {
    // Delete from Google Calendar
    if (gcalClient && reservation.id) {
      try {
        await gcalClient.deleteEvent(reservation.id);
        console.log(`[DELETE_RESERVATION] Deleted Google Calendar event ${reservation.id}`);
      } catch (err) {
        console.warn(`[DELETE_RESERVATION] Failed to delete Google Calendar event: ${err.message}`);
      }
    }

    await stateManager.removeReservation(lane, targetDate, start);
    broadcastUpdate('RESERVATION_DELETED', { lane, start, date: targetDate });
  } else {
    console.warn(`[DELETE_RESERVATION] Reservation not found: lane ${lane}, start ${start}, date ${targetDate}`);
  }
};

handlers.CANCEL_RESERVATION = async function({ lane, start, date }) {
  // Default to today if no date provided
  const today = new Date().toISOString().split('T')[0];
  const targetDate = date || today;

  const reservations = await stateManager.getReservationsForDate(targetDate);
  const reservation = reservations.find(r => r.lane === lane && r.start === start);

  if (reservation) {
    // Delete from Google Calendar when cancelled
    if (gcalClient && reservation.id) {
      try {
        await gcalClient.deleteEvent(reservation.id);
        console.log(`[CANCEL_RESERVATION] Deleted Google Calendar event ${reservation.id}`);
      } catch (err) {
        console.warn(`[CANCEL_RESERVATION] Failed to delete Google Calendar event: ${err.message}`);
      }
    }

    // Mark as cancelled in local state
    await stateManager.updateReservation(lane, targetDate, start, { cancelled: true });
    broadcastUpdate('RESERVATION_CANCELLED', { lane, start, date: targetDate });
  }
};

handlers.MARK_ARRIVED = async function({ lane, start, date }) {
  // Default to today if no date provided
  const today = new Date().toISOString().split('T')[0];
  const targetDate = date || today;

  const reservations = await stateManager.getReservationsForDate(targetDate);
  const reservation = reservations.find(r => r.lane === lane && r.start === start);

  if (reservation) {
    reservation.arrived = !reservation.arrived;
    await stateManager.updateReservation(lane, targetDate, start, { arrived: reservation.arrived });

    // Update Google Calendar if this is a synced event
    if (gcalClient && reservation.id && reservation.source === 'gcal') {
      try {
        await gcalClient.updateEvent(reservation.id, reservation);
        console.log(`[MARK_ARRIVED] Updated Google Calendar event ${reservation.id}`);
      } catch (err) {
        console.warn(`[MARK_ARRIVED] Failed to update Google Calendar: ${err.message}`);
      }
    }

    broadcastUpdate('RESERVATION_UPDATED', { lane, start, date: targetDate, arrived: reservation.arrived });
  } else {
    console.warn(`[MARK_ARRIVED] Reservation not found: lane ${lane}, start ${start}, date ${targetDate}`);
  }
};

handlers.TOGGLE_RES_PAID = async function({ lane, start, date }) {
  // Default to today if no date provided
  const today = new Date().toISOString().split('T')[0];
  const targetDate = date || today;

  const reservations = await stateManager.getReservationsForDate(targetDate);
  const reservation = reservations.find(r => r.lane === lane && r.start === start);

  if (reservation) {
    reservation.paid = !reservation.paid;
    await stateManager.updateReservation(lane, targetDate, start, { paid: reservation.paid });

    // Update Google Calendar if this is a synced event
    if (gcalClient && reservation.id && reservation.source === 'gcal') {
      try {
        await gcalClient.updateEvent(reservation.id, reservation);
        console.log(`[TOGGLE_RES_PAID] Updated Google Calendar event ${reservation.id}`);
      } catch (err) {
        console.warn(`[TOGGLE_RES_PAID] Failed to update Google Calendar: ${err.message}`);
      }
    }

    broadcastUpdate('RESERVATION_UPDATED', { lane, start, date: targetDate, paid: reservation.paid });
  } else {
    console.warn(`[TOGGLE_RES_PAID] Reservation not found: lane ${lane}, start ${start}, date ${targetDate}`);
  }
};

// Group handlers
handlers.GROUP_LANES = async function({ lanes }) {
  const nextGroupId = await stateManager.getNextGroupId();
  const groupId = `g${nextGroupId}`;
  await stateManager.addGroup(groupId, lanes);
  broadcastUpdate('GROUP_CREATED', { groupId, lanes });
};

handlers.UNGROUP_LANES = async function({ lane }) {
  const group = await getGroupForLane(lane);
  if (group) {
    await stateManager.removeGroup(group.gid);
    broadcastUpdate('GROUP_REMOVED', { groupId: group.gid, lanes: group.lanes });
  }
};

// Additional handlers (aliases and legacy support)
handlers.ACK_SERVICE_CALL = handlers.ACKNOWLEDGE_SERVICE_CALL;
handlers.SET_GROUP = handlers.GROUP_LANES;

handlers.MARK_NO_SHOW = async function({ lane, start, date }) {
  const today = new Date().toISOString().split('T')[0];
  const targetDate = date || today;
  const reservations = await stateManager.getReservationsForDate(targetDate);
  const reservation = reservations.find(r => r.lane === lane && r.start === start);
  if (reservation) {
    await stateManager.removeReservation(lane, targetDate, start);
    broadcastUpdate('RESERVATION_DELETED', { lane, start, date: targetDate });

    // Also add to excluded events if from Google Calendar
    if (reservation.id && reservation.source === 'gcal') {
      await stateManager.addExcludedEvent(reservation.id);
      broadcastUpdate('EVENT_EXCLUDED', { eventId: reservation.id });
    }
  }
};

handlers.CHANGE_RESERVATION_LANE = async function({ oldLane, newLane, start, date }, socket) {
  const today = new Date().toISOString().split('T')[0];
  const targetDate = date || today;

  // Get the reservation
  const reservations = await stateManager.getReservationsForDate(targetDate);
  const reservation = reservations.find(r => r.lane === oldLane && r.start === start);

  if (!reservation) {
    console.warn(`[CHANGE_RESERVATION_LANE] Reservation not found: lane ${oldLane}, start ${start}`);
    if (socket) {
      socket.emit('error', { type: 'not_found', message: 'Reservation not found' });
    }
    return;
  }

  // Calculate duration for availability check
  const [startH, startM] = reservation.start.split(':').map(Number);
  const [endH, endM] = reservation.end.split(':').map(Number);
  const duration = (endH + endM / 60) - (startH + startM / 60);

  // Check if new lane is available
  const available = await isTimeSlotAvailable(newLane, targetDate, reservation.start, duration);
  if (!available.available) {
    console.warn(`[CHANGE_RESERVATION_LANE] New lane not available: ${available.reason}`);
    if (socket) {
      socket.emit('error', { type: 'availability', message: available.reason });
    }
    return;
  }

  // Remove from old lane
  await stateManager.removeReservation(oldLane, targetDate, start);
  broadcastUpdate('RESERVATION_DELETED', { lane: oldLane, start, date: targetDate });

  // Update lane and add to new lane
  reservation.lane = newLane;
  await stateManager.addReservation(reservation);

  // Update Google Calendar event if it exists
  if (gcalClient && reservation.id && reservation.source === 'gcal') {
    try {
      await gcalClient.updateEvent(reservation.id, reservation);
      console.log(`[CHANGE_RESERVATION_LANE] Updated Google Calendar event ${reservation.id}`);
    } catch (err) {
      console.warn(`[CHANGE_RESERVATION_LANE] Failed to update Google Calendar: ${err.message}`);
    }
  }

  broadcastUpdate('RESERVATIONS_CREATED', { reservations: [reservation] });
  console.log(`[CHANGE_RESERVATION_LANE] Moved reservation from lane ${oldLane} to lane ${newLane}`);
};

handlers.MOVE_LANE = async function({ fromLane, toLane }) {
  const walkIn = await getWalkIn(fromLane);
  if (!walkIn) return;

  const group = await getGroupForLane(fromLane);

  if (group) {
    // Move entire group: sorted old lanes map to consecutive new lanes starting at toLane
    const sortedOld = [...group.lanes].sort((a, b) => a - b);
    const offset = toLane - sortedOld[0];
    const newLanes = sortedOld.map(l => l + offset);

    // Verify all target lanes are available (skip lanes already in the group)
    for (const nl of newLanes) {
      if (nl < 1 || nl > 8) return;
      if (group.lanes.includes(nl)) continue;
      const occupied = await getWalkIn(nl);
      const inMaint = await stateManager.isInMaintenance(nl);
      if (occupied || inMaint) return;
    }

    // Move all walk-ins: remove all first, then add all (avoids conflicts)
    const walkIns = [];
    for (const ol of sortedOld) {
      const w = await getWalkIn(ol);
      if (w) walkIns.push(w);
      await stateManager.removeWalkIn(ol);
    }

    for (let i = 0; i < sortedOld.length; i++) {
      const w = walkIns[i];
      if (w) {
        w.lane = newLanes[i];
        await stateManager.addWalkIn(w);
      }
    }

    // Update group
    await stateManager.removeGroup(group.gid);
    await stateManager.addGroup(group.gid, newLanes);
    broadcastUpdate('GROUP_REMOVED', { groupId: group.gid, lanes: group.lanes });
    broadcastUpdate('GROUP_CREATED', { groupId: group.gid, lanes: newLanes });

    // Broadcast lane changes
    for (const ol of sortedOld) {
      broadcastUpdate('WALK_IN_CLOSED', { lane: ol });
    }
    for (let i = 0; i < newLanes.length; i++) {
      if (walkIns[i]) {
        broadcastUpdate('WALK_IN_OPENED', { lane: newLanes[i], walkIn: walkIns[i] });
      }
    }
  } else {
    // Single lane move
    const targetWalkIn = await getWalkIn(toLane);
    const inMaint = await stateManager.isInMaintenance(toLane);
    if (targetWalkIn || inMaint) return;

    await stateManager.removeWalkIn(fromLane);
    walkIn.lane = toLane;
    await stateManager.addWalkIn(walkIn);

    broadcastUpdate('WALK_IN_CLOSED', { lane: fromLane, walkIn });
    broadcastUpdate('WALK_IN_OPENED', { lane: toLane, walkIn });
  }
};

handlers.CLEAR_STATE = async function() {
  // Clear all walk-ins
  const walkIns = await stateManager.getWalkIns();
  for (const w of walkIns) {
    await stateManager.removeWalkIn(w.lane);
  }

  // Clear all service calls
  const serviceCalls = await stateManager.getServiceCalls();
  for (const lane of Object.keys(serviceCalls)) {
    await stateManager.removeServiceCall(parseInt(lane));
  }

  // Clear all groups
  const groups = await stateManager.getGroups();
  for (const gid of Object.keys(groups)) {
    await stateManager.removeGroup(gid);
  }

  // Broadcast full state refresh
  const fullState = await stateManager.getFullState();
  io.emit('state', fullState);
};

// Exclusion handlers
handlers.EXCLUDE_EVENT = async function({ eventId }) {
  await stateManager.addExcludedEvent(eventId);
  broadcastUpdate('EVENT_EXCLUDED', { eventId });
};

// ── Mechanics Handlers ──────────────────────────────────

// Service History
handlers.GET_SERVICE_HISTORY = async function(options, socket) {
  try {
    const history = await stateManager.getServiceHistory(options);
    socket.emit('service-history', history);
  } catch (error) {
    socket.emit('error', { type: 'service-history', message: error.message });
  }
};

// Component Inventory
handlers.GET_COMPONENTS = async function(_, socket) {
  try {
    const components = await stateManager.getComponents();
    socket.emit('components', components);
  } catch (error) {
    socket.emit('error', { type: 'components', message: error.message });
  }
};

handlers.UPDATE_COMPONENT_INVENTORY = async function({ id, quantity }, socket) {
  try {
    if (typeof quantity !== 'number') {
      socket.emit('error', { type: 'validation', message: 'Quantity must be a number' });
      return;
    }

    const updated = await stateManager.updateComponent(id, { quantity });
    if (!updated) {
      socket.emit('error', { type: 'validation', message: 'Component not found' });
      return;
    }

    broadcastUpdate('COMPONENT_UPDATED', { id });
  } catch (error) {
    socket.emit('error', { type: 'component-update', message: error.message });
  }
};

handlers.ADD_COMPONENT = async function({ component }, socket) {
  try {
    if (!component || !component.componentId || !component.name) {
      socket.emit('error', { type: 'validation', message: 'Component ID and name required' });
      return;
    }

    const existing = await stateManager.findComponentBySlug(component.componentId);
    if (existing) {
      socket.emit('error', { type: 'validation', message: 'Component ID already exists' });
      return;
    }

    const created = await stateManager.addComponent(component);
    broadcastUpdate('COMPONENT_ADDED', { id: created._id });
  } catch (error) {
    socket.emit('error', { type: 'component-add', message: error.message });
  }
};

handlers.LOG_COMPONENT_USAGE = async function({ componentRef, componentId, quantity, context }) {
  try {
    await stateManager.logComponentUsage(componentRef, componentId, quantity, context);
    broadcastUpdate('COMPONENT_USAGE_LOGGED', { componentRef, quantity });
  } catch (error) {
    console.error('[Component Usage] Error:', error);
  }
};

handlers.GET_COMPONENT_USAGE = async function({ componentRef, options }, socket) {
  try {
    const usage = await stateManager.getComponentUsage(componentRef, options);
    socket.emit('component-usage', usage);
  } catch (error) {
    socket.emit('error', { type: 'component-usage', message: error.message });
  }
};

// Maintenance Tasks
handlers.GET_MAINTENANCE_TASKS = async function(options, socket) {
  try {
    let tasks = await stateManager.getMaintenanceTasks();

    // Apply filters if provided
    if (options) {
      if (options.status) {
        tasks = tasks.filter(t => t.status === options.status);
      }
      if (options.lane !== undefined) {
        tasks = tasks.filter(t => t.lane === options.lane || t.lane === null);
      }
      if (options.type) {
        tasks = tasks.filter(t => t.type === options.type);
      }
    }

    socket.emit('maintenance-tasks', tasks);
  } catch (error) {
    socket.emit('error', { type: 'maintenance-tasks', message: error.message });
  }
};

handlers.CREATE_MAINTENANCE_TASK = async function(taskData, socket) {
  try {
    if (!taskData.title || !taskData.type) {
      socket.emit('error', { type: 'validation', message: 'Task title and type required' });
      return;
    }

    const task = await stateManager.addMaintenanceTask({
      ...taskData,
      status: taskData.status || 'pending',
      createdAt: Date.now()
    });

    broadcastUpdate('MAINTENANCE_TASK_CREATED', { task });
  } catch (error) {
    socket.emit('error', { type: 'task-create', message: error.message });
  }
};

handlers.UPDATE_MAINTENANCE_TASK = async function({ taskId, updates }, socket) {
  try {
    if (!taskId) {
      socket.emit('error', { type: 'validation', message: 'Task ID required' });
      return;
    }

    const task = await stateManager.updateMaintenanceTask(taskId, updates);
    if (!task) {
      socket.emit('error', { type: 'validation', message: 'Task not found' });
      return;
    }

    broadcastUpdate('MAINTENANCE_TASK_UPDATED', { task });
  } catch (error) {
    socket.emit('error', { type: 'task-update', message: error.message });
  }
};

handlers.DELETE_MAINTENANCE_TASK = async function({ taskId }, socket) {
  try {
    if (!taskId) {
      socket.emit('error', { type: 'validation', message: 'Task ID required' });
      return;
    }

    await stateManager.deleteMaintenanceTask(taskId);
    broadcastUpdate('MAINTENANCE_TASK_DELETED', { taskId });
  } catch (error) {
    socket.emit('error', { type: 'task-delete', message: error.message });
  }
};

handlers.COMPLETE_MAINTENANCE_TASK = async function({ taskId, notes, componentsUsed }, socket) {
  try {
    if (!taskId) {
      socket.emit('error', { type: 'validation', message: 'Task ID required' });
      return;
    }

    const task = await stateManager.updateMaintenanceTask(taskId, {
      status: 'completed',
      completedAt: Date.now(),
      notes,
      componentsUsed
    });

    if (!task) {
      socket.emit('error', { type: 'validation', message: 'Task not found' });
      return;
    }

    // Update component inventory if components were used
    if (componentsUsed && componentsUsed.length > 0) {
      for (const { component, quantity } of componentsUsed) {
        const comp = await stateManager.findComponentBySlug(component);
        if (comp) {
          await stateManager.updateComponentQuantity(comp._id.toString(), -quantity);
          await stateManager.logComponentUsage(comp._id.toString(), component, quantity, {
            taskId,
            taskTitle: task.title,
            taskType: task.type
          });
        }
      }
    }

    // If task is recurring, create next occurrence
    if (task.recurringPattern) {
      const nextTask = { ...task };
      delete nextTask.id;
      delete nextTask.completedAt;
      delete nextTask.notes;
      nextTask.status = 'pending';

      // Calculate next scheduled time based on pattern
      if (task.scheduledFor) {
        const nextDate = new Date(task.scheduledFor);
        switch (task.recurringPattern) {
          case 'daily':
            nextDate.setDate(nextDate.getDate() + 1);
            break;
          case 'weekly':
            nextDate.setDate(nextDate.getDate() + 7);
            break;
          case 'monthly':
            nextDate.setMonth(nextDate.getMonth() + 1);
            break;
        }
        nextTask.scheduledFor = nextDate.getTime();
      }

      await stateManager.addMaintenanceTask(nextTask);
    }

    broadcastUpdate('MAINTENANCE_TASK_COMPLETED', { task });
  } catch (error) {
    socket.emit('error', { type: 'task-complete', message: error.message });
  }
};

// ── PM Module Handlers ──────────────────────────────────

handlers.GET_PM_CONFIG = async function(_, socket) {
  try {
    const config = await stateManager.getPMConfig();
    socket.emit('pm-config', config);
  } catch (error) {
    socket.emit('error', { type: 'pm-config', message: error.message });
  }
};

handlers.UPDATE_PM_CONFIG = async function({ updates }, socket) {
  try {
    const config = await stateManager.updatePMConfig(updates);
    broadcastUpdate('PM_CONFIG_UPDATED', { config });
  } catch (error) {
    socket.emit('error', { type: 'pm-config-update', message: error.message });
  }
};

handlers.GET_PM_TEMPLATES = async function({ equipmentType }, socket) {
  try {
    const { getTemplatesForEquipment } = require('./src/services/pmTemplates');
    const templates = getTemplatesForEquipment(equipmentType || 'generic');
    socket.emit('pm-templates', templates);
  } catch (error) {
    socket.emit('error', { type: 'pm-templates', message: error.message });
  }
};

handlers.GENERATE_PM_TASKS = async function(_, socket) {
  try {
    const { generatePMTasksForToday } = require('./src/services/pmScheduler');
    const config = await stateManager.getPMConfig();
    const tasks = await generatePMTasksForToday(stateManager, config);
    broadcastUpdate('PM_TASKS_GENERATED', { count: tasks.length });
    socket.emit('pm-tasks-generated', { count: tasks.length, tasks });
  } catch (error) {
    socket.emit('error', { type: 'pm-generate', message: error.message });
  }
};

// ── Socket.IO connection ────────────────────────────────

io.on('connection', async (socket) => {
  console.log('[Socket.IO] Client connected:', socket.id);

  // Send full state on initial connection
  const fullState = await stateManager.getFullState();
  socket.emit('state', fullState);

  // Handle actions
  socket.on('action', async ({ type, ...payload }) => {
    console.log('[Socket.IO] Action received:', type, payload);

    const handler = handlers[type];
    if (handler) {
      try {
        await handler(payload, socket);
      } catch (err) {
        console.error(`[Socket.IO] Error handling ${type}:`, err);
        socket.emit('error', {
          type: 'server',
          message: err.message
        });
      }
    } else {
      console.warn(`[Socket.IO] Unknown action type: ${type}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket.IO] Client disconnected:', socket.id);
  });
});

// ── Google Calendar Sync ────────────────────────────────

function parseEvent(ev, forceLane) {
  const title = ev.summary || 'Untitled Event';
  const desc = ev.description || '';
  const s = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
  const e = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;

  // Skip events without times (all-day events)
  if (!s || !e) return null;

  // Helper to extract metadata from description
  const get = (key) => {
    const m2 = desc.match(new RegExp(`${key}\\s*[:=]\\s*(\\S+)`, 'i'));
    return m2 ? m2[1] : null;
  };

  // Try to parse lane number from multiple sources
  let lane = forceLane;
  let party = title;

  if (!lane) {
    // Try exact format: "Lane X - Party Name"
    const exactMatch = title.match(/^lane\s*(\d+)\s*[-–:]\s*(.+)$/i);
    if (exactMatch) {
      lane = parseInt(exactMatch[1]);
      party = exactMatch[2].trim();
    } else {
      // Try to find lane number anywhere in title: "Party Name Lane 3" or "L3 - Party"
      const laneMatch = title.match(/\b(?:lane\s*|l)(\d+)\b/i);
      if (laneMatch) {
        lane = parseInt(laneMatch[1]);
        // Remove the lane reference from party name
        party = title.replace(/\b(?:lane\s*|l)\d+\b/i, '').replace(/^\s*[-–:]\s*|\s*[-–:]\s*$/g, '').trim();
      } else {
        // Check description for lane
        const descLane = get('lane');
        if (descLane) {
          lane = parseInt(descLane);
        } else {
          // Default to lane 1 if no lane specified
          console.warn(`Event "${title}" has no lane specified, defaulting to lane 1`);
          lane = 1;
        }
      }
    }
  }

  // Ensure lane is one this installation actually has -- a numeric 1-8
  // clamp used to accept any lane in that range regardless of which ones
  // are configured (LANES env var, see src/config/lanes.js), which would
  // silently misfile a reservation onto a lane that doesn't exist on a
  // smaller installation.
  if (!LANES.includes(lane)) {
    console.warn(`Event "${title}" specifies lane ${lane}, not in configured LANES (${LANES.join(',')}) -- defaulting to lane ${LANES[0]}`);
    lane = LANES[0];
  }

  // Clean up party name
  if (!party || party.trim() === '') {
    party = title || 'Reservation';
  }

  const pad = n => n.toString().padStart(2, '0');

  // Determine type with better defaults
  const typeStr = (get('type') || 'reservation').toLowerCase();
  const type = typeStr.includes('reservation') ? 'reservation'
             : typeStr.includes('game') || typeStr.includes('per-game') ? 'per-game'
             : typeStr.includes('hour') ? 'hourly'
             : 'reservation';

  // Calculate duration in hours
  const durationHours = Math.round((e - s) / 3600000 * 10) / 10;

  return {
    id: ev.id,
    lane,
    party: party.trim(),
    source: 'gcal',
    guests: parseInt(get('guests')) || 4,
    type,
    hours: parseFloat(get('hours')) || durationHours,
    games: parseInt(get('games')) || 2,
    paid: (get('paid') || 'false').toLowerCase() === 'true',
    contact: get('contact') || '',
    arrived: false,
    cancelled: false,
    start: `${pad(s.getHours())}:${pad(s.getMinutes())}`,
    end: `${pad(e.getHours())}:${pad(e.getMinutes())}`,
    date: `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`,
  };
}

async function syncGoogleCalendar() {
  if (!GCAL_API_KEY) {
    return false;
  }

  const now = new Date();
  const sod = new Date(now);
  sod.setHours(0, 0, 0, 0);
  sod.setDate(sod.getDate() - 7); // Start 7 days ago
  const eod = new Date(now);
  eod.setHours(23, 59, 59, 999);
  eod.setDate(eod.getDate() + 60); // End 60 days from now
  const results = [];

  async function fetchCal(calId, forceLane) {
    if (!calId) return;
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?key=${GCAL_API_KEY}&timeMin=${sod.toISOString()}&timeMax=${eod.toISOString()}&singleEvents=true&orderBy=startTime`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`[GCal Sync] Failed to fetch calendar ${calId}: ${resp.status}`);
        return;
      }
      const data = await resp.json();
      (data.items || []).forEach(ev => {
        const parsed = parseEvent(ev, forceLane);
        if (parsed) results.push(parsed);
      });
    } catch (e) {
      console.warn('[GCal Sync] Fetch error:', e.message);
    }
  }

  if (GCAL_MODE === 'single' && GCAL_CALENDAR_ID) {
    await fetchCal(GCAL_CALENDAR_ID, null);
  } else if (GCAL_MODE === 'multi') {
    await Promise.all(GCAL_CALENDAR_IDS.map((id, i) => fetchCal(id, i + 1)));
  }

  // Get excluded events
  const excludedEvents = await stateManager.getExcludedEvents();

  // Filter out excluded events (no-shows)
  const filtered = results.filter(r => !excludedEvents.includes(r.id));

  console.log(`[GCal Sync] Fetched ${filtered.length} events from calendar`);

  // Merge: keep local reservations, replace gcal ones
  // Group by date for efficient StateManager operations
  const byDate = new Map();
  for (const res of filtered) {
    if (!byDate.has(res.date)) {
      byDate.set(res.date, []);
    }
    byDate.get(res.date).push(res);
  }

  // Update reservations for each date
  for (const [date, gcalReservations] of byDate.entries()) {
    const existing = await stateManager.getReservationsForDate(date);
    const localReservations = existing.filter(r => !r.source); // Keep manually created ones
    const merged = [...localReservations, ...gcalReservations];
    await stateManager.setReservationsForDate(date, merged);
  }

  return true;
}

// Start periodic sync
if (GCAL_API_KEY) {
  setInterval(async () => {
    const synced = await syncGoogleCalendar();
    if (synced) {
      broadcastFullState(); // Send updated state after sync
    }
  }, GCAL_SYNC_INTERVAL);
}

// ── Startup ─────────────────────────────────────────────

async function start() {
  try {
    // Initialize MongoDB
    await mongoManager.init();

    // Initialize state manager (Redis)
    await stateManager.init();

    // Archive old reservations on startup
    const archived = await stateManager.archiveOldReservations(90);
    if (archived > 0) {
      console.log(`[Startup] Archived ${archived} old reservations`);
    }

    // Check and generate PM tasks
    const { checkAndGeneratePMTasks } = require('./src/services/pmScheduler');
    await checkAndGeneratePMTasks(stateManager);

    // Start server
    server.listen(PORT, () => {
      console.log(`[Server] Listening on port ${PORT}`);
      console.log(`[Server] Redis: ${stateManager.connected ? 'Connected' : 'In-memory fallback'}`);
      console.log(`[Server] MongoDB: ${mongoManager.connected ? 'Connected' : 'Unavailable'}`);
      console.log(`[Server] Google Calendar: ${gcalClient ? 'Enabled' : 'Disabled'}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('[Server] SIGTERM received, shutting down gracefully');
      await stateManager.disconnect();
      await mongoManager.disconnect();
      server.close(() => {
        console.log('[Server] Closed');
        process.exit(0);
      });
    });

  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

start();
