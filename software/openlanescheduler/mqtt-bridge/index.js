const mqtt = require('mqtt');
const io = require('socket.io-client');

// ── Configuration ────────────────────────────────────────
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

const LANES = [1, 2, 3, 4, 5, 6, 7, 8];

// ── Logger ───────────────────────────────────────────────
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLogLevel = LOG_LEVELS[LOG_LEVEL] || LOG_LEVELS.info;

const log = {
  error: (...args) => currentLogLevel >= LOG_LEVELS.error && console.error('[MQTT-Bridge ERROR]', ...args),
  warn: (...args) => currentLogLevel >= LOG_LEVELS.warn && console.warn('[MQTT-Bridge WARN]', ...args),
  info: (...args) => currentLogLevel >= LOG_LEVELS.info && console.log('[MQTT-Bridge INFO]', ...args),
  debug: (...args) => currentLogLevel >= LOG_LEVELS.debug && console.log('[MQTT-Bridge DEBUG]', ...args),
};

// ── State Cache ──────────────────────────────────────────
let laneStates = {};  // Cache of current lane states for MQTT publish

// ── MQTT Client Setup ────────────────────────────────────
log.info('Connecting to MQTT broker:', MQTT_BROKER_URL);

const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  clientId: `openlanescheduler-bridge-${Date.now()}`,
  clean: true,
  reconnectPeriod: 1000,
  keepalive: 60,
  connectTimeout: 30 * 1000,
  will: {
    topic: 'openlanescheduler/bridge/status',
    payload: JSON.stringify({ online: false, timestamp: Date.now() }),
    qos: 1,
    retain: true
  }
});

mqttClient.on('connect', () => {
  log.info('✓ Connected to MQTT broker');

  // Subscribe to hardware topics
  subscribeToHardwareTopics();

  // Publish bridge online status
  mqttClient.publish(
    'openlanescheduler/bridge/status',
    JSON.stringify({ online: true, timestamp: Date.now() }),
    { qos: 1, retain: true }
  );
});

mqttClient.on('error', (error) => {
  log.error('MQTT error:', error.message);
});

mqttClient.on('offline', () => {
  log.warn('MQTT broker offline - will attempt reconnection');
});

mqttClient.on('reconnect', () => {
  log.info('Reconnecting to MQTT broker...');
});

mqttClient.on('message', (topic, message) => {
  handleMQTTMessage(topic, message);
});

// ── Socket.IO Client Setup ───────────────────────────────
log.info('Connecting to backend:', BACKEND_URL);

const socket = io(BACKEND_URL, {
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: Infinity,
});

socket.on('connect', () => {
  log.info('✓ Connected to backend via Socket.IO');
});

socket.on('disconnect', () => {
  log.warn('Disconnected from backend - will attempt reconnection');
});

socket.on('error', (error) => {
  log.error('Socket.IO error:', error);
});

// Listen to full state snapshot (on initial connection)
socket.on('state', (state) => {
  log.info('─────────────────────────────────────────────────────');
  log.info('[State Snapshot] Received full state from backend');
  log.info(`  Reservations: ${(state.reservations || []).length}`);
  log.info(`  Walk-ins: ${(state.walkIns || []).length}`);
  log.info(`  Maintenance: ${Object.keys(state.maintenance || {}).filter(k => state.maintenance[k]).length} lanes`);
  log.info(`  Service calls: ${Object.keys(state.serviceCalls || {}).length}`);
  log.info(`  Groups: ${Object.keys(state.groups || {}).length}`);
  log.info('─────────────────────────────────────────────────────');

  updateLaneStatesCache(state);
  publishAllLaneStatesToMQTT(state);
});

// Listen to delta state updates (ongoing)
socket.on('stateUpdate', (update) => {
  const dataPreview = JSON.stringify(update.data).substring(0, 150);
  log.info(`[Socket.IO ← Backend] ${update.type}: ${dataPreview}${dataPreview.length >= 150 ? '...' : ''}`);
  handleBackendStateUpdate(update);
});

