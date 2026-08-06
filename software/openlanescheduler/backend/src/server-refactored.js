const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const GoogleCalendarClient = require('../googleCalendar');
const StateManager = require('./services/StateManager');

// ── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
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

// Initialize StateManager
const stateManager = new StateManager(REDIS_URL);

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
      return { available: false, reason: 'Time slot conflicts with existing reservation' };
    }
  }

  return { available: true };
}

// ── Broadcast helper (delta updates) ────────────────────

function broadcastUpdate(type, data) {
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
  const walkIn = await getWalkIn(lane);
  await stateManager.removeWalkIn(lane);

  const serviceCalls = await stateManager.getServiceCalls();
  if (serviceCalls[lane]) {
    await stateManager.removeServiceCall(lane);
  }

  broadcastUpdate('WALK_IN_CLOSED', { lane, walkIn });
};

handlers.TOGGLE_WALK_PAID = async function({ lane }) {
  const walkIn = await getWalkIn(lane);
  if (walkIn) {
    walkIn.paid = !walkIn.paid;
    await stateManager.updateWalkIn(lane, { paid: walkIn.paid });
    broadcastUpdate('WALK_IN_UPDATED', { lane, walkIn });
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

handlers.RESOLVE_SERVICE_CALL = async function({ lane }) {
  const serviceCalls = await stateManager.getServiceCalls();
  const serviceCall = serviceCalls[lane];
  if (serviceCall) {
    const walkIn = await getWalkIn(lane);
    if (walkIn) {
      const elapsed = Date.now() - serviceCall.start;
      walkIn.serviceCallMs = (walkIn.serviceCallMs || 0) + elapsed;
      await stateManager.updateWalkIn(lane, { serviceCallMs: walkIn.serviceCallMs });
    }
    await stateManager.removeServiceCall(lane);
    broadcastUpdate('SERVICE_CALL_RESOLVED', { lane });
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
        const event = await gcalClient.createEvent(reservation);
        reservation.id = event.id;
        reservation.source = 'gcal';
        console.log(`[CREATE_RESERVATION] Created Google Calendar event: ${event.id}`);
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
  const reservations = await stateManager.getReservationsForDate(date);
  const reservation = reservations.find(r => r.lane === lane && r.start === start);

  if (reservation) {
    // Delete from Google Calendar
    if (gcalClient && reservation.id) {
      try {
        await gcalClient.deleteEvent(reservation.id);
      } catch (err) {
        console.warn(`Failed to delete Google Calendar event: ${err.message}`);
      }
    }

    await stateManager.removeReservation(lane, date, start);
    broadcastUpdate('RESERVATION_DELETED', { lane, start, date });
  }
};

handlers.CANCEL_RESERVATION = async function({ lane, start, date }) {
  await stateManager.updateReservation(lane, date, start, { cancelled: true });
  broadcastUpdate('RESERVATION_CANCELLED', { lane, start, date });
};

handlers.MARK_ARRIVED = async function({ lane, start, date }) {
  const reservations = await stateManager.getReservationsForDate(date);
  const reservation = reservations.find(r => r.lane === lane && r.start === start);
  if (reservation) {
    reservation.arrived = !reservation.arrived;
    await stateManager.updateReservation(lane, date, start, { arrived: reservation.arrived });
    broadcastUpdate('RESERVATION_UPDATED', { lane, start, date, arrived: reservation.arrived });
  }
};

handlers.TOGGLE_RES_PAID = async function({ lane, start, date }) {
  const reservations = await stateManager.getReservationsForDate(date);
  const reservation = reservations.find(r => r.lane === lane && r.start === start);
  if (reservation) {
    reservation.paid = !reservation.paid;
    await stateManager.updateReservation(lane, date, start, { paid: reservation.paid });
    broadcastUpdate('RESERVATION_UPDATED', { lane, start, date, paid: reservation.paid });
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

// Exclusion handlers
handlers.EXCLUDE_EVENT = async function({ eventId }) {
  await stateManager.addExcludedEvent(eventId);
  broadcastUpdate('EVENT_EXCLUDED', { eventId });
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

async function syncGoogleCalendar() {
  if (!GCAL_API_KEY || !GCAL_CALENDAR_ID) {
    console.log('[GCal Sync] Skipped - no API key or calendar ID configured');
    return false;
  }

  console.log('[GCal Sync] Starting sync...');

  // Implementation would fetch from Google Calendar API and merge with state
  // For now, keeping existing sync logic

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
    // Initialize state manager
    await stateManager.init();

    // Archive old reservations on startup
    const archived = await stateManager.archiveOldReservations(90);
    if (archived > 0) {
      console.log(`[Startup] Archived ${archived} old reservations`);
    }

    // Start server
    server.listen(PORT, () => {
      console.log(`[Server] Listening on port ${PORT}`);
      console.log(`[Server] Redis: ${stateManager.connected ? 'Connected' : 'In-memory fallback'}`);
      console.log(`[Server] Google Calendar: ${gcalClient ? 'Enabled' : 'Disabled'}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      console.log('[Server] SIGTERM received, shutting down gracefully');
      await stateManager.disconnect();
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
