const { createClient } = require('redis');

/**
 * StateManager - Manages application state across Redis and MongoDB
 *
 * Redis (Real-time state):
 * - Walk-ins: lunar-lanes:walk-ins (JSON array, temporary)
 * - Maintenance mode: lunar-lanes:maintenance (JSON object, current flags)
 * - Groups: lunar-lanes:groups (JSON object, current groupings)
 * - Service Calls: lunar-lanes:service-calls (JSON object, active calls)
 * - Reservations by date: lunar-lanes:res:YYYY-MM-DD (JSON array per day)
 * - Metadata: lunar-lanes:meta (counters, etc.)
 * - Excluded events: lunar-lanes:excluded-events (JSON array)
 *
 * MongoDB (Persistent mechanics data - delegated to MongoManager):
 * - service_history: Historical service call logs
 * - components: Component inventory
 * - component_usage: Component usage history
 * - maintenance_tasks: Maintenance task tracking
 * - pm_config: PM module configuration
 */
class StateManager {
  constructor(redisUrl, mongoManager = null) {
    this.redisUrl = redisUrl;
    this.redis = null;
    this.connected = false;
    this.mongoManager = mongoManager;
  }

  /**
   * Initialize Redis connection and restore state
   */
  async init() {
    try {
      this.redis = createClient({ url: this.redisUrl });
      this.redis.on('error', (err) => console.warn('[StateManager] Redis error:', err.message));
      await this.redis.connect();
      this.connected = true;
      console.log('[StateManager] Connected to Redis');

      // Initialize keys if they don't exist
      await this.initializeKeys();
    } catch (err) {
      console.warn('[StateManager] Redis unavailable, using in-memory fallback:', err.message);
      this.redis = null;
      this.connected = false;
    }
  }

  /**
   * Initialize Redis keys with default values if they don't exist
   */
  async initializeKeys() {
    if (!this.redis) return;

    const keys = [
      { key: 'lunar-lanes:walk-ins', defaultValue: '[]' },
      { key: 'lunar-lanes:maintenance', defaultValue: '{}' },
      { key: 'lunar-lanes:groups', defaultValue: '{}' },
      { key: 'lunar-lanes:service-calls', defaultValue: '{}' },
      { key: 'lunar-lanes:excluded-events', defaultValue: '[]' },
      { key: 'lunar-lanes:meta', defaultValue: '{"nextGroupId":1}' }
      // Note: components, maintenance-tasks, pm-config now stored in MongoDB
    ];

    for (const { key, defaultValue } of keys) {
      const exists = await this.redis.exists(key);
      if (!exists) {
        await this.redis.set(key, defaultValue);
      }
    }

    console.log('[StateManager] Initialized Redis keys');
  }

  // ============================================================================
  // Walk-Ins
  // ============================================================================

  async getWalkIns() {
    if (!this.redis) return [];
    const data = await this.redis.get('lunar-lanes:walk-ins');
    return data ? JSON.parse(data) : [];
  }

  async setWalkIns(walkIns) {
    if (!this.redis) return;
    await this.redis.set('lunar-lanes:walk-ins', JSON.stringify(walkIns));
  }

  async addWalkIn(walkIn) {
    const walkIns = await this.getWalkIns();
    // Remove existing walk-in on same lane if any
    const filtered = walkIns.filter(w => w.lane !== walkIn.lane);
    filtered.push(walkIn);
    await this.setWalkIns(filtered);
  }

  async removeWalkIn(lane) {
    const walkIns = await this.getWalkIns();
    const filtered = walkIns.filter(w => w.lane !== lane);
    await this.setWalkIns(filtered);
  }

  async getWalkIn(lane) {
    const walkIns = await this.getWalkIns();
    return walkIns.find(w => w.lane === lane) || null;
  }

