const { MongoClient, ObjectId } = require('mongodb');

/**
 * MongoManager - Manages mechanics data persistence in MongoDB
 *
 * Collections:
 * - service_history: Historical service call data
 * - components: Component inventory
 * - component_usage: Component usage log
 * - maintenance_tasks: Maintenance task tracking
 * - pm_config: PM module configuration
 */
class MongoManager {
  constructor(mongoUrl) {
    this.mongoUrl = mongoUrl;
    this.client = null;
    this.db = null;
    this.connected = false;
  }

  /**
   * Initialize MongoDB connection
   */
  async init() {
    try {
      this.client = new MongoClient(this.mongoUrl);
      await this.client.connect();
      this.db = this.client.db('openlanescheduler');
      this.connected = true;
      console.log('[MongoManager] Connected to MongoDB');

      // Create indexes
      await this.createIndexes();
    } catch (err) {
      console.warn('[MongoManager] MongoDB unavailable:', err.message);
      this.client = null;
      this.db = null;
      this.connected = false;
    }
  }

  /**
   * Create indexes for efficient queries
   */
  async createIndexes() {
    if (!this.db) return;

    try {
      // Service history indexes
      await this.db.collection('service_history').createIndex({ startTime: -1 });
      await this.db.collection('service_history').createIndex({ lane: 1, startTime: -1 });
      await this.db.collection('service_history').createIndex({ 'issue.category': 1 });

      // Component indexes
      await this.db.collection('components').createIndex({ componentId: 1 }, { unique: true });
      await this.db.collection('components').createIndex({ category: 1 });

      // Component usage indexes
      await this.db.collection('component_usage').createIndex({ timestamp: -1 });
      await this.db.collection('component_usage').createIndex({ componentRef: 1, timestamp: -1 });

      // Maintenance tasks indexes
      await this.db.collection('maintenance_tasks').createIndex({ status: 1 });
      await this.db.collection('maintenance_tasks').createIndex({ scheduledFor: 1 });
      await this.db.collection('maintenance_tasks').createIndex({ lane: 1 });

      console.log('[MongoManager] Indexes created');
    } catch (err) {
      console.warn('[MongoManager] Error creating indexes:', err.message);
    }
  }

  // ============================================================================
  // Service History
  // ============================================================================

  async addServiceHistory(entry) {
    if (!this.db) return null;
    const collection = this.db.collection('service_history');
    const result = await collection.insertOne({
      ...entry,
      _id: entry.id,
      createdAt: new Date()
    });
    return { ...entry, id: result.insertedId };
  }

