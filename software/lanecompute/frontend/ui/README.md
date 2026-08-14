# openlanelink UI — developer guide

React front end for the three lane-side screens served by the compute node.
Start here; `API.md` is the exhaustive prop/theme reference and `HANDOFF.md`
is the narrative history and known-gaps list.

```
npm install
npm run dev      # vite dev server, :5173
npm run build    # production bundle -> dist/
```

The backend must be running separately — see
`../../backend/state_machine/README.md`:

```
cd ../../backend/state_machine && uv sync && LANE_NUMBERS=7,8 uv run main.py
```

`VITE_BACKEND_URL` overrides where the UI looks for it. Unset, it uses
`<page protocol>//<page hostname>:8000`, which is correct when the UI and
the API are served from the same Pi.

---

## 1. Routes

Each physical device is pointed at exactly one URL and never navigates.

| Route | Screen | Orientation |
|---|---|---|
| `/display/:laneId` | Overhead monitor | 16:9 landscape |
| `/kiosk/:laneId` | Bowler terminal on the lane console | portrait or landscape |
| `/control/:laneId` | Staff scoresheet / correction tablet | 9:16 portrait |
| `/` | Dev-only launcher listing every lane | — |

`:laneId` must be one of the backend's `LANE_NUMBERS`; anything else gets a
WebSocket close with code 4404.

---

## 2. How data flows

One rule governs everything here: **the compute node is authoritative, the
UI renders what it is given.**

```
          WebSocket  /ws/display/{lane}      (read-only, state + events)
 backend  ───────────────────────────────▶  useLaneFeed  ──▶  screens
          ◀───────────────────────────────
             REST  /api/lanes/{lane}/…       (every mutation)
```

- **The socket never carries commands.** It is a broadcast of lane state.
  Every mutation is a REST call, so a script or a future siteserver bus can
  do exactly what the kiosk does through the same surface.
- **Never re-derive what the backend states.** `totalScore`, `currentFrame`,
  `currentBall`, `currentBowlerId`, `runningTotal` are explicit fields. Do
  not scan `frames` to recompute them. If you need a number that is not
  there, add it to the backend snapshot rather than deriving it in a
  component — that duplication is what `lib/scoring.js` was cut down to
  avoid, and it will silently disagree with the server for no-tap and
  duckpin.
- `lib/scoring.js` may only ever *choose between* or *format* values the
  backend already sent (`ballGlyph`, `displayTotal`, `countStrikes`).

### useLaneFeed

```js
const { lane, actions } = useLaneFeed(laneId);
```

Opens the socket, auto-reconnects every 3s, and exposes the REST verbs.
It **starts no games by itself** — an idle lane waits to be activated and
every game after the first is a deliberate call.

**Every action resolves to `{ ok: true, data }` or `{ ok: false, error }`
and never rejects**, so a caller cannot produce an unhandled rejection by
forgetting a `.catch()`. `error` is the backend's own `detail` string and
is fit to show a user.

---

## 3. JSON payloads

### 3.1 WebSocket, server → client

```json
{ "type": "state", "lane": 7, "data": { /* Lane snapshot, §3.2 */ } }
{ "type": "event", "lane": 7, "event": "ball_speed",              "data": { "mph": 14.2, "intervalMs": 812 } }
{ "type": "event", "lane": 7, "event": "assistance_requested",    "data": { "id": "a1b2", "kind": "problem", "reason": "pin jam" } }
{ "type": "event", "lane": 7, "event": "assistance_resolved",     "data": { "id": "a1b2", "kind": "problem" } }
{ "type": "event", "lane": 7, "event": "lane_activated",          "data": { "sessionId": "9f3c", "source": "kiosk", "gameStarted": true } }
{ "type": "event", "lane": 7, "event": "lane_deactivated",        "data": {} }
{ "type": "event", "lane": 7, "event": "turn_set",                "data": { "bowlerId": "3a32" } }
{ "type": "event", "lane": 7, "event": "pinsetter_cycle_requested" | "pinsetter_rerack_requested", "data": {} }
```

