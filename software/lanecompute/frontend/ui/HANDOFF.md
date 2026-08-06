# openlanelink UI — handoff notes

React front end for the bowler-facing screens: one 16:9 overhead monitor
and one 9:16 control tablet **per lane** (not per pair, not whole-house —
each physical device is scoped to exactly one lane). See
`../firmware/HANDOFF.md` for the ESP-NOW node mesh this eventually talks
to; this doc covers the `ui/` project only.

**See `API.md` for the formal reference**: every component's props, the
full theme token set, and the exact data shapes (`Lane`, `Bowler`,
`Frame`, `Takeover`, actions) a real backend needs to produce/consume —
including a sketched WebSocket message envelope. This doc (`HANDOFF.md`)
is the narrative/gotchas version; `API.md` is what you'd hand to someone
building the compute-node backend or testing the UI standalone.

## Where things stand

Everything here runs against **dummy/mock data** — there is no backend
yet. The compute node (Raspberry Pi on the gateway) is meant to run a
WebSocket service per lane that maintains real game state and pushes it
down; nothing in this repo implements that service. The two files that
fake it are called out below — swapping in the real thing should mean
rewriting *those files only*, not the components that consume them.

## Routes

- `/display/:laneId` — overhead monitor (16:9), one lane's bowlers only
- `/control/:laneId` — bowler control tablet (9:16 portrait)
- `/` — dev-only launcher listing all 8 lanes with links to both; not part
  of the real deployment (each physical device is pointed straight at its
  own URL, no device ever visits `/`)

## File layout

```
src/
  App.jsx                    route table
  main.jsx                   React root + BrowserRouter
  lib/
    scoring.js                shared 10-pin scoring engine (frames, running
                               totals, applyBall, computeUp/nextThrow/etc.)
                               — single source of truth for BOTH screens
    themes.js                 display's theme system: named presets
                               (midnight-arcade, daylight, broadcast-flat)
                               + custom-object override, ThemeProvider/
                               useTheme() returning { T, elevation,
                               layout, assets }, plus MIN_COMPONENT_VH
                               (the 10%-of-screen floor). `assets` bundles
                               a theme's own media/branding
                               (celebrationAssets, fontImport) — see
                               API.md §2.7
    theme.js                  OLD static Midnight Arcade tokens — still
                               used by ControlLane only (see Known gaps)
    useLaneFeed.js             ⚠ DUMMY BACKEND STAND-IN — per-lane game
                               state + simulated deliveries. Real shape:
                               { lane, running, actions }
    useTakeoverFeed.js         ⚠ DUMMY BACKEND STAND-IN — mock schedule
                               for full-screen ad/video/stats/message
                               takeovers. Real shape: { activeTakeover }
  components/
    control/ControlLane.jsx    9:16 tablet: roster, turn rotation,
                               tap-a-frame pin-picker correction modal
    shared/Chrome.jsx          Clock, LivePill (used by display)
    display/
      DisplayLane.jsx          the big one — pure presentational 16:9
                               screen. Contains BowlerSheet, BowlerQueue,
                               and the whole layout. See below.
      DisplayLanePage.jsx      route container: wires useLaneFeed +
                               useTakeoverFeed + theme into <DisplayLane>,
                               decides what fills the below-scores slot
                               (EventLog + MiniAd) — THIS is the file to
                               rewire once a real backend exists
      Ticker.jsx                bottom banner, only renders when enabled
      ScoreBug.jsx               compact all-bowlers strip (used during
                                 ad/video/message takeovers)
      MiniAd.jsx / EventLog.jsx  small persistent ad slot / event log —
                                 passed into DisplayLane as children, not
                                 hardcoded inside it
      layers/
        TakeoverLayer.jsx        renders whatever activeTakeover prop says
                                 (ad/video/stats/message) — no scheduling
                                 logic of its own
        CelebrationLayer.jsx     event-triggered (not externally
                                 scheduled) short overlay, e.g. a strike
                                 burst — self-contained, watches lane
                                 events directly
```

## DisplayLane's standardized props API

