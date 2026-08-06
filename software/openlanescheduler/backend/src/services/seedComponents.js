const MongoManager = require('./MongoManager');

/**
 * Seed default component inventory
 * Run this script once to populate initial inventory in MongoDB
 */
async function seedComponents() {
  const mongoManager = new MongoManager(process.env.MONGODB_URL || 'mongodb://localhost:27017');

  try {
    await mongoManager.init();
    console.log('[Seed] Connected to MongoDB');

    // Check if components already exist
    const existing = await mongoManager.getComponents();
    const forceOverwrite = process.argv.includes('--force');

    if (existing.length > 0 && !forceOverwrite) {
      console.log('[Seed] Components already seeded. Skipping...');
      console.log('[Seed] Use --force flag to overwrite existing components');
      await mongoManager.disconnect();
      return;
    }

    if (forceOverwrite) {
      console.log('[Seed] Force flag detected. Overwriting existing components...');
    }

    // Default component inventory
    const defaultComponents = {
      'pins-white': {
        name: 'White Bowling Pins',
        quantity: 100,
        minStock: 80,
        category: 'pins',
        unit: 'pieces'
      },
      'belt-drive-small': {
        name: 'Drive Belt (Small)',
        quantity: 5,
        minStock: 3,
        category: 'mechanical',
        unit: 'pieces'
      },
      'belt-drive-large': {
        name: 'Drive Belt (Large)',
        quantity: 8,
        minStock: 5,
        category: 'mechanical',
        unit: 'pieces'
      },
      'motor-pinsetter': {
        name: 'Pinsetter Motor',
        quantity: 2,
        minStock: 1,
        category: 'mechanical',
        unit: 'pieces'
      },
      'sensor-pinsetter': {
        name: 'Pinsetter Sensor',
        quantity: 4,
        minStock: 2,
        category: 'electronics',
        unit: 'pieces'
      },
      'sensor-ball-return': {
        name: 'Ball Return Sensor',
        quantity: 3,
        minStock: 1,
        category: 'electronics',
        unit: 'pieces'
      },
      'lane-oil-bottle': {
        name: 'Lane Conditioning Oil (Bottle)',
        quantity: 12,
        minStock: 6,
        category: 'supplies',
        unit: 'bottles'
      },
      'cleaner-ball-return': {
        name: 'Ball Return Cleaner',
        quantity: 8,
        minStock: 4,
        category: 'supplies',
        unit: 'bottles'
      },
      'cleaning-pads': {
        name: 'Lane Cleaning Pads',
        quantity: 50,
        minStock: 20,
        category: 'supplies',
        unit: 'pieces'
      },
      'lubricant-spray': {
        name: 'Mechanical Lubricant',
        quantity: 6,
        minStock: 3,
        category: 'supplies',
        unit: 'cans'
      }
    };

    await mongoManager.setComponents(defaultComponents);

    console.log('[Seed] Successfully seeded component inventory to MongoDB:');
    console.log(`  - ${Object.keys(defaultComponents).length} component types`);
    console.log('  - Categories: pins, mechanical, electronics, supplies');

    // Print summary by category
    const categories = {};
    for (const [id, comp] of Object.entries(defaultComponents)) {
      if (!categories[comp.category]) {
        categories[comp.category] = [];
      }
      categories[comp.category].push(comp.name);
    }

    console.log('\nComponents by category:');
    for (const [cat, items] of Object.entries(categories)) {
      console.log(`  ${cat.toUpperCase()}:`);
      items.forEach(item => console.log(`    - ${item}`));
    }

    await mongoManager.disconnect();
    console.log('\n[Seed] Done!');
  } catch (error) {
    console.error('[Seed] Error:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  seedComponents();
}

module.exports = seedComponents;