  async updateWalkIn(lane, updates) {
    const walkIns = await this.getWalkIns();
    const index = walkIns.findIndex(w => w.lane === lane);
    if (index >= 0) {
      walkIns[index] = { ...walkIns[index], ...updates };
      await this.setWalkIns(walkIns);
    }
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  async getMaintenance() {
    if (!this.redis) return {};
    const data = await this.redis.get('lunar-lanes:maintenance');
    return data ? JSON.parse(data) : {};
  }

  async setMaintenance(maintenance) {
    if (!this.redis) return;
    await this.redis.set('lunar-lanes:maintenance', JSON.stringify(maintenance));
  }

  async toggleMaintenance(lane) {
    const maintenance = await this.getMaintenance();
    if (maintenance[lane]) {
      delete maintenance[lane];
    } else {
      maintenance[lane] = true;
    }
    await this.setMaintenance(maintenance);
    return maintenance[lane] || false;
  }

  async isInMaintenance(lane) {
    const maintenance = await this.getMaintenance();
    return !!maintenance[lane];
  }

  // ============================================================================
  // Groups
  // ============================================================================

  async getGroups() {
    if (!this.redis) return {};
    const data = await this.redis.get('lunar-lanes:groups');
    return data ? JSON.parse(data) : {};
  }

  async setGroups(groups) {
    if (!this.redis) return;
    await this.redis.set('lunar-lanes:groups', JSON.stringify(groups));
  }

  async addGroup(groupId, lanes) {
    const groups = await this.getGroups();
    groups[groupId] = { lanes };
    await this.setGroups(groups);
  }

  async removeGroup(groupId) {
    const groups = await this.getGroups();
    delete groups[groupId];
    await this.setGroups(groups);
  }

  async getGroupForLane(lane) {
    const groups = await this.getGroups();
    for (const [gid, g] of Object.entries(groups)) {
      if (g.lanes && g.lanes.includes(lane)) {
        return { gid, ...g };
      }
    }
    return null;
  }

  // ============================================================================
  // Service Calls
  // ============================================================================

  async getServiceCalls() {
    if (!this.redis) return {};
    const data = await this.redis.get('lunar-lanes:service-calls');
    return data ? JSON.parse(data) : {};
  }

  async setServiceCalls(serviceCalls) {
    if (!this.redis) return;
    await this.redis.set('lunar-lanes:service-calls', JSON.stringify(serviceCalls));
  }

  async addServiceCall(lane, serviceCall) {
    const serviceCalls = await this.getServiceCalls();
    serviceCalls[lane] = serviceCall;
    await this.setServiceCalls(serviceCalls);
  }

  async removeServiceCall(lane) {
    const serviceCalls = await this.getServiceCalls();
    delete serviceCalls[lane];
    await this.setServiceCalls(serviceCalls);
  }

  async updateServiceCall(lane, updates) {
    const serviceCalls = await this.getServiceCalls();
    if (serviceCalls[lane]) {
      serviceCalls[lane] = { ...serviceCalls[lane], ...updates };
      await this.setServiceCalls(serviceCalls);
    }
  }

  // ============================================================================
  // Reservations (Time-based partitioning by date)
  // ============================================================================

  async getReservationsForDate(date) {
    if (!this.redis) return [];
    const data = await this.redis.get(`lunar-lanes:res:${date}`);
    return data ? JSON.parse(data) : [];
  }

  async setReservationsForDate(date, reservations) {
    if (!this.redis) return;
    if (reservations.length === 0) {
      // Delete key if no reservations
      await this.redis.del(`lunar-lanes:res:${date}`);
    } else {
      await this.redis.set(`lunar-lanes:res:${date}`, JSON.stringify(reservations));
    }
  }

  async getAllReservations() {
    if (!this.redis) return [];
    const keys = await this.redis.keys('lunar-lanes:res:*');
    const allReservations = [];

    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        const reservations = JSON.parse(data);
        allReservations.push(...reservations);
      }
    }

