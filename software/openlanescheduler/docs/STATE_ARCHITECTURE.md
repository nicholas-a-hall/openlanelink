# State Architecture Analysis & Recommendations

## Current Implementation Problems

### 1. Single Monolithic State Object

**Current Approach:**
```javascript
// Everything in one object
state = {
  reservations: [...],      // Could be 100+ items
  walkIns: [...],           // 8 items max
  maintenance: {...},       // 8 items max
  groups: {...},            // Small
  serviceCalls: {...},      // 8 items max
  nextGroupId: 1,
  excludedEvents: [...]     // Could grow indefinitely
};

// Stored as single JSON string
await redis.set('openlanescheduler:state', JSON.stringify(state));

// Broadcast entire state to ALL clients on EVERY change
io.emit('state', state);
```

**Problems:**

#### a) Network Overhead
- **Full state broadcast** on every change (walk-in open, service call, maintenance toggle)
- With 100 reservations: ~50KB per broadcast
- 10 clients × 100 actions/hour = 50MB/hour unnecessary traffic
- Mobile clients waste bandwidth receiving full state constantly

#### b) Memory Waste
- All clients hold complete state in memory
- Kiosk for Lanes 1-2 receives data for Lanes 3-8
- Read-only displays receive editable state
- 100 archived reservations kept in memory

#### c) Parse/Serialize Cost
- Every change requires `JSON.stringify()` (CPU intensive)
- Every client must `JSON.parse()` entire state
- Linear time complexity: O(n) where n = total reservations

#### d) Scalability Issues
- After 1 year: 5,000+ reservation objects
- State object grows indefinitely
- No data archival strategy
- Redis memory fills up

#### e) Race Conditions
```javascript
// Scenario: Two concurrent updates
// Client A: Mark lane 1 paid
// Client B: Mark lane 2 arrived
// Both read state, modify, write back
// One update gets lost! (Last write wins)
```

#### f) No Granular Queries
```javascript
// Want: Reservations for lane 3 on Feb 15
// Must: Parse entire state, filter in memory
// With proper structure: Direct Redis query
```

---

## Recommended Architecture

### Option 1: Separate Redis Keys (Simple Migration)

**Structure:**
```javascript
// Instead of one key:
redis.set('openlanescheduler:state', JSON.stringify(everything))

// Use separate keys:
redis.set('openlanescheduler:walk-ins', JSON.stringify(walkIns))
redis.set('openlanescheduler:maintenance', JSON.stringify(maintenance))
redis.set('openlanescheduler:groups', JSON.stringify(groups))
redis.set('openlanescheduler:service-calls', JSON.stringify(serviceCalls))

// Reservations by date (time-based partitioning)
redis.set('openlanescheduler:reservations:2026-02-15', JSON.stringify([...]))
redis.set('openlanescheduler:reservations:2026-02-16', JSON.stringify([...]))

// Archive old reservations
redis.set('openlanescheduler:archive:2026-01', JSON.stringify([...]))
```

**Benefits:**
- ✅ Update only affected data
- ✅ Query specific date ranges
- ✅ Archive old data easily
- ✅ Simple migration from current code

**Implementation Example:**
```javascript
// backend/services/stateManager.js

class StateManager {
  async getWalkIns() {
    const data = await redis.get('openlanescheduler:walk-ins');
    return data ? JSON.parse(data) : [];
  }

  async setWalkIns(walkIns) {
    await redis.set('openlanescheduler:walk-ins', JSON.stringify(walkIns));
  }

  async getReservationsForDate(date) {
    const data = await redis.get(`openlanescheduler:reservations:${date}`);
    return data ? JSON.parse(data) : [];
  }

  async addReservation(reservation) {
    const date = reservation.date;
    const existing = await this.getReservationsForDate(date);
    existing.push(reservation);
    await redis.set(`openlanescheduler:reservations:${date}`, JSON.stringify(existing));
  }

  // Archive reservations older than 90 days
  async archiveOldReservations() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    // Move to archive keys...
  }
}
```