// ── MQTT Subscription ────────────────────────────────────
function subscribeToHardwareTopics() {
  // Subscribe to service calls from all lanes
  mqttClient.subscribe('openlanescheduler/lane/+/service_call', { qos: 1 }, (err) => {
    if (err) {
      log.error('Failed to subscribe to service_call:', err);
    } else {
      log.info('✓ Subscribed to openlanescheduler/lane/+/service_call');
    }
  });

  // Subscribe to sensors (ball return, pin reset, etc.)
  mqttClient.subscribe('openlanescheduler/lane/+/sensor/#', { qos: 0 }, (err) => {
    if (err) {
      log.error('Failed to subscribe to sensors:', err);
    } else {
      log.info('✓ Subscribed to openlanescheduler/lane/+/sensor/#');
    }
  });

  // Subscribe to device online/offline status
  mqttClient.subscribe('openlanescheduler/device/+/online', { qos: 1 }, (err) => {
    if (err) {
      log.error('Failed to subscribe to device status:', err);
    } else {
      log.info('✓ Subscribed to openlanescheduler/device/+/online');
    }
  });

  // Subscribe to device heartbeats
  mqttClient.subscribe('openlanescheduler/device/+/heartbeat', { qos: 0 }, (err) => {
    if (err) {
      log.error('Failed to subscribe to heartbeats:', err);
    } else {
      log.info('✓ Subscribed to openlanescheduler/device/+/heartbeat');
    }
  });
}

// ── MQTT Message Handlers ────────────────────────────────
function handleMQTTMessage(topic, message) {
  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split('/');
    const payloadPreview = JSON.stringify(payload).substring(0, 100);

    log.info(`[MQTT → Bridge] ${topic}: ${payloadPreview}${payloadPreview.length >= 100 ? '...' : ''}`);

    // Service call: openlanescheduler/lane/{1-8}/service_call
    if (parts[0] === 'openlanescheduler' && parts[1] === 'lane' && parts[3] === 'service_call') {
      const lane = parseInt(parts[2]);
      handleServiceCall(lane, payload);
    }

    // Ball return sensor: openlanescheduler/lane/{1-8}/sensor/ball_return
    else if (parts[0] === 'openlanescheduler' && parts[1] === 'lane' && parts[3] === 'sensor' && parts[4] === 'ball_return') {
      const lane = parseInt(parts[2]);
      handleBallReturnSensor(lane, payload);
    }

    // Pin reset sensor: openlanescheduler/lane/{1-8}/sensor/pin_reset
    else if (parts[0] === 'openlanescheduler' && parts[1] === 'lane' && parts[3] === 'sensor' && parts[4] === 'pin_reset') {
      const lane = parseInt(parts[2]);
      handlePinResetSensor(lane, payload);
    }

    // Game complete sensor: openlanescheduler/lane/{1-8}/sensor/game_complete
    else if (parts[0] === 'openlanescheduler' && parts[1] === 'lane' && parts[3] === 'sensor' && parts[4] === 'game_complete') {
      const lane = parseInt(parts[2]);
      handleGameCompleteSensor(lane, payload);
    }

    // Device status: openlanescheduler/device/{device_id}/online
    else if (parts[0] === 'openlanescheduler' && parts[1] === 'device' && parts[3] === 'online') {
      const deviceId = parts[2];
      handleDeviceStatus(deviceId, payload);
    }

    // Device heartbeat: openlanescheduler/device/{device_id}/heartbeat
    else if (parts[0] === 'openlanescheduler' && parts[1] === 'device' && parts[3] === 'heartbeat') {
      const deviceId = parts[2];
      log.debug(`Heartbeat from ${deviceId}`);
    }

  } catch (err) {
    log.error('Failed to parse MQTT message:', err.message, 'Topic:', topic);
  }
}

function handleServiceCall(lane, payload) {
  const origin = payload.origin || 'unknown';
  const deviceId = payload.deviceId || 'unknown';

  log.info(`╔═══════════════════════════════════════════════════════`);
  log.info(`║ SERVICE CALL from Lane ${lane}`);
  log.info(`║ Origin: ${origin} | Device: ${deviceId}`);
  log.info(`╚═══════════════════════════════════════════════════════`);

  // Forward to backend via Socket.IO
  const action = { type: 'MANAGER_SERVICE_CALL', lane: lane };
  log.info(`[Bridge → Backend] Emitting action:`, JSON.stringify(action));

  socket.emit('action', action);
}

