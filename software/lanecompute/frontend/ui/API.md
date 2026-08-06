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

This is the part that matters for backend design. `useLaneFeed.js` and
`useTakeoverFeed.js` are the **only** two files that currently fake this
data (see `HANDOFF.md`) — everything below is what they produce today,
which is meant to be exactly what a real per-lane connection to the
compute node should provide.

### 3.1 `Bowler`

```ts
{
  id: number,           // stable per-bowler identity (see note below)
  name: string,
  frames: Frame[10],    // see 3.2 — always exactly 10 elements
}
```

**Frame format is the one thing to get exactly right.** Each `Frame` is
an array of *raw pin counts*, one entry per ball actually thrown — never
a running total, never a display glyph. Length varies:

| Situation | Frame value | Notes |
|---|---|---|
| Not bowled yet | `[]` | |
| Frame 1-9, open frame (no strike/spare) | `[a, b]` | e.g. `[4, 2]` |
| Frame 1-9, strike | `[10]` | **length 1**, not `[10, 0]` |
| Frame 1-9, spare | `[a, b]` where `a+b===10` | e.g. `[7, 3]` |
| Frame 1-9, mid-frame (ball 1 thrown, ball 2 not yet) | `[a]` where `a !== 10` | distinguishes from a strike only by value |
| Frame 10, open | `[a, b]` | no bonus ball |
| Frame 10, one strike then open | `[10, a, b]` | 3 balls total |
| Frame 10, spare then bonus | `[a, b, c]` where `a+b===10` | 3 balls total |
| Frame 10, three strikes | `[10, 10, 10]` | |

Running scores, ball glyphs ("X"/"/"/"-"), "whose turn is it", and
extended stats (pinfall, strike count, spare count — used by
`BowlerStatsPanel`) are all **derived** from this array via
`lib/scoring.js` (`scoreGame`, `ballGlyph`, `computeUp`, `nextThrow`,
`gameComplete`, `countStrikes`, `countSpares`, `pinfall`) — never compute
or transmit any of these separately, or the two screens (and any new
component added later) can disagree. `applyBall` is the single mutation
path (immutable — returns new frames). **This is the standardized data
model in practice**: `frames` is the only thing that's ever real state;
everything else about a bowler's game is a pure function of it, defined
exactly once. If a future component needs a number that isn't already
derivable, add the derivation to `scoring.js` — don't compute it locally
in the component and don't add it as a separately-tracked field on
`Bowler`.

**Bowler `id` stability**: the current mock (`mkBowler`) assigns ids from
a client-side incrementing counter reset on every page load. A real
backend must assign **stable, durable ids** (won't collide across lanes,
survive a reconnect) since ids are used as React keys driving the
bowler-queue's animation identity (`HANDOFF.md` §"the bowler queue") —
an id that changes across a reconnect would look like every bowler
leaving and a new set joining.

### 3.2 `Lane`

The full per-lane game-state snapshot — this is what `useLaneFeed`
returns as `lane`, and what `DisplayLane`'s `lane` prop expects:

```ts
{
  laneId: string | number,
  maintenance: boolean,        // true = lane paused, no simulated deliveries
  bowlers: Bowler[],           // roster order; see 3.1
  pins: { [pinNumber 1-10]: 0 | 1 },  // 1 = standing. Cosmetic only —
                                       // not currently rendered by DisplayLane
                                       // (removed per an earlier product call),
                                       // still tracked in state
  flashPins: number[],         // pin numbers to flash/animate; cosmetic, same status as `pins`
  ballSpeed: number | null,    // mph, most recent delivery
  alert: "jam" | null,
  lastEvent: "strike" | "",
  events: LaneEvent[],         // newest first, capped at 6 in the mock
  nightlyPins: number,         // lane-wide total pins knocked down tonight
  strikes: number,             // lane-wide strike count tonight
  deliveries: number,          // lane-wide delivery count tonight
  stops: number,               // lane-wide gutter/foul count tonight
  jams: number,                // lane-wide pinsetter jam count tonight
}
```

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
  kind: "ad" | "video" | "stats" | "message",
  scoreBug?: boolean,                             // override the kind-based default (see below)
  // kind: "ad"
  imageUrl?: string, alt?: string,
  // kind: "video"
  videoUrl?: string, poster?: string, loop?: boolean,  // loop defaults true
  // kind: "message"
  title?: string, subtitle?: string,
  // kind: "stats" — no extra fields; renders lane.strikes/deliveries/etc. directly
}
```

Behavior rules a real scheduler must respect (already enforced by the
mock, see `HANDOFF.md`):
- `stats` fully replaces the screen (no persistent score display).
- `ad` / `video` / `message` keep a persistent `ScoreBug` underneath
  (scores are never fully hidden by sponsor content) unless `scoreBug`
  explicitly overrides that.
- **`ad`/`video` must only fire when the lane has no active game** — the
  real compute node owns this decision (see `hasActiveGame` in
  `DisplayLanePage.jsx`, currently `bowlers.length > 0 && !everyone
  gameComplete`). `stats`/`message` aren't gated the same way.

### 3.4 Actions (control tablet → backend)

What `useLaneFeed` returns as `actions` — the verbs `ControlLane` calls,
meant to map directly to messages a real tablet sends upstream:

| Action | Signature | Server should… |
|---|---|---|
| `addBowler` | `(name: string) => void` | Append a new bowler (id assigned server-side) to the lane's roster, capped at 12 |
| `removeBowler` | `(id: number) => void` | Remove that bowler from the roster |
| `correctBall` | `(bowlerId, frameIdx, ballIdx, pins) => void` | Apply `applyBall` semantics — overwrite one ball's pin count, immutably |
| `setPinsetterRunning` | `(running: boolean) => void` | Pause/resume automatic delivery simulation — real equivalent: pause/resume accepting pinsetter events for this lane |

### 3.5 Suggested WebSocket envelope (not yet implemented)

No backend exists yet — this is a proposal for the message shape,
sketched to make the eventual swap-in of a real socket a drop-in
replacement for `useLaneFeed`/`useTakeoverFeed`'s internals only.

**Server → client** (one connection per lane, or a shared connection
multiplexed by `laneId`):
```json
{ "type": "lane_state", "laneId": "7", "state": { /* full Lane, 3.2 */ } }
{ "type": "takeover", "laneId": "7", "takeover": { /* Takeover, 3.3 */ } }
{ "type": "takeover", "laneId": "7", "takeover": null }
```

**Client → server** (from a control tablet):
```json
{ "type": "add_bowler", "laneId": "7", "name": "Jordan" }
{ "type": "remove_bowler", "laneId": "7", "bowlerId": 481 }
{ "type": "correct_ball", "laneId": "7", "bowlerId": 481, "frameIdx": 2, "ballIdx": 0, "pins": 7 }
{ "type": "set_pinsetter_running", "laneId": "7", "running": false }
```

Whether `lane_state` pushes full snapshots or diffs is an open
implementation choice — the frontend only needs whatever hook replaces
`useLaneFeed` to hand back a complete `Lane` object per render, so either
works as long as the hook reduces diffs into full state client-side.

---

## 4. Testing independently (no backend, no dummy hooks)

Because `DisplayLane` is pure and takes everything via props, you can
exercise it with completely static, hand-authored data — useful for
visual QA, screenshot testing, or building out new takeover
kinds/themes without the simulator running or randomizing on you.

```jsx
import DisplayLane from "./components/display/DisplayLane.jsx";
import { mkBowler, applyBall } from "./lib/scoring.js";

const bowler = applyBall(mkBowler("Test").frames, 0, 0, 10); // a strike in frame 1
const lane = {
  laneId: 7, maintenance: false,
  bowlers: [{ id: 1, name: "Test", frames: bowler }],
  pins: {}, flashPins: [], ballSpeed: 14, alert: null, lastEvent: "",
  events: [{ ts: "12:00:00", type: "sys", msg: "lane online" }],
  nightlyPins: 10, strikes: 1, deliveries: 1, stops: 0, jams: 0,
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