---

### Option 2: Redis Native Data Structures (Better Performance)

**Use Redis Hashes, Sets, Sorted Sets:**

```javascript
// Walk-ins (8 max, frequently updated)
redis.hSet('openlanescheduler:walk-ins', '1', JSON.stringify(walkInData))
redis.hGet('openlanescheduler:walk-ins', '1')  // Get single lane
redis.hGetAll('openlanescheduler:walk-ins')    // Get all

// Maintenance flags (simple key-value)
redis.set('openlanescheduler:maintenance:3', 'true')
redis.get('openlanescheduler:maintenance:3')

// Service calls with timestamps
redis.hSet('openlanescheduler:service-calls', '5', JSON.stringify({
  start: Date.now(),
  acked: false,
  origin: 'kiosk'
}))

// Reservations by date (sorted by start time)
redis.zAdd('openlanescheduler:res:2026-02-15', [
  { score: 1400, value: JSON.stringify(reservation) }, // 14:00
  { score: 1600, value: JSON.stringify(reservation) }  // 16:00
])

// Query reservations in time range
const afternoon = await redis.zRangeByScore(
  'openlanescheduler:res:2026-02-15',
  1200,  // 12:00
  1800   // 18:00
);

// Reservation index by lane
redis.sAdd('openlanescheduler:res-by-lane:3', 'res-id-1', 'res-id-2')
redis.sMembers('openlanescheduler:res-by-lane:3')  // All reservation IDs for lane 3
```

**Benefits:**
- ✅ Atomic operations (no race conditions)
- ✅ Query by time range efficiently
- ✅ O(log n) lookups instead of O(n)
- ✅ Less memory overhead
- ✅ Built-in expiration (TTL)

**Example:**
```javascript
class StateManager {
  // Get walk-in for specific lane
  async getWalkIn(lane) {
    const data = await redis.hGet('openlanescheduler:walk-ins', String(lane));
    return data ? JSON.parse(data) : null;
  }

  // Set walk-in atomically
  async setWalkIn(lane, walkIn) {
    if (walkIn) {
      await redis.hSet('openlanescheduler:walk-ins', String(lane), JSON.stringify(walkIn));
    } else {
      await redis.hDel('openlanescheduler:walk-ins', String(lane));
    }
  }

  // Get all walk-ins
  async getAllWalkIns() {
    const hash = await redis.hGetAll('openlanescheduler:walk-ins');
    return Object.entries(hash).map(([lane, data]) => ({
      lane: parseInt(lane),
      ...JSON.parse(data)
    }));
  }

  // Get reservations for date, sorted by time
  async getReservationsForDate(date) {
    const results = await redis.zRange(`openlanescheduler:res:${date}`, 0, -1);
    return results.map(r => JSON.parse(r));
  }

  // Add reservation with automatic sorting
  async addReservation(reservation) {
    const score = this.timeToScore(reservation.start); // 14:00 -> 1400
    await redis.zAdd(
      `openlanescheduler:res:${reservation.date}`,
      { score, value: JSON.stringify(reservation) }
    );

    // Add to lane index
    await redis.sAdd(
      `openlanescheduler:res-by-lane:${reservation.lane}`,
      reservation.id
    );
  }

  // Automatic cleanup with TTL
  async archiveOldDates() {
    const keys = await redis.keys('openlanescheduler:res:*');
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);

    for (const key of keys) {
      const date = key.split(':')[2];
      if (new Date(date) < cutoff) {
        await redis.expire(key, 60 * 60 * 24 * 7); // Delete in 7 days
      }
    }
  }
}
```

---

### Option 3: Delta Updates (Incremental State Sync)

**Instead of broadcasting full state, send only changes:**

```javascript
// Current (bad):
io.emit('state', state);  // 50KB every time

// Better (delta updates):
io.emit('stateUpdate', {
  type: 'WALK_IN_OPENED',
  lane: 3,
  data: { bowlers: 4, type: 'hourly', openedAt: Date.now() }
});

io.emit('stateUpdate', {
  type: 'RESERVATION_CREATED',
  data: { id: 'res-123', lane: 5, party: 'Smith', ... }
});

io.emit('stateUpdate', {
  type: 'MAINTENANCE_TOGGLED',
  lane: 2,
  enabled: true
});
```