`<DisplayLane laneId lane theme activeTakeover tickerMessages
tickerEnabled celebrationAssets>{children}</DisplayLane>` — full prop
docs are in the JSDoc block at the bottom of the file. It's pure: all
state comes in via props, nothing is fetched or hardcoded inside it, so
it can be driven by the dummy hooks today or a real feed later with zero
changes to the component itself.

## Theming

`lib/themes.js` — `ThemeProvider`/`useTheme()` context, three presets
(`midnight-arcade`, `daylight`, `broadcast-flat`), and a merge-on-top
custom-object override. A theme is four independent axes: tokens,
elevation strategy, layout policy, and (as of this pass) **assets** —
`celebrationAssets` (event type → webm URL) and `fontImport` (the webfont
`@import` string), both previously either a separate prop with no theme
tie-in (`celebrationAssets`) or a single global constant
(`GOOGLE_FONTS_IMPORT`) — see API.md §2.7. `DisplayLane`'s
`celebrationAssets` prop still exists but now only needs to be passed
when overriding the active theme's default clips; if omitted it falls
back to `useTheme().assets.celebrationAssets`. "Creating" a theme is just
authoring a descriptor object (`{ preset, overrides, layout, assets,
... }`) — no picker/editor UI exists yet, that's still open work.

Every display component reads colors via `useTheme()`, never a static
import. **`ControlLane.jsx` was never migrated onto this system — it
still imports the old static `lib/theme.js`.** Bringing the control
tablet onto the same theme system is an open item, not done.

## Layout rules (product requirements, enforced in code)

- Every distinct content block (ticker, each bowler sheet, the slot below
  the scores) is **at least 10% of screen height** — `MIN_COMPONENT_VH`
  in `themes.js`.
- Bowler sheets cap at **20% of screen height** — `MAX_BOWLER_SHEET_VH` in
  `DisplayLane.jsx` — so a 1-2 bowler lane doesn't blow a single card up
  to fill the whole screen.