function handleBallReturnSensor(lane, payload) {
  log.info(`Ball return detected on lane ${lane}, count: ${payload.count}`);
  // Could trigger auto-increment of game count for per-game walk-ins
  // For now, just log it
}

function handlePinResetSensor(lane, payload) {
  log.debug(`Pin reset on lane ${lane}`);
  // Could be used for automated game detection
}

function handleGameCompleteSensor(lane, payload) {
  log.info(`Game complete on lane ${lane}`);
  // Could trigger notifications or auto-extend prompts
}

function handleDeviceStatus(deviceId, payload) {
  const status = payload.online ? 'online' : 'offline';
  log.info(`Device ${deviceId} is now ${status}`);
}

// ── Backend State Update Handlers ────────────────────────
function handleBackendStateUpdate(update) {
  const { type, data } = update;
  const affectedLanes = [];

  switch (type) {
    case 'WALK_IN_OPENED':
    case 'WALK_IN_CLOSED':
    case 'WALK_IN_UPDATED':
    case 'MAINTENANCE_TOGGLED':
    case 'SERVICE_CALL_CREATED':
    case 'SERVICE_CALL_ACKED':
    case 'SERVICE_CALL_RESOLVED':
    case 'RESERVATIONS_CREATED':
    case 'RESERVATION_DELETED':
    case 'RESERVATION_CANCELLED':
    case 'RESERVATION_UPDATED':
      if (data.lane) {
        affectedLanes.push(data.lane);
        publishLaneStatusToMQTT(data.lane);
      }
      // For multi-lane reservations
      if (data.reservations && Array.isArray(data.reservations)) {
        data.reservations.forEach(r => {
          affectedLanes.push(r.lane);
          publishLaneStatusToMQTT(r.lane);
        });
      }
      break;

    case 'GROUP_CREATED':
    case 'GROUP_REMOVED':
      // Update all lanes in the group
      if (data.lanes && Array.isArray(data.lanes)) {
        data.lanes.forEach(lane => {
          affectedLanes.push(lane);
          publishLaneStatusToMQTT(lane);
        });
      }
      break;

    default:
      log.debug('Unhandled update type:', type);
      return;
  }

  if (affectedLanes.length > 0) {
    log.info(`  → Updated MQTT status for lane(s): ${affectedLanes.join(', ')}`);
  }
}

// ── MQTT Publishing ──────────────────────────────────────
function publishLaneStatusToMQTT(lane) {
  const state = laneStates[lane];
  if (!state) {
    log.warn(`No cached state for lane ${lane}, skipping MQTT publish`);
    return;
  }

  const topic = `openlanescheduler/lane/${lane}/status`;
  const payload = buildLaneStatusPayload(lane, state);
  const payloadStr = JSON.stringify(payload);

  log.info(`[Bridge → MQTT] Publishing lane ${lane} status: ${payloadStr.substring(0, 120)}...`);

  mqttClient.publish(topic, payloadStr, { qos: 0, retain: true }, (err) => {
    if (err) {
      log.error(`Failed to publish lane ${lane} status:`, err.message);
    } else {
      log.debug(`✓ Published to ${topic}`);
    }
  });

  // Also publish next reservation if available
  publishNextReservationToMQTT(lane, state);
}

function publishAllLaneStatesToMQTT(fullState) {
  LANES.forEach(lane => {
    publishLaneStatusToMQTT(lane);
  });

  // Publish global time
  mqttClient.publish(
    'openlanescheduler/global/time',
    JSON.stringify({ timestamp: Date.now(), timezone: 'America/Chicago' }),
    { qos: 0, retain: true }
  );
}

