/**
 * PM (Preventative Maintenance) Templates
 *
 * Based on Brunswick A2 pinsetter maintenance schedules and general
 * bowling equipment maintenance best practices.
 *
 * Note: These are generic templates based on industry standards.
 * For official Brunswick A2 maintenance schedules, consult the
 * Brunswick A2 Pinsetter Service Manual.
 */

const pmTemplates = {
  // ============================================================================
  // Brunswick A2 Templates
  // ============================================================================

  'brunswick-a2-daily': {
    id: 'brunswick-a2-daily',
    equipmentType: 'brunswick-a2',
    category: 'daily',
    title: 'Daily Pinsetter Inspection',
    description: 'Daily opening checks for Brunswick A2 pinsetter per maintenance best practices',
    checklistItems: [
      {
        task: 'Visual inspection of pin deck',
        procedure: 'Check for debris, damaged pins, proper pin spotting alignment',
        estimatedMinutes: 3,
        critical: true
      },
      {
        task: 'Verify sweep operation',
        procedure: 'Observe full sweep cycle, check for smooth operation and proper positioning',
        estimatedMinutes: 2,
        critical: true
      },
      {
        task: 'Inspect cushion condition',
        procedure: 'Check rear cushion and kickback cushions for wear or damage',
        estimatedMinutes: 2,
        critical: false
      },
      {
        task: 'Check pin elevator operation',
        procedure: 'Ensure pins are lifting smoothly without jamming',
        estimatedMinutes: 2,
        critical: true
      },
      {
        task: 'Verify spotting cups',
        procedure: 'Check that all spotting cups are properly aligned and functioning',
        estimatedMinutes: 2,
        critical: true
      }
    ],
    frequency: 'daily',
    estimatedDuration: 660000, // 11 minutes total
    priority: 'high',
    perLane: true,
    manualReference: 'Brunswick A2 Service Manual - Daily Maintenance'
  },

  'brunswick-a2-weekly': {
    id: 'brunswick-a2-weekly',
    equipmentType: 'brunswick-a2',
    category: 'weekly',
    title: 'Weekly Pinsetter Maintenance',
    description: 'Weekly preventative maintenance for Brunswick A2 pinsetter',
    checklistItems: [
      {
        task: 'Lubricate sweep',
        procedure: 'Apply lubricant to sweep pivot points and bearings',
        estimatedMinutes: 5,
        critical: true
      },
      {
        task: 'Clean pin elevator',
        procedure: 'Remove debris and buildup from pin elevator mechanism',
        estimatedMinutes: 8,
        critical: true
      },
      {
        task: 'Inspect drive belts',
        procedure: 'Check belt tension and condition, adjust or replace if needed',
        estimatedMinutes: 5,
        critical: true
      },
      {
        task: 'Check sensor alignment',
        procedure: 'Verify all pinsetter sensors are properly aligned and functioning',
        estimatedMinutes: 7,
        critical: true
      },
      {
        task: 'Lubricate distributor',
        procedure: 'Apply lubricant to pin distributor moving parts',
        estimatedMinutes: 5,
        critical: false
      },
      {
        task: 'Clean and inspect pit',
        procedure: 'Remove debris from pit area, check for loose parts',
        estimatedMinutes: 10,
        critical: false
      }
    ],
    frequency: 'weekly',
    estimatedDuration: 2400000, // 40 minutes total
    priority: 'high',
    perLane: true,
    manualReference: 'Brunswick A2 Service Manual - Weekly Maintenance'
  },

  'brunswick-a2-monthly': {
    id: 'brunswick-a2-monthly',
    equipmentType: 'brunswick-a2',
    category: 'monthly',
    title: 'Monthly Pinsetter Inspection',
    description: 'Comprehensive monthly inspection for Brunswick A2 pinsetter',
    checklistItems: [
      {
        task: 'Comprehensive belt inspection',
        procedure: 'Remove and inspect all drive belts, measure tension, replace if worn',
        estimatedMinutes: 15,
        critical: true
      },
      {
        task: 'Deep clean pin deck',
        procedure: 'Thorough cleaning of pin deck surface and spotting area',
        estimatedMinutes: 20,
        critical: true
      },
      {
        task: 'Sweep mechanism adjustment',
        procedure: 'Check and adjust sweep timing, height, and alignment',
        estimatedMinutes: 15,
        critical: true
      },
      {
        task: 'Pin elevator calibration',
        procedure: 'Verify and adjust pin elevator timing and positioning',
        estimatedMinutes: 12,
        critical: true
      },
      {
        task: 'Cushion inspection and replacement',
        procedure: 'Inspect all cushions, replace any showing wear or damage',
        estimatedMinutes: 18,
        critical: false
      },
      {
        task: 'Electrical connections check',
        procedure: 'Inspect all electrical connections, sensors, and wiring',
        estimatedMinutes: 10,
        critical: true
      }
    ],
    frequency: 'monthly',
    estimatedDuration: 5400000, // 90 minutes total
    priority: 'high',
    perLane: true,
    manualReference: 'Brunswick A2 Service Manual - Monthly Maintenance'
  },

  // ============================================================================
  // Lane Conditioning Templates (All Equipment Types)
  // ============================================================================

  'lane-conditioning-daily': {
    id: 'lane-conditioning-daily',
    equipmentType: 'generic',
    category: 'daily',
    title: 'Daily Lane Conditioning',
    description: 'Daily lane oil application and cleaning',
    checklistItems: [
      {
        task: 'Clean lane surface',
        procedure: 'Use lane cleaner to remove oil buildup and debris',
        estimatedMinutes: 8,
        critical: true
      },
      {
        task: 'Apply conditioning oil',
        procedure: 'Run conditioning machine per house pattern specifications',
        estimatedMinutes: 12,
        critical: true
      },
      {
        task: 'Verify oil pattern',
        procedure: 'Check oil pattern consistency and adjust if needed',
        estimatedMinutes: 5,
        critical: true
      }
    ],
    frequency: 'daily',
    estimatedDuration: 1500000, // 25 minutes total
    priority: 'high',
    perLane: true,
    manualReference: 'Industry Standard - Lane Maintenance'
  },

  // ============================================================================
  // Ball Return Templates (All Equipment Types)
  // ============================================================================

  'ball-return-weekly': {
    id: 'ball-return-weekly',
    equipmentType: 'generic',
    category: 'weekly',
    title: 'Weekly Ball Return Maintenance',
    description: 'Weekly cleaning and inspection of ball return system',
    checklistItems: [
      {
        task: 'Clean ball return track',
        procedure: 'Remove debris and buildup from ball return track',
        estimatedMinutes: 10,
        critical: true
      },
      {
        task: 'Inspect lift mechanism',
        procedure: 'Check ball lift operation and adjust if needed',
        estimatedMinutes: 8,
        critical: true
      },
      {
        task: 'Lubricate moving parts',
        procedure: 'Apply lubricant to ball return moving components',
        estimatedMinutes: 7,
        critical: false
      },
      {
        task: 'Check sensors',
        procedure: 'Verify ball detection sensors are functioning properly',
        estimatedMinutes: 5,
        critical: true
      }
    ],
    frequency: 'weekly',
    estimatedDuration: 1800000, // 30 minutes total
    priority: 'medium',
    perLane: true,
    manualReference: 'Industry Standard - Ball Return Maintenance'
  },

  // ============================================================================
  // Generic Templates (Non-Brunswick Equipment)
  // ============================================================================

  'generic-daily': {
    id: 'generic-daily',
    equipmentType: 'generic',
    category: 'daily',
    title: 'Daily Pinsetter Check',
    description: 'Generic daily pinsetter inspection',
    checklistItems: [
      {
        task: 'Visual inspection',
        procedure: 'Check for obvious issues, debris, or damage',
        estimatedMinutes: 5,
        critical: true
      },
      {
        task: 'Test cycle operation',
        procedure: 'Run test cycle to verify basic functionality',
        estimatedMinutes: 3,
        critical: true
      }
    ],
    frequency: 'daily',
    estimatedDuration: 480000, // 8 minutes total
    priority: 'high',
    perLane: true,
    manualReference: 'Generic Maintenance Best Practices'
  },

  'generic-weekly': {
    id: 'generic-weekly',
    equipmentType: 'generic',
    category: 'weekly',
    title: 'Weekly Pinsetter Maintenance',
    description: 'Generic weekly pinsetter preventative maintenance',
    checklistItems: [
      {
        task: 'Clean and lubricate',
        procedure: 'Clean moving parts and apply appropriate lubricant',
        estimatedMinutes: 15,
        critical: true
      },
      {
        task: 'Inspect components',
        procedure: 'Check belts, sensors, and mechanical components',
        estimatedMinutes: 10,
        critical: true
      }
    ],
    frequency: 'weekly',
    estimatedDuration: 1500000, // 25 minutes total
    priority: 'high',
    perLane: true,
    manualReference: 'Generic Maintenance Best Practices'
  }
};

/**
 * Get templates for a specific equipment type
 */
function getTemplatesForEquipment(equipmentType) {
  return Object.values(pmTemplates).filter(t =>
    t.equipmentType === equipmentType || t.equipmentType === 'generic'
  );
}

/**
 * Get templates by frequency (daily, weekly, monthly)
 */
function getTemplatesByFrequency(frequency, equipmentType = 'generic') {
  return Object.values(pmTemplates).filter(t =>
    t.frequency === frequency &&
    (t.equipmentType === equipmentType || t.equipmentType === 'generic')
  );
}

/**
 * Get a specific template by ID
 */
function getTemplate(templateId) {
  return pmTemplates[templateId] || null;
}

module.exports = {
  pmTemplates,
  getTemplatesForEquipment,
  getTemplatesByFrequency,
  getTemplate
};
