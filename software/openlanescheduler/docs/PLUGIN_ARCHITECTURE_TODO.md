# Plugin Architecture TODO

## Current Assessment: Modular Monolith — Ready for Extraction

The codebase is **~70% ready** for plugins. The Socket.IO event-driven pattern, Redis/MongoDB data split, and existing MQTT bridge prove the architecture can support independent services. The main gaps are: no plugin registration, hardcoded frontend views, no event contracts, and no auth layer.

---

## Phase 1: Backend Handler Registry

**Goal:** Make action handlers discoverable, versioned, and permission-aware without changing their behavior.

### What exists now

`backend/server.js` ~line 256:
```js
const handlers = {};
handlers.OPEN_WALKIN = async function({ lane, bowlers, walkType, games, hours }, socket) { ... };
```

Invoked at ~line 1086:
```js
socket.on('action', async ({ type, ...payload }) => {
  const handler = handlers[type];
  if (handler) await handler(payload, socket);
});
```

### What to build

Create `backend/src/services/HandlerRegistry.js`:

```js
class HandlerRegistry {
  constructor() {
    this.handlers = new Map();
  }

  register(name, handler, options = {}) {
    const { version = '1.0', permissions = [], source = 'core' } = options;
    if (this.handlers.has(name)) throw new Error(`Handler ${name} already registered`);
    this.handlers.set(name, { handler, version, permissions, source });
  }

  async invoke(name, payload, socket, context = {}) {
    const entry = this.handlers.get(name);
    if (!entry) throw new Error(`Handler ${name} not found`);
    return entry.handler(payload, socket, context);
  }

  list() {
    return Array.from(this.handlers.entries()).map(([name, meta]) => ({
      name, version: meta.version, permissions: meta.permissions, source: meta.source
    }));
  }
}
```

Refactor `server.js` to use the registry — behavior stays identical, but handlers become introspectable.

Add REST endpoint: `GET /api/plugins/handlers` — returns list of registered handlers with versions.

### Files to modify
- `backend/src/services/HandlerRegistry.js` (new)
- `backend/server.js` (refactor handler registration + action listener)

---

## Phase 2: Frontend View Registry

**Goal:** Replace the hardcoded view switch statement with a data-driven registry that supports lazy loading.

### What exists now

`frontend/src/App.jsx` ~line 1310:
```jsx
{view === 'lanes' ? (
  <LanesView />
) : view === 'timeline' ? (
  <TimelineView />
) : view === 'new-reservation' ? (
  <ReservationForm />
) : null}
```

View buttons are also hardcoded in the header.

### What to build

Create `frontend/src/ViewRegistry.jsx`:

```jsx
const viewRegistry = new Map();

export function registerView(id, component, meta = {}) {
  viewRegistry.set(id, { component, ...meta });
}

export function getView(id) { return viewRegistry.get(id); }
export function listViews() { return Array.from(viewRegistry.entries()); }
```

Register built-in views:
```jsx
registerView('lanes', LanesView, { label: 'Lanes', icon: '🎳', order: 0 });
registerView('timeline', TimelineView, { label: 'Timeline', icon: '📅', order: 1 });
registerView('new-reservation', ReservationForm, { label: '+ Reserve', icon: '➕', order: 2 });
```

Render dynamically:
```jsx
const ViewComponent = getView(view)?.component;
{ViewComponent ? <ViewComponent {...props} /> : null}
```

Header buttons auto-generated from registry:
```jsx
{listViews().sort((a,b) => a[1].order - b[1].order).map(([id, meta]) => (
  <Btn key={id} onClick={() => setView(id)} active={view === id}>{meta.label}</Btn>
))}
```

This enables `React.lazy()` for code splitting and lets plugins register views without editing App.jsx.

### Files to modify
- `frontend/src/ViewRegistry.jsx` (new)
- `frontend/src/App.jsx` (refactor view switch + header buttons)

---

## Phase 3: Event Schema Contracts

**Goal:** Define and validate the shape of Socket.IO events so plugins can't silently break each other.

### Problem

No contract exists for what `dispatch('OPEN_WALKIN', data)` expects. If a plugin sends malformed data, the handler fails silently or corrupts state.

### What to build

Create `backend/src/services/EventSchemas.js`:

```js
const schemas = {
  OPEN_WALKIN: {
    version: '1.0',
    required: ['lane', 'bowlers', 'walkType'],
    fields: {
      lane: 'number',
      bowlers: 'number',
      walkType: 'string',  // 'hourly' | 'per-game'
      games: 'number',     // required if walkType === 'per-game'
      hours: 'number',     // required if walkType === 'hourly'
    }
  },
  // ... one per handler
};

function validate(type, payload) {
  const schema = schemas[type];
  if (!schema) return { valid: true }; // Unknown events pass through
  for (const field of schema.required) {
    if (payload[field] === undefined) return { valid: false, error: `Missing: ${field}` };
  }
  return { valid: true };
}
```

Wire into the action listener:
```js
socket.on('action', async ({ type, ...payload }) => {
  const result = validate(type, payload);
  if (!result.valid) {
    socket.emit('error', { type: 'validation', message: result.error });
    return;
  }
  await registry.invoke(type, payload, socket);
});
```

### Files to modify
- `backend/src/services/EventSchemas.js` (new)
- `backend/server.js` (add validation before handler invoke)

---

## Phase 4: Plugin Manifest System

**Goal:** Plugins declare their requirements in a manifest. The system validates dependencies, allocates resources, and manages lifecycle.

### Directory structure