Every event is followed by a full `state` broadcast. **Events are for the
log and animation layers only** — never derive session or assistance state
from them; read `lane.session` / `lane.assistance`.

A new client receives a `state` message immediately on connect, so no
screen has to wait for the next mutation to render.

### 3.2 `Lane`

What `useLaneFeed` returns as `lane`, and what `DisplayLane`'s `lane` prop
expects. Fields marked ◆ are added client-side, not sent by the server.

```ts
{
  laneId: string | number,        // ◆
  bowlers: Bowler[],              // roster order
  maxBowlers: number,             // backend-owned capacity; never hardcode 12
  gameType: string | null,        // "ten_pin" | "no_tap" | "duckpin"; null before
                                  // the session's FIRST game
  gameEnded: boolean,             // scoresheet closed by "End game" — still
                                  // readable, just not taking balls
  machineState: "IDLE" | "READY" | "BALL_IN_FLIGHT" | "AWAITING_PINFALL"
              | "PINSETTER_BUSY" | "GAME_COMPLETE",
  currentBowlerId: string | null,
  active: boolean,                // is this lane in play (has a live session)?
                                  // branch on THIS, never on `session != null`,
                                  // which stays truthy after a session ends
  session: Session | null,        // §3.4
  assistance: AssistanceRequest[],// OPEN requests only; §3.5
  awaitingStaff: boolean,         // a *problem* is open — the thing that holds
                                  // the clock. A pending server call leaves it false
  turnSetSeq: number,             // ◆ bumped when someone SET the turn, vs it
                                  // advancing because a ball was thrown
  ballSpeed: number | null,       // mph, most recent delivery
  connected: boolean,             // ◆ is the socket open
  events: LaneEvent[],            // ◆ newest first, capped at 6, client-synthesized
}
```

`LaneEvent`: `{ ts: "HH:MM:SS", type: "strike"|"alert"|"sys"|"", msg: string }`

### 3.3 `Bowler` and `Frame`

```ts
{
  id: string,                  // backend-assigned, stable across reconnect —
                               // safe as a React key
  name: string,
  handicap: number,            // pins added to level a handicap game; 0 = scratch
  totalScore: number,          // SCRATCH total
  totalWithHandicap: number,   // totalScore + handicap
  currentFrame: number | null, // 1-indexed; null once THIS bowler's game is done
  currentBall: number | null,  // 1-indexed ball within currentFrame
  frames: Frame[],             // length = gameType's frame count (10 today)
}
```

```ts
// Frame — straight from game_state.py's score_game()
{
  frame: number,                 // 1-indexed
  balls: number[],               // raw pin counts thrown, e.g. [10], [4,2], []
  complete: boolean,             // fully resolved (bonus balls landed)
  turnOver: boolean,             // done taking balls — NOT the same as `complete`
                                 // for a strike/spare awaiting bonus balls
  frameScore: number | null,     // null until complete
  runningTotal: number | null,   // cumulative, null until complete. ALWAYS
                                 // scratch — handicap never enters frame maths
  pinMasks: (number | null)[],   // index-aligned with `balls`; bit N-1 = pin N.
                                 // null = no per-pin detail for that ball
}
```

**Which total to show:** `displayTotal(bowler)` from `lib/scoring.js` —
handicapped where a handicap exists, scratch otherwise. Every screen uses
it so they cannot disagree about who is winning. Always render the `+N`
alongside: two bowlers on the same number are not tied if one carries 40
pins.

**`pinMasks` is null more often than you'd expect** — a foul, a bare-count
entry, a correction sent without detail. Treat null as *unknown*, never as
"nothing fell". `pinsDownBefore()` in
`components/shared/scoresheet/useBallCorrection.js` does this correctly and
returns `null` rather than an empty set when it cannot know.

### 3.4 `Session`

A session is the lane being sold. It spans many games; only
activate/deactivate begin and end one.