**Client-side reducer:**
```javascript
// frontend/src/shared.js
function stateReducer(state, update) {
  switch (update.type) {
    case 'WALK_IN_OPENED':
      return {
        ...state,
        walkIns: [...state.walkIns, { lane: update.lane, ...update.data }]
      };

    case 'WALK_IN_CLOSED':
      return {
        ...state,
        walkIns: state.walkIns.filter(w => w.lane !== update.lane)
      };

    case 'RESERVATION_CREATED':
      return {
        ...state,
        reservations: [...state.reservations, update.data]
      };

    case 'MAINTENANCE_TOGGLED':
      return {
        ...state,
        maintenance: { ...state.maintenance, [update.lane]: update.enabled }
      };

    default:
      return state;
  }
}

// In useSocket hook:
socket.on('stateUpdate', (update) => {
  setState(prev => stateReducer(prev, update));
});
```

**Benefits:**
- ✅ 100-1000x smaller payloads (bytes instead of KB)
- ✅ Faster network transmission
- ✅ Event-driven architecture
- ✅ Audit trail of all changes
- ✅ Easy to implement undo/redo

---

## Recommended Migration Path

### Phase 1: Separate Keys (Immediate Win)

**Low risk, high value - do this first:**

```javascript
// backend/server.js refactor

// Old:
const state = { reservations, walkIns, maintenance, ... };
await redis.set('openlanescheduler:state', JSON.stringify(state));

// New:
await Promise.all([
  redis.set('openlanescheduler:walk-ins', JSON.stringify(walkIns)),
  redis.set('openlanescheduler:maintenance', JSON.stringify(maintenance)),
  redis.set('openlanescheduler:groups', JSON.stringify(groups)),
  redis.set('openlanescheduler:service-calls', JSON.stringify(serviceCalls)),
  ...reservationsByDate.map(([date, res]) =>
    redis.set(`openlanescheduler:reservations:${date}`, JSON.stringify(res))
  )
]);
```

**Broadcast only changed entity:**
```javascript
// Instead of:
io.emit('state', state);

// Do:
io.emit('walkIns', walkIns);
// or
io.emit('reservations', { date: '2026-02-15', data: reservations });
```

**Estimated effort:** 2-3 days
**Performance gain:** 50-80% reduction in network traffic

---

### Phase 2: Delta Updates (Better UX)

**Add incremental updates:**

```javascript
// backend/handlers/walkIn.js
handlers.OPEN_WALKIN = async function({ lane, bowlers, type, games, hours }) {
  const walkIn = { lane, bowlers, type, games, hours, openedAt: Date.now() };

  // Update state
  walkIns.push(walkIn);
  await redis.set('openlanescheduler:walk-ins', JSON.stringify(walkIns));

  // Send delta update (not full state)
  io.emit('stateUpdate', {
    type: 'WALK_IN_OPENED',
    lane,
    data: walkIn,
    timestamp: Date.now()
  });
};
```

**Estimated effort:** 1 week
**Performance gain:** 90% reduction in payload size

---

### Phase 3: Redis Data Structures (Optimal)

**Migrate to native Redis structures:**

This is the most work but provides best performance and scalability.

**Estimated effort:** 2-3 weeks
**Performance gain:** 95% reduction + faster queries + atomic operations

---

## Performance Comparison

### Current Architecture
```
Action: Open walk-in on lane 3
1. Modify state object (in-memory)
2. JSON.stringify(state)          // 50KB, 5ms
3. Redis SET                       // 10ms
4. io.emit('state', state)         // 50KB × 10 clients = 500KB
5. All clients JSON.parse()        // 10 clients × 5ms = 50ms total
Total: ~70ms, 500KB network
```

