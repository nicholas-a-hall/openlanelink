# openlanelink UI — component API & data model

Companion to `HANDOFF.md` (architecture/gotchas/history). This doc is the
formal reference: every prop a component accepts, the full theme token
set, and the exact data shapes a real backend needs to produce and
consume. Written so this UI can be developed against **without** the
dummy hooks running — hand-author objects matching the shapes below and
pass them straight into the presentational components.

All shapes here are current as of the code in `src/` — if you change a
shape, update this file in the same commit.

---

## 1. Component props

### `DisplayLane` (`components/display/DisplayLane.jsx`)

The 16:9 overhead-monitor screen for **one lane**. Pure presentational —
takes no data from context, fetches nothing, reads no route params. Every
render is a pure function of these props.

| Prop | Type | Required | Default | Notes |
|---|---|---|---|---|
| `laneId` | `string \| number` | yes | — | Display-only (shown in the topbar) |
| `lane` | [`Lane`](#lane) | yes | — | Full game-state snapshot, see below |
| `theme` | `string \| object \| { preset, overrides }` | no | `"midnight-arcade"` | See [§2 Theming](#2-theming) |
| `activeTakeover` | [`Takeover`](#takeover)`\| null` | no | `null` | See [§3.3](#33-takeover) |
| `tickerMessages` | `{ id, text, color?: 'accent'\|'warn' }[]` | no | `[]` | Merged with two built-in lane-stat items |
| `tickerEnabled` | `boolean` | no | `false` | Ticker renders nothing at all (no layout space claimed) unless true |
| `celebrationAssets` | `{ [eventType: string]: string }` | no | active theme's `assets.celebrationAssets` | Event type → `.webm` URL (alpha channel). No matching key = no-op. Pass this prop only to override a specific venue's clips without forking the theme — see [§2.7](#27-assets) |
| `children` | `ReactNode` | no | — | Rendered in a slot **below the topbar, above the scorecards**. Each top-level child should be ≥10% of screen height (see [§2.3](#23-layout-constants)). Currently: extended-stats panel + mini-ad |

Layout is otherwise fixed: topbar → `children` slot → bowler scorecards
(queued/paginated internally, see `HANDOFF.md`) → ticker. Two overlay
layers (`CelebrationLayer`, `TakeoverLayer`) sit on top, driven by
`celebrationAssets`/`lane.events` and `activeTakeover` respectively.

### `ControlLane` (`components/control/ControlLane.jsx`)

The 9:16 tablet control screen. **Not presentational** — unlike
`DisplayLane`, it reads `useParams()` and calls `useLaneFeed(laneId)`
itself; it takes no props at all. This is an architectural asymmetry
worth knowing about: `ControlLane` **cannot currently be driven by
hand-authored mock data** the way `DisplayLane` can, short of monkey­
patching `useLaneFeed`. If you need to test it in isolation, the
straightforward fix is splitting it the same way the display side is
split (`ControlLane` presentational + a new `ControlLanePage` container) —
not done yet.

### Display sub-components (reusable individually)

| Component | Props |
|---|---|
| `Ticker` | `items: {id, text, color?}[]`, `enabled?: boolean` (default `false`) |
| `ScoreBug` | `laneId`, `bowlers: Bowler[]`, `activeBowlerId`, `floating?: boolean` |
| `MiniAd` | `ad: { imageUrl, label? } \| null` |
| `EventLog` | `events: LaneEvent[]` |
| `BowlerStatsPanel` | `bowler: Bowler \| null`, `ballSpeed: number \| null` |
| `TakeoverLayer` | `activeTakeover`, `lane`, `laneId`, `activeBowlerId` |
| `CelebrationLayer` | `latestEvent: LaneEvent \| null`, `assets`, `onPlayingChange?: (bool) => void` |

`BowlerSheet` and `BowlerQueue` (inside `DisplayLane.jsx`) are internal —
not exported, not meant to be used standalone.

---

## 2. Theming

`lib/themes.js`. A theme is **four independent, separately-swappable
things** — not just a color palette:

1. **tokens** — colors + fonts (the `T` object)
2. **elevation strategy** — *how* a surface reads as raised/inset/flat.
   Midnight Arcade's dual-tone neumorphic shadows are one theme's
   choice, not a property of "theme" in general — a different theme
   might use flat borders, plain drop shadows, glass blur, anything.
3. **layout policy** — structural choices like how wide the scorecard
   column runs. Midnight Arcade goes edge-to-edge; a broadcast-style
   theme might run a narrower centered column instead. This is not a
   color decision and was previously hardcoded (100% width) directly in
   `DisplayLane.jsx` — it now lives in the theme.
4. **assets** — media/branding belonging to the theme's visual identity:
   celebration clips (event type → webm URL) and the webfont `@import`
   string. Distinct from per-venue *content* (ad creative, ticker promo
   copy), which stays in `useTakeoverFeed`/`DisplayLanePage` — that's
   programming, not identity. See [§2.7](#27-assets).

Nothing in the display tree reads colors, shadows, the scorecard width,
or celebration/font assets from a static import or a hardcoded value —
every component calls `useTheme()` and gets `{ T, elevation, layout,
assets }` for whatever theme is currently in effect via `<ThemeProvider
theme={...}>` (wired automatically inside `DisplayLane`).

### 2.1 Token reference (`T`)

Every preset must define all of these:

| Key | Meaning |
|---|---|
| `bg` | Page/root background |
| `surface` | Base card surface |
| `raised` | Raised element surface (buttons, panels, stat tiles) |
| `inset` | Recessed/inset well background |
| `border`, `border2` | Subtle divider / emphasis divider |
| `shadowD`, `shadowL` | Shadow pair — dark and light. Only meaningful to elevation strategies that use shadows at all (a flat strategy may ignore `shadowL` entirely) |
| `red`, `redDim` | Primary accent (alerts, strikes) + muted variant |
| `yellow`, `yellowDim` | Secondary accent (highlights, active-state) + muted variant |
| `green`, `greenDim` | Positive/good-state accent + muted variant |
| `blue` | Info/active-badge accent |
| `text` | Primary text color |
| `muted` | Dimmed label text |
| `dim` | Very dim / decorative text |
| `fontDisplay`, `fontMono`, `fontUi` | Font stacks — see [§2.5](#25-fonts) |

### 2.2 Elevation strategies (`elevation`)

`useTheme().elevation` is a function: `elevation(variant) => styleObject`,
where `variant` is one of `"card" | "raised" | "inset" | "panel"`. The
returned object owns `background`/`border`/`boxShadow` **together as a
unit** — spread it directly into a component's style, then layer
non-elevation concerns (`borderRadius`, `padding`, layout) on top:

```jsx
const { T, elevation } = useTheme();
<div style={{ ...elevation("card"), borderRadius: 12, padding: 16 }}>
```

Two strategies ship in `ELEVATION_STRATEGIES`:

| Strategy | Look |
|---|---|
| `neumorphic` | Dual-tone soft shadows (`shadowD`/`shadowL`), minimal/no borders — the Midnight Arcade / Daylight look |
| `flat` | Solid background + a visible 1px border, little to no shadow — the Broadcast Flat look |

Add a new one by adding a function to `ELEVATION_STRATEGIES` in
`themes.js` — same signature, `(T) => { card, raised, inset, panel }`.

A component may still override individual properties from the elevation
result for a specific semantic state (e.g. `BowlerSheet` overrides
`border`/`boxShadow` to an accent-red highlight when a bowler is "up",
regardless of which elevation strategy is active — see the code comment
there) — the point is the *base* look is never hardcoded to one strategy.

### 2.3 Layout policy (`layout`)

| Key | Meaning |
|---|---|
| `scorecardWidth` | CSS width of the bowler-scorecard column, e.g. `"100%"` or `"66%"` |
| `scorecardAlign` | `"stretch"` (full-bleed) or `"center"` (narrower, centered) — applied via `alignSelf` on the column-flex wrapper in `DisplayLane.jsx` |

Both the bowler sheets (`BowlerQueue`) and the frame-spotlight overlay
(`FrameSpotlight`) are laid out relative to the *same* width-constrained
wrapper div, so narrowing `scorecardWidth` narrows and keeps them
aligned together automatically — no separate width plumbing needed if
you add a third layout-driven element later.

### 2.4 Presets and overrides (`theme` prop)

`PRESETS` currently ships `"midnight-arcade"` (default, neumorphic,
full-bleed), `"daylight"` (neumorphic, full-bleed, light recolor), and
`"broadcast-flat"` (flat, 66%-width centered — exists specifically to
prove the abstraction: different elevation AND different layout, not
just different colors). Each preset bundles `{ tokens, elevationStrategy,
layout, assets }`. `resolveTheme(theme)` accepts:

```js
theme = "broadcast-flat"                     // named preset — full bundle
theme = { red: "#f00" }                      // flat object (back-compat): token overrides onto the DEFAULT preset, elevation/layout/assets unchanged
theme = { preset: "broadcast-flat", overrides: { red: "#f00" } }        // token overrides onto a NAMED preset
theme = { preset: "broadcast-flat", layout: { scorecardWidth: "50%" } } // can override layout, elevationStrategy, and/or assets too, same shape
theme = { preset: "midnight-arcade", assets: { fontImport: "@import ...;" } } // swap just the theme's fonts, keep its clips
```

**This is also the "create a theme" path** — a venue-specific theme is
just a descriptor object built by hand (or, eventually, by a picker UI);
no entry in `PRESETS` is required unless the look should be a reusable
named built-in. A genuinely new built-in look needs an entry in
`PRESETS` (and, if its elevation treatment is novel, a new function in
`ELEVATION_STRATEGIES`).

### 2.5 Fonts

`FONT_DISPLAY`, `FONT_MONO`, `FONT_UI` (exported from `themes.js`, also
present per-preset as `fontDisplay`/`fontMono`/`fontUi`) are Google Fonts
stacks (Orbitron/Barlow Condensed, JetBrains Mono, Rajdhani).
`GOOGLE_FONTS_IMPORT` is the `@import` string `DisplayLane` injects via a
`<style>` tag — if you build a standalone test harness, you'll need this
import too or text will fall back to system fonts.

### 2.6 Other layout constants (not theme-controlled)

These are display-density *rules*, not per-theme style choices, so they
stay as plain constants rather than living in `layout`:

| Constant | Where | Value | Meaning |
|---|---|---|---|
| `MIN_COMPONENT_VH` | `lib/themes.js` | `10` | Every distinct content block ≥ 10% of screen height |
| `MAX_BOWLER_SHEET_VH` | `DisplayLane.jsx` | `20` | A bowler sheet never exceeds 20% of screen height |
| `MAX_VISIBLE_BOWLERS` | `DisplayLane.jsx` | `6` | Fixed, not measured — see `HANDOFF.md` |
| `REORDER_DELAY_MS` | `DisplayLane.jsx` | `3000` | Minimum pause after a bowler's turn ends before the queue reorders |

### 2.7 Assets

`useTheme().assets` — media/branding owned by the theme itself, as
opposed to per-venue content (ad creative, ticker copy) which stays in
`useTakeoverFeed`/`DisplayLanePage`:

| Key | Type | Meaning |
|---|---|---|
| `celebrationAssets` | `{ [eventType: string]: string }` | Event type → `.webm` URL, consumed by `CelebrationLayer`. All three built-in presets ship `{}` (no clips exist yet — silently a no-op); a theme with real clips attaches them here |
| `fontImport` | `string` | The CSS `@import` string `DisplayLane` injects in its `<style>` tag. All three built-ins currently share `GOOGLE_FONTS_IMPORT`, but nothing requires that — a theme with its own font choices supplies its own string |

`DisplayLane`'s `celebrationAssets` prop, if passed, overrides the active
theme's `assets.celebrationAssets` entirely (not merged key-by-key) — see
[§1](#1-component-props). There is currently no equivalent prop override
for `fontImport`; a custom theme descriptor's `assets.fontImport` is the
only way to change it (see [§2.4](#24-presets-and-overrides-theme-prop)).

---

## 3. Data model — the real backend's contract

`useLaneFeed.js` connects for real to the compute node (`software/lanecompute/backend/scoring`,
see `../../HANDOFF.md`/`README.md` there) — it is **not** mock data anymore.
`useTakeoverFeed.js` is still a mock (see its own docstring): the compute
node has no ad-scheduling backend, only game state.

### 3.1 `Bowler`

```ts
{
  id: string,            // backend-assigned, stable, durable (see note below)
  name: string,
  frames: Frame[],        // see 3.2 — length is gt.frameCount, 10 for every
                           // game type today (ten-pin/no-tap/duckpin)
}
```

**Frame format changed from this doc's original (pre-backend) design.**
It used to be a raw array of pin counts, with running totals/completion
derived client-side. That's gone: scoring is backend-authoritative now
(`state_machine/game_state.py`) and multi-game-type (ten-pin/no-tap/duckpin, see
`state_machine/game_types.py`) — no-tap's relaxed strike threshold and duckpin's
"3rd-ball clear scores flat, no bonus" rule are real scoring-rule
differences a client-side reimplementation would have to duplicate exactly
right to avoid disagreeing with the server. `lib/scoring.js` only derives
presentational values now (ball glyphs, extended stats) from data the
backend already computed — see that file's own docstring.

Each `Frame`, straight from `state_machine/game_state.py`'s `score_game()`:

```ts
{
  frame: number,          // 1-indexed
  balls: number[],        // raw pin counts actually thrown this frame, e.g. [10], [4,2], []
  complete: boolean,      // this frame's score is fully resolved (waited out any bonus balls)
  turnOver: boolean,      // this frame is done taking balls -- NOT the same as `complete` for a
                           // strike/spare, whose score stays unresolved until bonus balls land
                           // from later frames; turnOver is what "whose turn is it" logic uses
  frameScore: number | null,   // this frame's own score, null until `complete`
  runningTotal: number | null, // cumulative through this frame, null until `complete`
}
```

`lib/scoring.js` derives from this array: `ballGlyph` (glyph per ball),
`currentTotal` (most recent resolved `runningTotal`), `gameComplete`
(last frame's `complete`), `nextThrow` (first frame with `turnOver:
false`, and how many balls are in it), `countStrikes`/`countSpares`/
`pinfall` (used by `BowlerStatsPanel`). If a future component needs a
number that isn't already derivable, add the derivation there — don't
compute it locally in the component.

**Bowler `id` stability**: backend-assigned (`game_state.py`'s
`Bowler.id`, a short hex string), stable across a reconnect — safe to use
as the React key driving the bowler-queue's animation identity
(`HANDOFF.md` §"the bowler queue").

### 3.2 `Lane`

The full per-lane game-state snapshot — this is what `useLaneFeed`
returns as `lane`, and what `DisplayLane`'s `lane` prop expects:

```ts
{
  laneId: string | number,
  bowlers: Bowler[],            // roster order; see 3.1
  gameType: string | null,      // e.g. "ten_pin" | "no_tap" | "duckpin" (state_machine/game_types.json), null before a game starts
  machineState: string,         // state_machine/state_machine.py's State enum: "IDLE" | "READY" |
                                 // "BALL_IN_FLIGHT" | "AWAITING_PINFALL" | "PINSETTER_BUSY" | "GAME_COMPLETE"
  currentBowlerId: string | null,   // whose turn it is
  ballSpeed: number | null,     // mph, most recent delivery (from a "ball_speed" WS event)
  connected: boolean,           // is the WebSocket to the compute node currently open
  events: LaneEvent[],          // newest first, capped at 6 -- client-synthesized (see 3.5), not from the backend directly
}
```

Dropped from the original (pre-backend) design, since nothing produces
this data server-side: `maintenance`, `pins`/`flashPins` (pin-deck visuals
— needs `vision/pinfall.py`, not implemented), `alert` (jam detection —
`STATUS_RELAY_FAULT` exists in the mesh protocol but nothing forwards or
acts on it yet), `nightlyPins`/`strikes`/`deliveries`/`stops`/`jams`
(lane-wide session stats — `game_state.py` is per-game, not per-night).
Bring any of these back once the backend actually tracks them.

`LaneEvent`:
```ts
{ ts: string /* "HH:MM:SS" */, type: "strike" | "alert" | "sys" | "", msg: string }
```

### 3.3 `Takeover`

What `useTakeoverFeed` returns as `activeTakeover`, and what
`DisplayLane`'s `activeTakeover` prop expects. `null` = show the normal
scorecard view.

```ts
{
  id: number,                                    // unique per takeover instance
  kind: "ad" | "video" | "message",
  scoreBug?: boolean,                             // override the kind-based default (see below)
  // kind: "ad"
  imageUrl?: string, alt?: string,
  // kind: "video"
  videoUrl?: string, poster?: string, loop?: boolean,  // loop defaults true
  // kind: "message"
  title?: string, subtitle?: string,
}
```

There used to be a `"stats"` kind (lane-wide strike rate/nightly
pinfall/jams, fully replacing the screen). Removed along with the `Lane`
fields it rendered — `game_state.py` is per-game, not per-night, so there
was nothing real to show. Bring it back if that data ever exists
server-side.

Behavior rules a real scheduler must respect (already enforced by the
mock, see `HANDOFF.md`):
- `ad` / `video` / `message` keep a persistent `ScoreBug` underneath
  (scores are never fully hidden by sponsor content) unless `scoreBug`
  explicitly overrides that.
- **`ad`/`video` must only fire when the lane has no active game** — the
  real compute node owns this decision (see `hasActiveGame` in
  `DisplayLanePage.jsx`, currently `bowlers.length > 0 && machineState !==
  "GAME_COMPLETE"`).

### 3.4 Actions (control tablet → backend)

What `useLaneFeed` returns as `actions` — the verbs `ControlLane` calls.
Unlike the WebSocket (3.5, read-only), these are REST calls straight to
`state_machine/api.py`:

| Action | Signature | REST call |
|---|---|---|
| `addBowler` | `(name: string) => void` | `POST /api/lanes/{lane}/bowlers {name}` |
| `removeBowler` | `(id: string) => void` | `DELETE /api/lanes/{lane}/bowlers/{id}` |
| `correctBall` | `(bowlerId, frameIdx, ballIdx, pins) => void` | `PUT /api/lanes/{lane}/bowlers/{id}/score` — `frameIdx`/`ballIdx` stay 0-indexed at this call site (matches `CorrectionModal`'s own indexing) and are translated to the backend's 1-indexed `{frame_number, ball_in_frame, pinfall}` inside `useLaneFeed`, the one place that needs to know about the difference |

`setPinsetterRunning` is gone — it paused the old simulator's fake
delivery interval, which has no real-backend equivalent (no "pause
accepting pinsetter events" endpoint exists, and pausing live hardware
input isn't really a thing). `ControlLane`'s pinsetter-live toggle was
replaced with a real WebSocket connection-status indicator (`lane.connected`)
instead.

Starting a game (`POST /api/lanes/{lane}/games`, optional
`{game_type}`, default `"ten_pin"`) isn't exposed as a user-facing action
at all — `useLaneFeed` calls it automatically: immediately once bowlers
exist on an idle lane, and a few seconds after `machineState` reaches
`GAME_COMPLETE` (product decision — no manual "next game" button today).

### 3.5 WebSocket envelope (as implemented)

One connection per lane: `useLaneFeed` opens `ws://…/ws/display/{laneId}`
(`state_machine/api.py`). Read-only, matching that service's design — REST
(3.4) is the only command path, never the socket.

**Server → client** (`state_machine/api.py`'s exact message shapes):
```json
{ "type": "state", "lane": 7, "data": { /* full Lane snapshot -- game_state.py + state_machine.py, see 3.2 minus laneId/connected/events which the client adds */ } }
{ "type": "event", "lane": 7, "event": "ball_speed", "data": { "mph": 14.2, "intervalMs": 812 } }
{ "type": "event", "lane": 7, "event": "assistance_requested", "data": { "reason": "..." } }
{ "type": "event", "lane": 7, "event": "pinsetter_cycle_requested" | "pinsetter_rerack_requested", "data": {} }
```

There is no `takeover` message type — `useTakeoverFeed` is a fully
separate, still-mocked concern (3.3); nothing server-side schedules
takeovers yet.

`events` (3.2) isn't sent by the server as a list — the client
synthesizes it by diffing successive `state` snapshots (new balls appear
in a bowler's `frames`) plus reacting to `assistance_requested`, capping
at 6 entries. This is cosmetic (`EventLog`/`CelebrationLayer` only); it's
never a source of truth for scoring.

---

## 4. Testing independently (no backend, no dummy hooks)

Because `DisplayLane` is pure and takes everything via props, you can
exercise it with completely static, hand-authored data — useful for
visual QA, screenshot testing, or building out new takeover
kinds/themes without the simulator running or randomizing on you.

```jsx
import DisplayLane from "./components/display/DisplayLane.jsx";

// Hand-author frames in the backend's own shape (3.1) -- a strike in
// frame 1, nothing else thrown yet. Every other frame is the "not bowled
// yet" shape: balls: [], complete: false, turnOver: false, frameScore:
// null, runningTotal: null.
const emptyFrame = (n) => ({ frame: n, balls: [], complete: false, turnOver: false, frameScore: null, runningTotal: null });
const frames = [
  { frame: 1, balls: [10], complete: false, turnOver: true, frameScore: null, runningTotal: null },
  ...Array.from({ length: 9 }, (_, i) => emptyFrame(i + 2)),
];

const lane = {
  laneId: 7,
  bowlers: [{ id: "b1", name: "Test", frames }],
  gameType: "ten_pin", machineState: "READY", currentBowlerId: "b1",
  ballSpeed: 14, connected: true,
  events: [{ ts: "12:00:00", type: "sys", msg: "lane online" }],
};

<DisplayLane laneId={7} lane={lane} theme="daylight" tickerEnabled tickerMessages={[]} />
```

Swap `theme="daylight"` for `theme="broadcast-flat"` to see the flat
elevation strategy and the narrower centered scorecard column in the
same render — useful for confirming a new theme (or a new elevation
strategy) actually plugs in cleanly before wiring it into
`DisplayLanePage`.

Wire this into a throwaway route in `App.jsx` (or a Storybook story, if
one gets added later) to iterate on layout/theming without the
simulator's randomness in the way. `ControlLane` can't be driven this
way yet — see the note in [§1](#controllane-componentscontrolcontrollanejsx).