```
backend/
  plugins/
    league-nights/
      plugin.json          ← manifest
      handlers.js          ← Socket.IO handlers
      routes.js            ← REST endpoints (optional)
      collections.js       ← MongoDB collection setup (optional)
    analytics/
      plugin.json
      handlers.js
      routes.js
```

### Manifest format

```json
{
  "id": "league-nights",
  "version": "1.0.0",
  "name": "League Night Manager",
  "description": "Team scoring, standings, and league scheduling",
  "handlers": {
    "CREATE_LEAGUE_SEASON": { "version": "1.0", "permissions": ["write:leagues"] },
    "LEAGUE_RECORD_SCORE": { "version": "1.0", "permissions": ["write:leagues"] },
    "GET_LEAGUE_STANDINGS": { "version": "1.0", "permissions": ["read:leagues"] }
  },
  "collections": ["league_seasons", "league_teams", "league_games"],
  "subscribes": ["RESERVATION_CREATED", "WALK_IN_OPENED"],
  "publishes": ["LEAGUE_GAME_STARTED", "LEAGUE_STANDINGS_UPDATED"],
  "dependencies": [],
  "config": {
    "MAX_TEAMS_PER_LEAGUE": { "type": "number", "default": 16 }
  }
}
```

### Plugin loader

Create `backend/src/services/PluginLoader.js`:

```js
class PluginLoader {
  constructor(registry, mongoManager) { ... }

  async loadAll(pluginsDir) {
    // Scan for plugin.json files
    // Validate manifests
    // Resolve dependencies (topological sort)
    // Initialize MongoDB collections
    // Register handlers
    // Register REST routes
  }

  async unload(pluginId) {
    // Deregister handlers
    // Clean up subscriptions
  }
}
```

### Files to create
- `backend/plugins/` directory
- `backend/src/services/PluginLoader.js`
- One reference plugin extracted from existing code (mechanics is a good candidate)

---

## Phase 5: Hardcoded Colors & Overlays (Pre-requisite for Plugin UIs)

These would break any plugin that renders UI. Fix before Phase 2.

| Location | Issue | Fix |
|----------|-------|-----|
| `App.jsx` ~line 696 | `rgba(0, 180, 255, ...)` hardcoded week intensity | Use `rgba(var(--ll-blue-rgb), ...)` |
| `App.jsx` ~line 970 | `rgba(0, 0, 0, 0.7)` modal overlay | Use `C.overlayBg` (already in palette) |
| `kiosk/src/LunarLanesKiosk.jsx` | `#555`, `rgba(0,0,0,0.9)`, `rgba(255,255,255,...)` in CSS `<style>` | Use `var(--ll-*)` CSS custom properties |

See `frontend/src/THEMING_TODO.md` for full details.

---

## Phase 6: Authentication Layer (Required Before External Plugins)

**Not needed for internal/trusted plugins**, but required before any plugin touches external data or user input.

### Minimal approach

- JWT tokens issued per connection role (manager, kiosk, mechanic, plugin)
- Middleware validates token on Socket.IO connect
- Handler permissions checked against token claims
- REST endpoints require Bearer token

### Scope

This is a larger effort — defer until external-facing plugins are needed.

---

## Plugin Feasibility by Scenario

| Plugin | Effort | Blocked By | Notes |
|--------|--------|------------|-------|
| **Analytics** | Easy | Nothing | Read-only, uses existing MongoDB data |
| **Digital Signage** | Easy | Nothing | Stateless display, new route |
| **League Nights** | Medium | Phase 1-2 | New handlers + frontend view + MongoDB collections |
| **Customer Loyalty** | Medium | Phase 1-2 | Needs ReservationForm modification |
| **POS** | Hard | Phase 1-4, 6 | Separate SPA, external payment API, auth required |

---

## Existing Patterns to Preserve

These are **already good** and should be the foundation for plugin architecture:

1. **Socket.IO action dispatch** — `dispatch('TYPE', payload)` is the universal interface. Plugins should use the same pattern.
2. **Redis for real-time, MongoDB for persistence** — plugins choose the right store for their data type.
3. **MQTT bridge pattern** (`mqtt-bridge/index.js`) — reference implementation for an external service that communicates via Socket.IO. New microservices should follow this.
4. **Delta state broadcasts** — `broadcastUpdate('TYPE', data)` sends targeted updates, not full state. Plugins should emit their own update types.
5. **Mechanics route isolation** — `/mechanic` is a separate route with its own sub-view system. New plugin UIs should follow this pattern.
6. **`useColors()` / `useCompact()` hooks** — plugin UIs must use these for theme and responsive compat.

---

## Files Reference

### Core backend (modify in phases 1, 3)
- `backend/server.js` — handler registration, action listener, state broadcast
- `backend/src/services/StateManager.js` — Redis state operations
- `backend/src/services/MongoManager.js` — MongoDB wrapper

### Core frontend (modify in phase 2)
- `frontend/src/App.jsx` — view switch, header buttons
- `frontend/src/shared.js` — useSocket hook, constants

### Reference external service
- `mqtt-bridge/index.js` — Socket.IO client connecting to backend from separate service

### Infrastructure
- `docker-compose.yml` — service definitions, ports, networks

---

## Implementation Order

```
Phase 5 (hardcoded fixes)     ← smallest, unblocks plugin UIs
  ↓
Phase 1 (handler registry)    ← foundation for backend plugins
  ↓
Phase 3 (event schemas)       ← contracts for handler safety
  ↓
Phase 2 (view registry)       ← foundation for frontend plugins
  ↓
Phase 4 (manifest system)     ← full plugin lifecycle
  ↓
Phase 6 (auth)                ← only when external plugins needed
```