  async getServiceHistory(options = {}) {
    if (!this.db) return [];
    const { startTime, endTime, lane, category, limit = 50, offset = 0 } = options;

    const query = {};
    if (startTime || endTime) {
      query.startTime = {};
      if (startTime) query.startTime.$gte = startTime;
      if (endTime) query.startTime.$lte = endTime;
    }
    if (lane) query.lane = lane;
    if (category) query['issue.category'] = category;

    const collection = this.db.collection('service_history');
    const results = await collection
      .find(query)
      .sort({ startTime: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    return results.map(doc => ({
      ...doc,
      id: doc._id
    }));
  }

  async getServiceHistoryCount(options = {}) {
    if (!this.db) return 0;
    const { startTime, endTime } = options;

    const query = {};
    if (startTime || endTime) {
      query.startTime = {};
      if (startTime) query.startTime.$gte = startTime;
      if (endTime) query.startTime.$lte = endTime;
    }

    const collection = this.db.collection('service_history');
    return await collection.countDocuments(query);
  }

  // ============================================================================
  // Component Inventory
  // ============================================================================

  async getComponents() {
    if (!this.db) return [];
    const collection = this.db.collection('components');
    return await collection.find({}).sort({ category: 1, name: 1 }).toArray();
  }

  async setComponents(components) {
    if (!this.db) return;
    const collection = this.db.collection('components');
    await collection.deleteMany({});
    const now = new Date();
    const docs = Object.entries(components).map(([id, comp]) => ({
      componentId: id,
      ...comp,
      createdAt: now,
      updatedAt: now
    }));
    if (docs.length > 0) {
      await collection.insertMany(docs);
    }
  }

  async addComponent(component) {
    if (!this.db) return null;
    const collection = this.db.collection('components');
    const now = new Date();
    const doc = { ...component, createdAt: now, updatedAt: now };
    const result = await collection.insertOne(doc);
    return { _id: result.insertedId, ...doc };
  }

  async findComponentBySlug(componentId) {
    if (!this.db) return null;
    const collection = this.db.collection('components');
    return await collection.findOne({ componentId });
  }

  async updateComponent(id, updates) {
    if (!this.db) return null;
    const collection = this.db.collection('components');
    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return result;
  }

  async updateComponentQuantity(id, quantityChange) {
    if (!this.db) return null;
    const collection = this.db.collection('components');
    const result = await collection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $inc: { quantity: quantityChange }, $set: { updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return result;
  }

  async logComponentUsage(componentRef, componentId, quantity, context) {
    if (!this.db) return;
    const collection = this.db.collection('component_usage');
    await collection.insertOne({
      componentRef: new ObjectId(componentRef),
      componentId,
      quantity,
      timestamp: Date.now(),
      ...context,
      createdAt: new Date()
    });
  }

  async getComponentUsage(componentRef, options = {}) {
    if (!this.db) return [];
    const { startTime, endTime, limit = 50 } = options;

    const query = {};
    if (componentRef) query.componentRef = new ObjectId(componentRef);
    if (startTime || endTime) {
      query.timestamp = {};
      if (startTime) query.timestamp.$gte = startTime;
      if (endTime) query.timestamp.$lte = endTime;
    }

    const collection = this.db.collection('component_usage');
    return await collection
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }

  // ============================================================================
  // Maintenance Tasks
  // ============================================================================

  async getMaintenanceTasks() {
    if (!this.db) return [];
    const collection = this.db.collection('maintenance_tasks');
    const docs = await collection.find({}).sort({ scheduledFor: 1 }).toArray();
    return docs.map(doc => ({
      ...doc,
      id: doc._id
    }));
  }

  async setMaintenanceTasks(tasks) {
    if (!this.db) return;
    const collection = this.db.collection('maintenance_tasks');

    // Clear existing and insert new
    await collection.deleteMany({});
    if (tasks.length > 0) {
      const docs = tasks.map(task => ({
        _id: task.id,
        ...task
      }));
      await collection.insertMany(docs);
    }
  }

  async addMaintenanceTask(task) {
    if (!this.db) return null;
    const collection = this.db.collection('maintenance_tasks');
    const id = task.id || `mt-${Date.now()}`;
    const newTask = {
      _id: id,
      ...task,
      createdAt: new Date()
    };
    await collection.insertOne(newTask);
    return { ...task, id };
  }

  async updateMaintenanceTask(taskId, updates) {
    if (!this.db) return null;
    const collection = this.db.collection('maintenance_tasks');
    const result = await collection.findOneAndUpdate(
      { _id: taskId },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return result ? { ...result, id: result._id } : null;
  }

  async deleteMaintenanceTask(taskId) {
    if (!this.db) return;
    const collection = this.db.collection('maintenance_tasks');
    await collection.deleteOne({ _id: taskId });
  }

  async getMaintenanceTask(taskId) {
    if (!this.db) return null;
    const collection = this.db.collection('maintenance_tasks');
    const doc = await collection.findOne({ _id: taskId });
    return doc ? { ...doc, id: doc._id } : null;
  }

  // ============================================================================
  // PM Configuration
  // ============================================================================

  async getPMConfig() {
    if (!this.db) return { enabled: false, equipmentType: 'generic' };
    const collection = this.db.collection('pm_config');
    const doc = await collection.findOne({ _id: 'config' });
    return doc || { enabled: false, equipmentType: 'generic' };
  }

  async setPMConfig(config) {
    if (!this.db) return;
    const collection = this.db.collection('pm_config');
    await collection.updateOne(
      { _id: 'config' },
      { $set: { ...config, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  async updatePMConfig(updates) {
    if (!this.db) return null;
    const config = await this.getPMConfig();
    const newConfig = { ...config, ...updates };
    await this.setPMConfig(newConfig);
    return newConfig;
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  async disconnect() {
    if (this.client) {
      await this.client.close();
      console.log('[MongoManager] Disconnected from MongoDB');
    }
  }
}

module.exports = MongoManager;