function publishNextReservationToMQTT(lane, state) {
  const topic = `openlanescheduler/lane/${lane}/display/next_reservation`;

  // Find next reservation for this lane
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const nowHr = now.getHours() + now.getMinutes() / 60;

  const nextRes = (state.reservations || [])
    .filter(r => {
      const rDate = r.date || todayStr;
      if (rDate !== todayStr) return false;
      const [h, m] = r.start.split(':').map(Number);
      const startHr = h + m / 60;
      return r.lane === lane && startHr > nowHr && !r.cancelled;
    })
    .sort((a, b) => {
      const aHr = a.start.split(':').map(Number);
      const bHr = b.start.split(':').map(Number);
      return (aHr[0] + aHr[1] / 60) - (bHr[0] + bHr[1] / 60);
    })[0];

  let payload;
  if (nextRes) {
    const [h, m] = nextRes.start.split(':').map(Number);
    const startHr = h + m / 60;
    const minutesUntil = Math.floor((startHr - nowHr) * 60);

    payload = {
      lane,
      hasReservation: true,
      party: nextRes.party,
      startTime: nextRes.start,
      guests: nextRes.guests,
      minutesUntil
    };
  } else {
    payload = {
      lane,
      hasReservation: false
    };
  }

  mqttClient.publish(topic, JSON.stringify(payload), { qos: 0, retain: true }, (err) => {
    if (err) {
      log.error(`Failed to publish next reservation for lane ${lane}:`, err.message);
    }
  });
}

// ── State Building ───────────────────────────────────────
function updateLaneStatesCache(fullState) {
  laneStates = {};

  LANES.forEach(lane => {
    laneStates[lane] = {
      lane,
      reservations: fullState.reservations || [],
      walkIns: fullState.walkIns || [],
      maintenance: fullState.maintenance || {},
      serviceCalls: fullState.serviceCalls || {},
      groups: fullState.groups || {}
    };
  });
}

function buildLaneStatusPayload(lane, state) {
  const walkIn = (state.walkIns || []).find(w => w.lane === lane);
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const nowHr = now.getHours() + now.getMinutes() / 60;

  const reservation = (state.reservations || []).find(r => {
    const rDate = r.date || todayStr;
    if (rDate !== todayStr) return false;
    const [startH, startM] = r.start.split(':').map(Number);
    const [endH, endM] = r.end.split(':').map(Number);
    const startHr = startH + startM / 60;
    const endHr = endH + endM / 60;
    return r.lane === lane && nowHr >= startHr && nowHr < endHr && !r.cancelled;
  });

  const inMaintenance = state.maintenance[lane] || false;
  const inService = !!(state.serviceCalls || {})[lane];
  const serviceAcked = inService ? (state.serviceCalls[lane].acked || false) : false;

  let status, paid, party, endTime, color;

  if (inMaintenance) {
    status = 'maintenance';
    paid = false;
    party = null;
    endTime = null;
    color = '#6b7ea6';
  } else if (walkIn) {
    status = 'active';
    paid = walkIn.paid || false;
    party = 'Walk-in';
    endTime = null;  // Could calculate estimated end time
    color = paid ? '#39ff14' : '#ff2a2a';
  } else if (reservation) {
    status = reservation.arrived ? 'active' : 'pending';
    paid = reservation.paid || false;
    party = reservation.party;
    endTime = reservation.end;
    color = reservation.arrived
      ? (paid ? '#39ff14' : '#ff2a2a')
      : '#ffbe0b';
  } else {
    status = 'open';
    paid = false;
    party = null;
    endTime = null;
    color = '#00b4ff';
  }

  // Override color for service calls
  if (inService) {
    color = serviceAcked ? '#e0f0ff' : '#ff9500';
  }

  return {
    lane,
    status,
    paid,
    maintenance: inMaintenance,
    inService,
    serviceAcked,
    party,
    endTime,
    color,
    timestamp: Date.now()
  };
}

// ── Graceful Shutdown ────────────────────────────────────
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  log.info('Shutting down MQTT bridge...');

  // Publish offline status
  mqttClient.publish(
    'openlanescheduler/bridge/status',
    JSON.stringify({ online: false, timestamp: Date.now() }),
    { qos: 1, retain: true },
    () => {
      mqttClient.end();
      socket.disconnect();
      process.exit(0);
    }
  );
}

// ── Startup Banner ──────────────────────────────────────
console.log('\n╔═══════════════════════════════════════════════════════════════╗');
console.log('║                   OPENLANE SCHEDULER MQTT BRIDGE                    ║');
console.log('╚═══════════════════════════════════════════════════════════════╝\n');

log.info('Configuration:');
log.info(`  MQTT Broker:    ${MQTT_BROKER_URL}`);
log.info(`  Backend URL:    ${BACKEND_URL}`);
log.info(`  Log Level:      ${LOG_LEVEL}`);
log.info(`  Timezone:       ${process.env.TZ || 'System default'}`);
log.info('\nStarting bridge services...\n');