### Recommended (Separate Keys + Delta)
```
Action: Open walk-in on lane 3
1. Create walkIn object
2. JSON.stringify(walkIn)          // 200 bytes, <1ms
3. Redis HSET                       // 5ms
4. io.emit('stateUpdate', delta)   // 200 bytes × 10 clients = 2KB
5. Clients update via reducer      // 10 clients × <1ms = 10ms
Total: ~15ms, 2KB network
```

**Result:** 5x faster, 250x less network traffic

---

## Data Retention Strategy

### Current: No Archival
```
// Problem: reservations array grows forever
state.reservations.push(reservation);
// After 1 year: 5,000+ items in memory
```

### Recommended: Time-Based Partitioning
```javascript
// Active data (last 30 days)
redis.set('openlanescheduler:res:2026-02-15', ...)
redis.set('openlanescheduler:res:2026-02-14', ...)

// Archive (30-90 days old)
redis.set('openlanescheduler:archive:2026-01', ...)

// Historical (90+ days) - move to S3/file storage
```

**Archival Script:**
```javascript
// backend/scripts/archiveOldData.js
async function archiveOldReservations() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);

  const keys = await redis.keys('openlanescheduler:res:*');

  for (const key of keys) {
    const date = key.split(':')[2];
    if (new Date(date) < cutoff) {
      const data = await redis.get(key);
      await saveToArchive(date, data); // S3, MongoDB, etc.
      await redis.del(key);
      console.log(`Archived ${date}`);
    }
  }
}

// Run nightly via cron
```

---

## Error Recovery

### Current: No Versioning
```javascript
// Problem: If state gets corrupted, no way to recover
await redis.set('openlanescheduler:state', JSON.stringify(state));
```

### Recommended: State Snapshots
```javascript
// Take snapshots before major changes
async function snapshot() {
  const timestamp = Date.now();
  const state = await loadCurrentState();

  await redis.set(
    `openlanescheduler:snapshot:${timestamp}`,
    JSON.stringify(state)
  );

  // Keep last 10 snapshots
  const snapshots = await redis.keys('openlanescheduler:snapshot:*');
  if (snapshots.length > 10) {
    const oldest = snapshots.sort()[0];
    await redis.del(oldest);
  }
}

// Restore from snapshot
async function restore(timestamp) {
  const snapshot = await redis.get(`openlanescheduler:snapshot:${timestamp}`);
  // Restore state...
}
```

---

## Monitoring & Metrics

**Add observability:**
```javascript
// Track state size over time
async function logStateMetrics() {
  const walkIns = await redis.get('openlanescheduler:walk-ins');
  const reservations = await redis.keys('openlanescheduler:res:*');

  console.log({
    walkInsSize: walkIns?.length || 0,
    reservationKeys: reservations.length,
    timestamp: Date.now()
  });
}

// Alert if state grows too large
if (reservations.length > 1000) {
  console.warn('State growing large, consider archival');
}
```

---

## Summary

### Critical Issues with Current Approach:
1. ❌ **Full state broadcasts** waste 95% of network bandwidth
2. ❌ **No data archival** leads to unbounded memory growth
3. ❌ **Race conditions** possible with concurrent updates
4. ❌ **Poor query performance** requires parsing all data
5. ❌ **No scalability path** for multiple locations/servers

### Recommended Immediate Actions:
1. ✅ **Split state into separate Redis keys** (2-3 days, huge win)
2. ✅ **Add delta updates** instead of full broadcasts (1 week)
3. ✅ **Implement data archival** for old reservations (2 days)
4. ✅ **Add state snapshots** for recovery (1 day)
5. ✅ **Monitor state size** with metrics (1 day)

### Long-Term Improvements:
- Migrate to Redis native data structures
- Add event sourcing for audit trail
- Implement CQRS (Command Query Responsibility Segregation)
- Add multi-location support with distributed state
- Implement conflict-free replicated data types (CRDTs)

---

**Next Steps:** Would you like me to implement Phase 1 (separate keys + delta updates)?