    return allReservations;
  }

  async addReservation(reservation) {
    const date = reservation.date;
    const reservations = await this.getReservationsForDate(date);
    reservations.push(reservation);
    await this.setReservationsForDate(date, reservations);
  }

  async removeReservation(lane, date, startTime) {
    const reservations = await this.getReservationsForDate(date);
    const filtered = reservations.filter(r =>
      !(r.lane === lane && r.start === startTime)
    );
    await this.setReservationsForDate(date, filtered);
  }

  async updateReservation(lane, date, startTime, updates) {
    const reservations = await this.getReservationsForDate(date);
    const index = reservations.findIndex(r =>
      r.lane === lane && r.start === startTime
    );
    if (index >= 0) {
      reservations[index] = { ...reservations[index], ...updates };
      await this.setReservationsForDate(date, reservations);
    }
  }

  async getReservationsInDateRange(startDate, endDate) {
    if (!this.redis) return [];
    const allReservations = [];

    // Get all reservation keys
    const keys = await this.redis.keys('lunar-lanes:res:*');

    for (const key of keys) {
      const date = key.split(':')[2];
      if (date >= startDate && date <= endDate) {
        const data = await this.redis.get(key);
        if (data) {
          const reservations = JSON.parse(data);
          allReservations.push(...reservations);
        }
      }
    }

    return allReservations;
  }

  // ============================================================================
  // Excluded Events
  // ============================================================================

  async getExcludedEvents() {
    if (!this.redis) return [];
    const data = await this.redis.get('lunar-lanes:excluded-events');
    return data ? JSON.parse(data) : [];
  }

  async setExcludedEvents(excludedEvents) {
    if (!this.redis) return;
    await this.redis.set('lunar-lanes:excluded-events', JSON.stringify(excludedEvents));
  }

  async addExcludedEvent(eventId) {
    const excludedEvents = await this.getExcludedEvents();
    if (!excludedEvents.includes(eventId)) {
      excludedEvents.push(eventId);
      await this.setExcludedEvents(excludedEvents);
    }
  }

  // ============================================================================
  // Metadata
  // ============================================================================

  async getMeta() {
    if (!this.redis) return { nextGroupId: 1 };
    const data = await this.redis.get('lunar-lanes:meta');
    return data ? JSON.parse(data) : { nextGroupId: 1 };
  }

  async setMeta(meta) {
    if (!this.redis) return;
    await this.redis.set('lunar-lanes:meta', JSON.stringify(meta));
  }

  async getNextGroupId() {
    const meta = await this.getMeta();
    const nextId = meta.nextGroupId || 1;
    meta.nextGroupId = nextId + 1;
    await this.setMeta(meta);
    return nextId;
  }

  // ============================================================================
  // Service History (Mechanics) - Delegated to MongoDB
  // ============================================================================

  async addServiceHistory(entry) {
    if (!this.mongoManager) return null;
    return await this.mongoManager.addServiceHistory(entry);
  }

  async getServiceHistory(options = {}) {
    if (!this.mongoManager) return [];
    return await this.mongoManager.getServiceHistory(options);
  }

  async getServiceHistoryCount(options = {}) {
    if (!this.mongoManager) return 0;
    return await this.mongoManager.getServiceHistoryCount(options);
  }

  // ============================================================================
  // Component Inventory (Mechanics) - Delegated to MongoDB
  // ============================================================================

  async getComponents() {
    if (!this.mongoManager) return [];
    return await this.mongoManager.getComponents();
  }

  async setComponents(components) {
    if (!this.mongoManager) return;
    return await this.mongoManager.setComponents(components);
  }

  async addComponent(component) {
    if (!this.mongoManager) return null;
    return await this.mongoManager.addComponent(component);
  }

  async findComponentBySlug(componentId) {
    if (!this.mongoManager) return null;
    return await this.mongoManager.findComponentBySlug(componentId);
  }

  async updateComponent(id, updates) {
    if (!this.mongoManager) return null;
    return await this.mongoManager.updateComponent(id, updates);
  }

  async updateComponentQuantity(id, quantityChange) {
    if (!this.mongoManager) return null;
    return await this.mongoManager.updateComponentQuantity(id, quantityChange);
  }

  async logComponentUsage(componentRef, componentId, quantity, context) {
    if (!this.mongoManager) return;
    return await this.mongoManager.logComponentUsage(componentRef, componentId, quantity, context);
  }

  async getComponentUsage(componentRef, options = {}) {
    if (!this.mongoManager) return [];
    return await this.mongoManager.getComponentUsage(componentRef, options);
  }

  // ============================================================================
  // Maintenance Tasks (Mechanics) - Delegated to MongoDB
  // ============================================================================

  async getMaintenanceTasks() {
    if (!this.mongoManager) return [];
    return await this.mongoManager.getMaintenanceTasks();
  }

  async setMaintenanceTasks(tasks) {
    if (!this.mongoManager) return;
    return await this.mongoManager.setMaintenanceTasks(tasks);
  }

  async addMaintenanceTask(task) {
    if (!this.mongoManager) return null;
    return await this.mongoManager.addMaintenanceTask(task);
  }

  async updateMaintenanceTask(taskId, updates) {
    if (!this.mongoManager) return null;
    return await this.mongoManager.updateMaintenanceTask(taskId, updates);
  }

  async deleteMaintenanceTask(taskId) {
    if (!this.mongoManager) return;
    return await this.mongoManager.deleteMaintenanceTask(taskId);
  }

  async getMaintenanceTask(taskId) {
    if (!this.mongoManager) return null;
    return await this.mongoManager.getMaintenanceTask(taskId);
  }

  // ============================================================================
  // PM (Preventative Maintenance) Config - Delegated to MongoDB
  // ============================================================================

  async getPMConfig() {
    if (!this.mongoManager) return { enabled: false, equipmentType: 'generic' };
    return await this.mongoManager.getPMConfig();
  }

  async setPMConfig(config) {
    if (!this.mongoManager) return;
    return await this.mongoManager.setPMConfig(config);
  }

  async updatePMConfig(updates) {
    if (!this.mongoManager) return null;
    return await this.mongoManager.updatePMConfig(updates);
  }

  // ============================================================================
  // Full State (for backward compatibility and initial load)
  // ============================================================================

  async getFullState() {
    const [
      walkIns,
      maintenance,
      groups,
      serviceCalls,
      reservations,
      excludedEvents,
      meta,
      components,
      maintenanceTasks
    ] = await Promise.all([
      this.getWalkIns(),
      this.getMaintenance(),
      this.getGroups(),
      this.getServiceCalls(),
      this.getAllReservations(),
      this.getExcludedEvents(),
      this.getMeta(),
      this.getComponents(),
      this.getMaintenanceTasks()
    ]);

    return {
      walkIns,
      maintenance,
      groups,
      serviceCalls,
      reservations,
      excludedEvents,
      nextGroupId: meta.nextGroupId || 1,
      components,
      maintenanceTasks
    };
  }

  // ============================================================================
  // Data Archival
  // ============================================================================

  /**
   * Archive reservations older than cutoffDays
   * Moves them to archive keys for potential later retrieval
   */
  async archiveOldReservations(cutoffDays = 90) {
    if (!this.redis) return;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - cutoffDays);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const keys = await this.redis.keys('lunar-lanes:res:*');
    let archivedCount = 0;

    for (const key of keys) {
      const date = key.split(':')[2];
      if (date < cutoffStr) {
        // Move to archive
        const data = await this.redis.get(key);
        if (data) {
          const month = date.substring(0, 7); // YYYY-MM
          const archiveKey = `lunar-lanes:archive:${month}`;

          // Append to archive (or create new)
          const existing = await this.redis.get(archiveKey);
          const archived = existing ? JSON.parse(existing) : [];
          const reservations = JSON.parse(data);
          archived.push(...reservations);

          await this.redis.set(archiveKey, JSON.stringify(archived));
          await this.redis.del(key);
          archivedCount += reservations.length;
        }
      }
    }

    console.log(`[StateManager] Archived ${archivedCount} old reservations`);
    return archivedCount;
  }

  /**
   * Get archived reservations for a specific month
   */
  async getArchivedReservations(month) {
    if (!this.redis) return [];
    const data = await this.redis.get(`lunar-lanes:archive:${month}`);
    return data ? JSON.parse(data) : [];
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async disconnect() {
    if (this.redis) {
      await this.redis.quit();
      console.log('[StateManager] Disconnected from Redis');
    }
  }
}

module.exports = StateManager;
