/**
 * State Migration Script
 * Migrates from monolithic state to separate Redis keys
 *
 * Usage: node src/services/migrate-state.js
 */

const { createClient } = require('redis');
const StateManager = require('./StateManager');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const OLD_KEY = 'lunar-lanes:state';

async function migrate() {
  console.log('[Migration] Starting state migration...');

  const redis = createClient({ url: REDIS_URL });
  await redis.connect();

  try {
    // Check if old state exists
    const oldState = await redis.get(OLD_KEY);

    if (!oldState) {
      console.log('[Migration] No old state found. Nothing to migrate.');
      await redis.quit();
      return;
    }

    const state = JSON.parse(oldState);
    console.log('[Migration] Found old state:', {
      reservations: state.reservations?.length || 0,
      walkIns: state.walkIns?.length || 0,
      groups: Object.keys(state.groups || {}).length,
      serviceCalls: Object.keys(state.serviceCalls || {}).length
    });

    // Initialize StateManager
    const stateManager = new StateManager(REDIS_URL);
    await stateManager.init();

    // Migrate walk-ins
    if (state.walkIns && state.walkIns.length > 0) {
      await stateManager.setWalkIns(state.walkIns);
      console.log(`[Migration] Migrated ${state.walkIns.length} walk-ins`);
    }

    // Migrate maintenance
    if (state.maintenance && Object.keys(state.maintenance).length > 0) {
      await stateManager.setMaintenance(state.maintenance);
      console.log(`[Migration] Migrated ${Object.keys(state.maintenance).length} maintenance flags`);
    }

    // Migrate groups
    if (state.groups && Object.keys(state.groups).length > 0) {
      await stateManager.setGroups(state.groups);
      console.log(`[Migration] Migrated ${Object.keys(state.groups).length} groups`);
    }

    // Migrate service calls
    if (state.serviceCalls && Object.keys(state.serviceCalls).length > 0) {
      await stateManager.setServiceCalls(state.serviceCalls);
      console.log(`[Migration] Migrated ${Object.keys(state.serviceCalls).length} service calls`);
    }

    // Migrate excluded events
    if (state.excludedEvents && state.excludedEvents.length > 0) {
      await stateManager.setExcludedEvents(state.excludedEvents);
      console.log(`[Migration] Migrated ${state.excludedEvents.length} excluded events`);
    }

    // Migrate metadata
    if (state.nextGroupId) {
      await stateManager.setMeta({ nextGroupId: state.nextGroupId });
      console.log(`[Migration] Migrated metadata (nextGroupId: ${state.nextGroupId})`);
    }

    // Migrate reservations (partition by date)
    if (state.reservations && state.reservations.length > 0) {
      const byDate = {};

      for (const res of state.reservations) {
        const date = res.date || new Date().toISOString().split('T')[0];
        if (!byDate[date]) {
          byDate[date] = [];
        }
        byDate[date].push(res);
      }

      for (const [date, reservations] of Object.entries(byDate)) {
        await stateManager.setReservationsForDate(date, reservations);
      }

      console.log(`[Migration] Migrated ${state.reservations.length} reservations across ${Object.keys(byDate).length} dates`);
    }

    // Backup old state
    const backupKey = `${OLD_KEY}:backup:${Date.now()}`;
    await redis.set(backupKey, oldState);
    console.log(`[Migration] Backed up old state to ${backupKey}`);

    // Delete old state
    await redis.del(OLD_KEY);
    console.log(`[Migration] Deleted old state key`);

    console.log('[Migration] ✅ Migration complete!');

    // Verify new state
    const fullState = await stateManager.getFullState();
    console.log('[Migration] New state summary:', {
      reservations: fullState.reservations.length,
      walkIns: fullState.walkIns.length,
      groups: Object.keys(fullState.groups).length,
      serviceCalls: Object.keys(fullState.serviceCalls).length
    });

    await stateManager.disconnect();
    await redis.quit();

  } catch (err) {
    console.error('[Migration] Error during migration:', err);
    await redis.quit();
    process.exit(1);
  }
}

// Run migration if called directly
if (require.main === module) {
  migrate().then(() => {
    console.log('[Migration] Done');
    process.exit(0);
  }).catch(err => {
    console.error('[Migration] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = migrate;