- The bowler-sheet region's own height is architecturally fixed (`flex:
  1` against fixed siblings, never driven by bowler count), so how many
  sheets can ever show at once is a **fixed constant**,
  `MAX_VISIBLE_BOWLERS = 6` — not measured at runtime. An earlier
  ResizeObserver-based "how many fit" approach was tried and ripped out;
  it was both buggy and unnecessary once the container is provably fixed.
- Only the bowler-sheet list is allowed to have variable content within
  it (via the queue below); everything else on screen holds its size.

## The bowler queue (this took several iterations — read before touching)

`BowlerQueue` inside `DisplayLane.jsx` shows the front `MAX_VISIBLE_BOWLERS`
of a **turn-order queue**, not roster order. Two things that are *not*
obvious from a first read:

1. **`displayActiveId` is deliberately decoupled from the real-time
   `activeId` prop.** A real bowler can't throw both balls of a frame in
   a few seconds, so the screen does NOT follow the game engine's
   `computeUp()` result instantly. It keeps showing the *previous*
   bowler as active (highlight AND position) until: the second-ball
   score has been visible, any celebration animation tied to it has
   actually finished (`celebrating` prop, driven by
   `CelebrationLayer`'s `onPlayingChange`), and `REORDER_DELAY_MS`
   (3000ms) has elapsed. Only then do the highlight and the top-of-list
   slide change — **together, atomically, in the same instant.** An
   earlier version updated the highlight in real time and only delayed
   the position, which visibly left the truly-active bowler sitting in
   2nd place. Don't reintroduce that.
2. **The reorder timer must read the active bowler fresh at fire time,
   not whatever was captured when it was scheduled.** If it captures a
   stale value, a fast sequence of turns can end up promoting someone
   who isn't active anymore. There's a `activeIdRef` kept current every
   render for exactly this.

The slide itself is a manual FLIP animation (capture DOM rects before
reorder, let React re-render, transform from old position back to new,
then transition that away) — plain array reordering has no native way to
animate in CSS/React.

## BowlerSheet sizing — the container-query gotcha

Each sheet's height varies (10-20vh depending on bowler count), so
**font sizes** inside it use CSS container query units (`cqh`/`cqw`,
via `containerType: "size"` on the sheet) so text scales with that
specific sheet's actual height, not the viewport's. **Layout spacing
(padding, gaps) must NOT use `cqh`/`cqw`** — padding defined in those
units feeds back into the same content-box the units are measured
against (a circular reference) and silently produces much smaller
computed sizes than the clamp() values imply. Hit this once already;
keep spacing in plain `vh`/`vw`.

Sheet layout, left to right: **name** (centered in its column) →
**frames grid** (flex: 1) → **score** (left-aligned in its column, i.e.
flush against the frames grid, not the sheet's outer edge).

## Takeovers

`TakeoverLayer` renders four kinds: `ad`, `video`, `stats`, `message`.
- `stats` fully replaces the screen (no persistent score display).
- `ad` / `video` / `message` keep a persistent `ScoreBug` in their own
  reserved row below the content (previously this was absolutely
  positioned *over* the content — fixed).
- **Advertising (`ad`/`video` only) is gated on there being no active
  game** — `DisplayLanePage` computes `hasActiveGame` from lane state and
  passes it into `useTakeoverFeed`; in production this decision belongs
  to the compute node, this is just the mock's stand-in. `stats` and
  `message` are not gated the same way.

No real ad/video/celebration media assets exist yet — `MOCK_MINI_AD`
and the takeover `SCRIPT` in `useTakeoverFeed.js` use an inline
placeholder SVG; `celebrationAssets` defaults to `{}` (no-op).

## Dummy data specifics (`useLaneFeed.js`)

- 6 randomly-named bowlers per lane (`BOWLERS_PER_LANE`, drawn from a
  16-name pool, no repeats within a lane).
- Simulated delivery every **3000-4600ms** (slowed once already — was
  1400-2200ms, too fast to observe/read).
- Pin outcomes are **recreational-league skill**, not pro: modest
  strike/spare rates, real chance of an outright gutter ball on either
  delivery (`simulateBallPins()`). The original version reused one
  random draw for both the strike-check and the pin count, which made a
  first-ball gutter mathematically impossible — fixed.
- Auto-restarts the game 4s after every bowler completes their 10th
  frame.

## Known gaps

- **No real backend.** `useLaneFeed`/`useTakeoverFeed` are the only two
  files standing in for it.
- **State isn't shared between tabs/devices.** Each `/display/:laneId`
  and `/control/:laneId` mounts its own independent `useLaneFeed`
  instance — a control tablet's roster changes are invisible to that
  lane's display monitor right now, since there's no shared store or
  socket yet.
- **No persistence.** Refreshing a page resets to a fresh random roster.
- **ControlLane still on the old theme system** (`lib/theme.js`), not
  `lib/themes.js` — inconsistent with the display side.
- **Neither `dev/GitHub/openlanelink` nor `dev/doodles/openlanelink` is a
  git repo** — nothing here is under version control yet.

## Reference material this was built from

`dev/doodles/scoredash/src/scoredash.jsx` (finished overhead-dashboard
prototype) and `dev/doodles/openlanescheduler-scoring.jsx` (per-lane bowler
control-UI prototype) were the design/behavior references for the
display and control screens respectively — both were fully self-mocked
prototypes with no real data layer; see
`~/.claude/projects/.../memory/project_openlanelink_ui.md` for the full
review notes from when those were first surveyed.

## Next

1. Build the real compute-node WebSocket service and rewrite
   `useLaneFeed`/`useTakeoverFeed` to consume it instead of simulating.
2. Share state across a lane's display + control tablet (same socket
   connection, or a shared store keyed by laneId).
3. Migrate `ControlLane` onto `lib/themes.js`.
4. Source real ad/video/celebration media once available; wire ad/video
   content into `MOCK_MINI_AD`/the takeover `SCRIPT` (still per-venue
   content, not theme-owned), and celebration clips into each preset's
   `assets.celebrationAssets` in `lib/themes.js`.
5. Decide on and implement device-identity/config delivery for real
   kiosk hardware (still just a URL param today, per-lane).
6. Build an actual theme select/create UI (a venue-facing picker or
   editor that produces the descriptor object `resolveTheme()` already
   accepts) — the data model supports arbitrary custom themes today, but
   nothing surfaces that to a non-developer yet.