```ts
{
  id: string,
  mode: "timed" | "games",
  source: "kiosk" | "siteserver" | "api",
  startedAtMs: number,
  endedAtMs: number | null,
  ended: boolean,
  durationMs: number | null,      // timed only, INCLUDING extensions
  endsAtMs: number | null,        // timed only
  remainingMs: number | null,     // timed only, floored at 0
  expired: boolean,
  gamesPurchased: number | null,  // games mode only, including extensions
  gamesStarted: number,
  gamesRemaining: number | null,
  extensions: number,
  paused: boolean,                // clock HELD (a problem is open)
  pausedAtMs: number | null,
  pausedTotalMs: number,
}
```

**Rendering the countdown** — get this wrong and the clock lies:

- **Held** (`paused`): render `remainingMs` verbatim. The backend freezes
  it; it is the only field that holds still.
- **Running**: count down to `endsAtMs`. Do **not** subtract elapsed time
  from `durationMs` locally — every second spent held pushes `endsAtMs`
  later, which is the behaviour you want and exactly what local
  accumulation gets wrong.
- **Games mode**: no clock at all. Show `gamesRemaining`.

### 3.5 `AssistanceRequest`

```ts
{
  id: string,
  kind: "problem" | "service",  // problem holds the session clock; service doesn't
  reason: string | null,
  requestedAtMs: number,
  resolvedAtMs: number | null,
  open: boolean,
}
```

### 3.6 Actions (REST)

All are `useLaneFeed().actions.*`, all resolve to `{ ok, data | error }`.

| Action | REST |
|---|---|
| `activateLane({mode?, minutes?, games?, bowlers?})` | `POST /activate` — opens the session. Starts the first game **only if `bowlers` is given**; the kiosk omits it and lands in the "who's playing" step |
| `deactivateLane()` | `POST /deactivate` — ends the session, clears roster/scoresheet/open calls |
| `extendSession({minutes?, games?})` | `POST /session/extend` — which one applies is decided by the session's mode |
| `startGame()` | `POST /games` — the *next* scoresheet only |
| `endGame()` | `POST /games/end` — keeps roster, scores and session |
| `addBowler(name, handicap?)` | `POST /bowlers` — 409 at `lane.maxBowlers` |
| `renameBowler(id, name)` | `PUT /bowlers/{id}` |
| `setHandicap(id, handicap)` | `PUT /bowlers/{id}/handicap` |
| `removeBowler(id)` | `DELETE /bowlers/{id}` |
| `setCurrentBowler(id)` | `PUT /turn` — 409 if no game, not in the rotation, or already finished |
| `correctBall(bowlerId, frameIdx, ballIdx, pins, pinMask?)` | `PUT /bowlers/{id}/score` — **0-indexed here**, translated to the backend's 1-indexed `{frame_number, ball_in_frame}` inside `useLaneFeed` |
| `requestAssistance(kind, reason?)` | `POST /assistance` |
| `resolveAssistance(id)` | `POST /assistance/{id}/resolve` |
| `cyclePinsetter()` / `rerackPinsetter()` | `POST /pinsetter/cycle` · `/rerack` — **503 when the gateway link is down**, the failure users actually hit |

`correctBall` overwrites a recorded ball **or records the next one in a
frame**. A frame the bowler has not reached 400s — which is why the kiosk's
frame list only enables frames with balls or the bowler's `currentFrame`.
Send `pinMask` whenever you know which pins fell; it is what lets a later
ball in the same frame grey out pins already down.

---

## 4. Component props

Only `DisplayLane` is presentational. `KioskLane` and `ControlLane` are
route components that call `useParams()` and `useLaneFeed()` themselves and
take **no props** — they cannot be driven by hand-authored mock data
without splitting out a container first.

### `DisplayLane`

| Prop | Type | Req | Default | Notes |
|---|---|---|---|---|
| `laneId` | `string \| number` | ✓ | — | Display only |
| `lane` | `Lane` | ✓ | — | §3.2 |
| `theme` | `string \| object` | | `"midnight-arcade"` | See `API.md` §2 |
| `activeTakeover` | `Takeover \| null` | | `null` | Currently forced to `null` — see below |
| `tickerMessages` | `{id, text, color?}[]` | | `[]` | Merged with built-in lane stats |
| `tickerEnabled` | `boolean` | | `false` | Ticker claims no space unless true |
| `celebrationAssets` | `{[event]: url}` | | theme's | `.webm` with alpha |
| `tickerLead` | `ReactNode` | | — | Left of the bottom ticker strip (the sponsor slot); the layout fixes its box |
| `children` | `ReactNode` | | — | Slot above the scores (stats panel) |

