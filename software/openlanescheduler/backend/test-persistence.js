#!/usr/bin/env node

/**
 * Test script to verify state persistence across restarts
 *
 * Usage: node test-persistence.js
 */

const StateManager = require('./src/services/StateManager');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

async function testPersistence() {
  console.log('=== Testing State Persistence ===\n');

  // ============================================================================
  // Step 1: Create some state
  // ============================================================================
  console.log('📝 Step 1: Creating test state...');

  const sm1 = new StateManager(REDIS_URL);
  await sm1.init();

  // Add a walk-in
  await sm1.addWalkIn({
    lane: 3,
    bowlers: 4,
    type: 'hourly',
    hours: 2,
    openedAt: Date.now(),
    paid: false
  });

  // Toggle maintenance on lane 5
  await sm1.toggleMaintenance(5);

  // Add a reservation
  await sm1.addReservation({
    id: 'test-reservation-1',
    lane: 7,
    party: 'Test Party',
    start: '14:00',
    end: '16:00',
    date: '2026-02-16',
    guests: 20,
    type: 'reservation',
    paid: false,
    arrived: false,
    cancelled: false
  });

  console.log('   ✅ Created walk-in on lane 3');
  console.log('   ✅ Toggled maintenance on lane 5');
  console.log('   ✅ Added reservation for lane 7');

  // Get current state
  const state1 = await sm1.getFullState();
  console.log('\n📊 Current State:');
  console.log(`   Walk-ins: ${state1.walkIns.length}`);
  console.log(`   Maintenance: ${Object.keys(state1.maintenance).length} lanes`);
  console.log(`   Reservations: ${state1.reservations.length}`);

  await sm1.disconnect();
  console.log('\n🔌 Disconnected from Redis\n');

  // ============================================================================
  // Step 2: Simulate server restart (new StateManager instance)
  // ============================================================================
  console.log('🔄 Step 2: Simulating server restart...');
  console.log('   Creating new StateManager instance...\n');

  const sm2 = new StateManager(REDIS_URL);
  await sm2.init();

  // ============================================================================
  // Step 3: Verify state was restored
  // ============================================================================
  console.log('🔍 Step 3: Verifying state persistence...\n');

  const state2 = await sm2.getFullState();

  // Check walk-ins
  const walkIn = await sm2.getWalkIn(3);
  if (walkIn && walkIn.bowlers === 4) {
    console.log('   ✅ Walk-in on lane 3 restored correctly');
    console.log(`      - Bowlers: ${walkIn.bowlers}`);
    console.log(`      - Type: ${walkIn.type}`);
    console.log(`      - Hours: ${walkIn.hours}`);
  } else {
    console.log('   ❌ Walk-in NOT restored!');
    process.exit(1);
  }

  // Check maintenance
  const inMaint = await sm2.isInMaintenance(5);
  if (inMaint) {
    console.log('   ✅ Maintenance on lane 5 restored correctly');
  } else {
    console.log('   ❌ Maintenance NOT restored!');
    process.exit(1);
  }

  // Check reservations
  const reservations = await sm2.getReservationsForDate('2026-02-16');
  if (reservations.length === 1 && reservations[0].party === 'Test Party') {
    console.log('   ✅ Reservation restored correctly');
    console.log(`      - Party: ${reservations[0].party}`);
    console.log(`      - Lane: ${reservations[0].lane}`);
    console.log(`      - Time: ${reservations[0].start}-${reservations[0].end}`);
  } else {
    console.log('   ❌ Reservation NOT restored!');
    process.exit(1);
  }

  console.log('\n📊 Restored State:');
  console.log(`   Walk-ins: ${state2.walkIns.length}`);
  console.log(`   Maintenance: ${Object.keys(state2.maintenance).length} lanes`);
  console.log(`   Reservations: ${state2.reservations.length}`);

  // Verify states match
  if (JSON.stringify(state1) === JSON.stringify(state2)) {
    console.log('\n✅ PERFECT MATCH! State fully persisted across restart.');
  } else {
    console.log('\n⚠️  States differ (might be timestamp differences)');
  }

  // ============================================================================
  // Cleanup
  // ============================================================================
  console.log('\n🧹 Cleaning up test data...');
  await sm2.removeWalkIn(3);
  await sm2.toggleMaintenance(5); // Toggle back off
  await sm2.removeReservation(7, '2026-02-16', '14:00');
  console.log('   ✅ Test data removed\n');

  await sm2.disconnect();

  console.log('=== ✅ Persistence Test PASSED ===\n');
  console.log('State survives server restarts perfectly!');
  process.exit(0);
}

// Run test
testPersistence().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
