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
| `tickerLead` | `ReactNode` | no | — | Rendered at the **left of the bottom ticker strip**, sharing its row (the sponsor slot). `DisplayLane` fixes the strip's height and the lead's width, so a lead sized by its own content can't steal height from the scorecards |
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

### `KioskLane` (`components/kiosk/KioskLane.jsx`)

The 9:16 bowler terminal on the lane console — the openlanescheduler kiosk,
migrated. Same architectural shape as `ControlLane` (reads `useParams()`,
calls `useLaneFeed(laneId)`, takes no props) and the same caveat about not
being drivable from hand-authored data.

**This screen does not use `lib/theme.js` or `lib/themes.js`.** It has its
own token set in `components/kiosk/theme.jsx`, on CSS variables, with a
light and a dark scheme (`KioskThemeProvider` + `useKioskTheme`; follows
`prefers-color-scheme` until someone toggles it, then persists). Three
reasons, all of which apply to this screen and not the overhead display:
its palette is read at arm's length in a lit room rather than from thirty
feet in a dark house, so every colour is checked against the surface it
sits on; it uses **one** elevation system, flat (fill + a 1px border, never
a shadow pair), where the screen previously mixed neumorphic and flat
surfaces at the same depth; and neumorphism is shadow-on-a-single-base
colour, which doesn't survive inversion — flat is what makes a light kiosk
possible. Layout rules that need media queries (the orientation split, the
modal geometry) are real CSS in that file rather than inline styles.

Two things changed in the move and are worth not undoing: it's **one lane
per device** (everything else here already is, and so is the compute node's
API), and its countdown is **this compute node's own session clock**
(`state_machine/session.py`) rather than arithmetic over a walk-in record
living in openlanescheduler — so the lane keeps timing correctly with that
service down. Staff are still summoned through openlanescheduler's existing
service-call pipeline; that MQTT edge is the only thing the two systems
still share.

Every control on it is a REST call on the compute node's public API (§3.4)
— there's no private kiosk channel. That's what lets the siteserver bus
activate a lane later and land in exactly the state a bowler tapping Start
would have produced.

**Three states, in order** — the terminal never asks for everything at once:

1. **Idle** (`!lane.active`) — pick by-the-hour or by-the-game and a length,
   then *Start session*. Nothing but that choice is collected here.
2. **Roster** (`lane.active && lane.gameType == null`) — session live and the
   clock already running, but no scoresheet. Names go to the server as
   they're entered (the session exists, so the roster is real lane state,
   not something held on one tablet), then *Start game*. Disabled at zero
   bowlers. *End session* is available here so a lane started by mistake is
   escapable without bowling a frame.
3. **Playing** — the full lane screen.

`gameType` is null only before a session's *first* game, so ending a game
returns to state 3 with "play another game", never back to 2. State 2 is
skipped entirely when the activation already carried a roster.

**The main screen holds only what a bowler reaches for**: the clock, who's
up, and the actions. Everything else — the roster, score editing — is
behind a button. With up to twelve bowlers, a permanent roster panel pushed
the pinsetter and the staff calls off the bottom of a portrait console, and
editing a roster is something a party does once and then rarely.

**Layout** is three blocks (`.k-block--status` / `--game` / `--session` in
`theme.jsx`). Portrait stacks them in that order. Landscape (≥860px wide
and not taller than it is wide) puts *status* and *session* in a left rail
and *game* alongside — so the controls that act on the session sit directly
under the clock that's counting it, and the game's own controls get the
width. The two columns end level: the grid stretches, and `.k-grow` on the
summary card absorbs the slack. The action grids and the clock size
themselves with **container** queries, not viewport ones: the same
`.k-actions` renders two columns in a 400px rail and four in an 800px one,
and the clock's type scales against its own box so the times can't overflow
when the layout goes two-column.

`TWO_COLUMN_QUERY` in `theme.jsx` is the single definition of that
breakpoint — the CSS interpolates it and `useTwoColumn()` matches on it, so
a component that changes *shape* there (only `RosterSummary` today) can't
drift out of step with the layout that changes *size*.

Sub-components, all kiosk-local:

| Component | Props |
|---|---|
| `SessionClock` | `session: Session \| null`, `active: boolean`, `held: boolean` — wall clock + countdown; see §3.2.1 for the freeze-vs-count-down rule |
| `RosterModal` | `bowlers`, `maxBowlers`, `currentBowlerId`, `startMode?`, `onAdd`, `onRename`, `onHandicap`, `onRemove`, `onSetTurn?`, `onStartGame?`, `onEndSession?`, `onClose` — the whole roster in a dialog: rename, handicap, remove, and **hand the turn to a bowler** (the ▶ chip; filled and inert for whoever's up, absent in `startMode` since there's no rotation yet, disabled for anyone who's finished). `startMode` turns it into state 2's "who's playing" step: same list, same calls, different footer |
| `RosterSummary` (same file) | `bowlers`, `currentBowlerId`, `onOpen` — **two shapes**, chosen by `useTwoColumn()`: a one-line tappable card in portrait (so the actions below it stay reachable without scrolling), and a full standings panel in landscape carrying `.k-grow`, which is the element that absorbs the leftover column height and is what makes the two columns end level. The extra height buys real information (every bowler's frame, handicap and total), not whitespace |
| `ScoreEditModal` | `bowlers`, `currentBowlerId`, `selectedBowler`, `onPickBowler`, `onPickFrame`, `onBack`, `onClose` — pick-who then pick-which-frame, behind an explicit *Edit score* tap. Frames are **one per row in a scrolling column**, not the control screen's ten-across strip: ten frames across a tablet gives each ~35px, fine to read, far too small to aim at. Rows for frames the bowler hasn't reached are disabled — the backend can't record into them (§3.4). `zIndex` 50, under the pin picker's 60, so closing the picker returns to the frame list |
| `PinPickerModal` | `bowler`, `frameIdx`, `onCommit`, `onClose` — the kiosk's pin deck |
| `ActionButton` | `glyph`, `label`, `sublabel?`, `accent?: {fill, ink}`, `disabled?`, `onClick` — `accent` takes a fill/ink **pair** so a caller can't put unreadable text on a coloured fill in one scheme |
| `Modal` + `ModalButton` (`Modal.jsx`) | the dialog shell everything above is built on: centred, content-sized, capped by the viewport, Escape to close |
| `AddBowlerModal` (`Modals.jsx`) | name **and** handicap in one dialog. Making the handicap a second trip meant it was usually skipped, which is how a handicap league ends up scored scratch |
| `TextPromptModal` / `NumberPadModal` / `ConfirmModal` (`Modals.jsx`) | prompts for a name, a number, and a yes/no |
| `Toasts` + `useToasts()` | transient confirmations; `report(promise, okMessage)` is the standard "fire an action, toast the outcome" helper |

Only the pin picker's *rules* are shared with `ControlLane`
(`components/shared/scoresheet/useBallCorrection.js` — which ball you're on,
how many pins may be selected, what advancing does). The two screens render
their own decks around it, because they no longer share a visual system:
sharing the rendered modal would have meant one of them looking wrong.

That hook also exports `pinsDownBefore(frame, ballIdx)` and returns
`alreadyDown`: **which pins an earlier ball this frame already took down**,
so correcting ball 2 can't count a pin twice. It's derived from
`frames[].pinMasks` (mirroring the backend's own
`standing_mask_before_next_ball`, including the reset-on-clear rule), and
returns `null` — not an empty set — when any earlier ball has no per-pin
detail. Unknown is not "nothing fell"; with `null` the picker constrains
nothing rather than claiming knowledge it doesn't have. The backend
rejects a double-counted pin regardless (`_validate_frame_masks`), but a
control that permits an impossible selection and only objects on submit is
a worse control.

`styles.js` holds the kiosk's own `raised`/`recessed`/`filled` helpers —
bigger radii and deeper shadows than `ControlLane`'s pair, because
everything on this screen is meant to be pressed. Same Midnight Arcade
tokens either way.

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
| `STATS_SLOT_VH` | `DisplayLane.jsx` | `6.5` | Height of the `children` slot. Deliberately **below** the `MIN_COMPONENT_VH` floor — that floor is for things people read, and ball speed / strike counts are glanceable extras that were competing with the scorecards. A fixed height, not a minimum, so it can't grow back |
| `FRAME_LABEL_CLEARANCE_VH` | `DisplayLane.jsx` | `3.4` | Band reserved under the stats row for `FrameSpotlight`'s frame labels, which hang above the sheet region and would otherwise draw straight over it. One constant feeds both the reserve and the label offset |
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
  frames: Frame[],        // see below — length is gt.frameCount, 10 for every
                           // game type today (ten-pin/no-tap/duckpin)
  totalScore: number,     // SCRATCH -- explicit; the client never scans `frames` for
                           // the last resolved runningTotal itself
  handicap: number,       // pins added to level a handicap game; 0 for a scratch
                           // bowler. Never enters scoring math (game_state.py's
                           // Bowler.handicap explains why) -- it's applied once, here
  totalWithHandicap: number,  // totalScore + handicap, precomputed for the same
                               // reason totalScore is: no screen decides which of the
                               // three "the score" is by doing arithmetic itself
  currentFrame: number | null,  // 1-indexed frame this bowler is on; null once
                                 // THIS bowler's own game is complete
  currentBall: number | null,   // 1-indexed -- which ball of currentFrame is next
                                 // for them. Well-defined for every bowler on the
                                 // roster, not just whoever currently has the turn
                                 // (Lane.currentBowlerId, below) -- e.g. DisplayLane's
                                 // frame spotlight needs every bowler's own position,
                                 // not just the active one's.
}
```

**Which total a screen shows**: `displayTotal(bowler)` in `lib/scoring.js`
picks `totalWithHandicap` when there's a handicap and `totalScore`
otherwise, and **every screen uses it** — the overhead sheet, the ScoreBug,
the kiosk's summary and its score-edit list. It exists so they can't
disagree about who's winning. Handicap never enters frame arithmetic (a
frame's `runningTotal` is always scratch, which is what makes the
pins-per-frame column add up), so the handicapped figure appears only as a
bowler's total. Wherever it does, show the `+N` alongside: two bowlers on
the same displayed number are not tied if one is carrying 40 pins.

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

**The UI must never infer `totalScore`/`currentFrame`/`currentBall` (or
whose turn it is) by re-deriving them from `frames` itself** — scanning for
the last resolved `runningTotal`, the first frame with `turnOver: false`,
tallying ball counts, etc. That's exactly the client/server duplication
this whole backend exists to avoid; those three fields (plus `Lane.
currentBowlerId`) are the backend's own explicit, single-computed answer to
"what's next," and the UI just reads them. `lib/scoring.js` only derives
genuinely presentational values now: `ballGlyph` (glyph per ball),
`gameComplete` (a direct read of the last frame's `complete`, not a
computation), `countStrikes`/`countSpares`/`pinfall` (used by
`BowlerStatsPanel`). If a future component needs a number that isn't
already explicit, add it to the backend's snapshot — don't derive it
locally in a component or add it back to `lib/scoring.js`.

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
  gameEnded: boolean,           // the current scoresheet was closed by "End game" -- it's
                                 // still readable, it just isn't taking balls
  maxBowlers: number,           // backend-owned lane capacity (game_state.
                                 // MAX_BOWLERS_PER_LANE). Never hardcode a copy: a house
                                 // that seats more per lane changes one env var
  machineState: string,         // state_machine/state_machine.py's State enum: "IDLE" | "READY" |
                                 // "BALL_IN_FLIGHT" | "AWAITING_PINFALL" | "PINSETTER_BUSY" | "GAME_COMPLETE"
  currentBowlerId: string | null,   // whose turn it is
  active: boolean,              // backend `laneActive` -- is this lane in play at all (i.e. does it
                                 // have a live session). FALSE is an idle lane waiting to be
                                 // activated. Branch on this, never on `session != null`, which
                                 // stays truthy after a session ends
  session: Session | null,      // see 3.2.1; survives being ended so a terminal can still show
                                 // what just finished
  assistance: AssistanceRequest[],  // OPEN staff summons only; see 3.2.2
  awaitingStaff: boolean,       // specifically "a problem is open" -- the thing that holds the
                                 // clock. A pending server call leaves this false
  ballSpeed: number | null,     // mph, most recent delivery (from a "ball_speed" WS event)
  connected: boolean,           // is the WebSocket to the compute node currently open
  events: LaneEvent[],          // newest first, capped at 6 -- client-synthesized (see 3.5), not from the backend directly
}
```

#### 3.2.1 `Session`

From `state_machine/session.py`. A session is the lane being sold: it spans
many games, and only activate/deactivate begin and end one.

```ts
{
  id: string,
  mode: "timed" | "games",
  source: "kiosk" | "siteserver" | "api",   // who activated the lane; provenance only
  startedAtMs: number,
  endedAtMs: number | null,
  ended: boolean,
  durationMs: number | null,     // timed only, INCLUDING extensions
  endsAtMs: number | null,       // timed only -- wall-clock instant it runs out
  remainingMs: number | null,    // timed only, floored at 0
  expired: boolean,
  gamesPurchased: number | null, // games mode only, including extensions
  gamesStarted: number,
  gamesRemaining: number | null, // games mode only
  extensions: number,
  paused: boolean,               // the clock is HELD (a problem is open)
  pausedAtMs: number | null,
  pausedTotalMs: number,         // banked hold time, including any in progress
}
```

**Rendering the countdown** (`components/kiosk/SessionClock.jsx` does this):
when `paused`, render `remainingMs` verbatim — the backend freezes it, and
it is the only field that holds still. When running, count down to
`endsAtMs` instead of subtracting elapsed time locally; every second spent
held pushes `endsAtMs` later, which is exactly the behavior you want and
exactly what local accumulation would get wrong. Per-game sessions have no
clock at all — show `gamesRemaining`.

#### 3.2.2 `AssistanceRequest`

From `state_machine/assistance.py`. Only open requests appear in
`lane.assistance`; resolved ones are history and nothing renders them.

```ts
{
  id: string,
  kind: "problem" | "service",   // problem holds the session clock; service doesn't
  reason: string | null,
  requestedAtMs: number,
  resolvedAtMs: number | null,
  open: boolean,
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

### 3.4 Actions (control tablet / bowler terminal → backend)

What `useLaneFeed` returns as `actions` — the verbs `ControlLane` and
`KioskLane` call. Unlike the WebSocket (3.5, read-only), these are REST
calls straight to `state_machine/api.py`.

**Every action resolves to `{ ok: true, data }` or `{ ok: false, error }`
— none of them reject.** Failures are logged to the event log either way,
but the bowler terminal needs to toast a real "that didn't work" at the
point of the tap (a 503 because the UART bridge is down is the one bowlers
will actually hit), and an action that rejected would need a `.catch()` at
every one of ~12 call sites or produce unhandled rejections at the ones
that forgot.

| Action | Signature | REST call |
|---|---|---|
| `addBowler` | `(name, handicap?) => Promise<Result>` | `POST /api/lanes/{lane}/bowlers {name, handicap}` — the handicap travels with the name (a bowler and their handicap arrive together in practice, and add-then-patch left a window where the second call could fail and put a handicap bowler on the board as scratch). 409 at `lane.maxBowlers` |
| `renameBowler` | `(id, name) => Promise<Result>` | `PUT /api/lanes/{lane}/bowlers/{id} {name}` |
| `setHandicap` | `(id, handicap) => Promise<Result>` | `PUT /api/lanes/{lane}/bowlers/{id}/handicap {handicap}` |
| `removeBowler` | `(id) => Promise<Result>` | `DELETE /api/lanes/{lane}/bowlers/{id}` |
| `setCurrentBowler` | `(id) => Promise<Result>` | `PUT /api/lanes/{lane}/turn {bowler_id}` — hand the turn to someone else when the rotation and the people on the lane have drifted apart. Records nothing; 409 if there's no game, they aren't in its rotation, or they've finished |
| `correctBall` | `(bowlerId, frameIdx, ballIdx, pins, pinMask?) => Promise<Result>` | `PUT /api/lanes/{lane}/bowlers/{id}/score` — `frameIdx`/`ballIdx` stay 0-indexed at this call site (matches the pin picker's own indexing) and are translated to the backend's 1-indexed `{frame_number, ball_in_frame, pinfall, pin_mask}` inside `useLaneFeed`, the one place that needs to know about the difference. Overwrites a recorded ball **or records the next one in a frame**; a frame the bowler hasn't reached 400s, which is why the frame list only enables frames that have balls or are the bowler's `currentFrame`. **Send `pinMask`** (bit N−1 = pin N) whenever the caller knows which pins fell — the pickers always do, and it's what populates `frames[].pinMasks` so a later ball in the same frame can grey out pins already down |
| `activateLane` | `({mode?, minutes?, games?, bowlers?}) => Promise<Result>` | `POST /api/lanes/{lane}/activate` (always `source: "kiosk"` from here) — opens the session. Starts the first game too only if `bowlers` is passed; the kiosk doesn't, so its lane lands in the "who's playing" step |
| `deactivateLane` | `() => Promise<Result>` | `POST /api/lanes/{lane}/deactivate` — ends the session, lane back to idle |
| `extendSession` | `({minutes?, games?}) => Promise<Result>` | `POST /api/lanes/{lane}/session/extend` — "extend time" or "play another game" depending on the session's mode |
| `startGame` | `() => Promise<Result>` | `POST /api/lanes/{lane}/games {}` — the *next* scoresheet only |
| `endGame` | `() => Promise<Result>` | `POST /api/lanes/{lane}/games/end` |
| `requestAssistance` | `(kind, reason?) => Promise<Result>` | `POST /api/lanes/{lane}/assistance {kind, reason}` — `"problem"` holds the clock, `"service"` doesn't |
| `resolveAssistance` | `(id) => Promise<Result>` | `POST /api/lanes/{lane}/assistance/{id}/resolve` |
| `cyclePinsetter` | `() => Promise<Result>` | `POST /api/lanes/{lane}/pinsetter/cycle` — 503 when the gateway link is down |
| `rerackPinsetter` | `() => Promise<Result>` | `POST /api/lanes/{lane}/pinsetter/rerack` — same |

`setPinsetterRunning` is gone — it paused the old simulator's fake
delivery interval, which has no real-backend equivalent (no "pause
accepting pinsetter events" endpoint exists, and pausing live hardware
input isn't really a thing). `ControlLane`'s pinsetter-live toggle was
replaced with a real WebSocket connection-status indicator (`lane.connected`)
instead.

**`useLaneFeed` no longer starts games by itself.** It used to POST
`/games` automatically — immediately once bowlers existed on an idle lane,
and a few seconds after `GAME_COMPLETE`. That was right when nothing else
could start one, but a lane is now activated explicitly and every game
after the first is a deliberate tap, so an auto-restart would fight both:
ending a game would instantly un-end itself. Starting a game is something a
caller does, never something the hook does behind their back.

### 3.5 WebSocket envelope (as implemented)

One connection per lane: `useLaneFeed` opens `ws://…/ws/display/{laneId}`
(`state_machine/api.py`). Read-only, matching that service's design — REST
(3.4) is the only command path, never the socket.

**Server → client** (`state_machine/api.py`'s exact message shapes):
```json
{ "type": "state", "lane": 7, "data": { /* full Lane snapshot -- game_state.py + state_machine.py, see 3.2 minus laneId/connected/events which the client adds */ } }
{ "type": "event", "lane": 7, "event": "ball_speed", "data": { "mph": 14.2, "intervalMs": 812 } }
{ "type": "event", "lane": 7, "event": "assistance_requested", "data": { "id": "...", "kind": "problem" | "service", "reason": "..." } }
{ "type": "event", "lane": 7, "event": "assistance_resolved", "data": { "id": "...", "kind": "problem" | "service" } }
{ "type": "event", "lane": 7, "event": "lane_activated", "data": { "sessionId": "...", "source": "kiosk" | "siteserver" | "api" } }
{ "type": "event", "lane": 7, "event": "lane_deactivated", "data": {} }
{ "type": "event", "lane": 7, "event": "pinsetter_cycle_requested" | "pinsetter_rerack_requested", "data": {} }
```

Every one of those events is also followed by a full `state` broadcast, so
the events are for the log/animation layer only — never the thing a screen
derives session or assistance state from. Read `lane.session` /
`lane.assistance` for that.

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