**Takeovers are disabled** (`TAKEOVERS_ENABLED = false` in
`DisplayLanePage`). The schedule behind them is a mock with no backend, so
what it did in practice was cover a live scoreboard with invented adverts.
The path is intact, just not fed.

### Kiosk (`components/kiosk/`)

| Component | Props |
|---|---|
| `SessionClock` | `session`, `active`, `held` |
| `RosterModal` | `bowlers`, `maxBowlers`, `currentBowlerId`, `startMode?`, `onAdd`, `onRename`, `onHandicap`, `onRemove`, `onSetTurn?`, `onStartGame?`, `onEndSession?`, `onClose` |
| `RosterSummary` | `bowlers`, `currentBowlerId`, `onOpen` — one line in portrait, full standings in landscape |
| `ScoreEditModal` | `bowlers`, `currentBowlerId`, `selectedBowler`, `onPickBowler`, `onPickFrame`, `onBack`, `onClose` |
| `PinPickerModal` | `bowler`, `frameIdx`, `onCommit`, `onClose` |
| `ActionButton` | `glyph`, `label`, `sublabel?`, `accent?: {fill, ink}`, `disabled?`, `onClick` |
| `Modal` / `ModalButton` | `title`, `onClose`, `footer?`, `maxWidth?`, `zIndex?` |
| `TextPromptModal` / `NumberPadModal` / `ConfirmModal` / `AddBowlerModal` | see `Modals.jsx` |
| `Toasts` + `useToasts()` | `report(promise, okMessage)` is the standard "fire an action, toast the outcome" helper |

`accent` takes a `{fill, ink}` **pair** so a caller cannot put unreadable
text on a coloured fill in one of the two schemes.

---

## 5. Conventions worth not breaking

- **The kiosk has its own theme** (`components/kiosk/theme.jsx`), on CSS
  variables, light and dark. Not `lib/theme.js` — those tokens are built
  for a monitor read from thirty feet in a dark room and are about 2:1 at
  arm's length. It is flat throughout (fill + 1px border, never a shadow
  pair); shadows lift modals and nothing else.
- **Responsive behaviour is CSS, not JS.** A kiosk can be rotated after
  boot. Use media/container queries. `useTwoColumn()` exists only for
  components that change *shape* rather than size, and reads the same
  `TWO_COLUMN_QUERY` constant the CSS does.
- **Size against the container, not the viewport,** for anything in the
  landscape rail. The clock's type and the action grids use container
  queries; a `vmin` that looked right full-width overflowed a 320px rail.
- **Colours come from tokens.** Never append an alpha suffix to a `var()`
  (`` `${K.danger}66` ``) — it produces an invalid colour and the whole
  declaration is silently dropped. Add a pre-mixed token instead.
- **Bowler `id` is stable across reconnects**; use it as the React key.
- Layout floors and caps live in named constants (`MIN_COMPONENT_VH`,
  `MAX_BOWLER_SHEET_VH`, `STATS_SLOT_VH`, `FRAME_LABEL_CLEARANCE_VH`), not
  scattered literals. `HANDOFF.md` records which are product rules.

## 6. Known gaps

See `HANDOFF.md` for the full list. The ones most likely to bite:

- **No `game_type` picker anywhere** — every game is ten-pin, though the
  backend supports no-tap and duckpin.
- **Frame-box rendering assumes ten-pin's 2-then-3 ball shape**, so duckpin
  (3 balls per regular frame) under-renders.
- **The kiosk trusts whoever is standing at it** — no staff gate on ending
  a session, extending time, or clearing a call.
- **`useTakeoverFeed` is a mock**; there is no ad-scheduling backend.
- **Both tablet screens are still on the old theme system.**
