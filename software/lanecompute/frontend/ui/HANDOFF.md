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

`useLaneFeed.js` connects for real to the compute node (2026-08-06) —
`software/lanecompute/backend/state_machine`, a FastAPI service on the
Raspberry Pi wired to the gateway. Real WebSocket (`/ws/display/{lane}`,
read-only) for state, real REST for every mutating action. See `API.md`
§3 for the exact wire shapes.

`useTakeoverFeed.js` is still a mock — the compute node has no
ad-scheduling backend at all, only game state, so there's nothing real to
connect it to yet. It's called out below same as before.

**The bowler kiosk moved here from openlanescheduler (2026-08-13).** New
`/kiosk/:laneId` route (`components/kiosk/`), backed by two new backend
modules: `session.py` (lane activation and the countdown) and a real
lifecycle on `assistance.py` (problem vs server call, and a resolve that
restarts a held clock). The lane's time is this compute node's own now —
openlanescheduler is no longer consulted for it, only notified when staff
are wanted. Its own `kiosk/` app is untouched and still runs;
decommissioning it is a separate change.

One behavior change worth knowing about if you're chasing "why didn't the
game restart": **`useLaneFeed` no longer auto-starts games.** See `API.md`
§3.4 — an idle lane now waits to be activated, and every game after the
first is an explicit tap. An auto-restart would have made "End game"
impossible to observe.

Three things found and fixed while wiring this up, all pre-existing:
- `assistance.py` published to MQTT inline from an async request handler.
  paho's `connect()` is synchronous, so against an unreachable broker it
  blocked the **whole event loop** — every lane this compute node serves —
  for a measured 4.4s, which is 4.4s of a bowler standing at the terminal
  with no acknowledgement that their call for help registered. The
  notification now goes to a background thread; the request returns in ~3ms.
  Whether the dashboard hears about it has never had any bearing on whether
  the lane's own state is right.
- `ControlLane` passed `lane.currentFrame`/`lane.currentBall` into its
  scoresheet. Those fields have never existed on the lane snapshot (only
  per bowler), so the "you're here" ball highlight silently never rendered.
- `edit_score` validated each ball as 0–10 but never the frame's total, so
  correcting ball 1 to a 9 with a 2 already recorded behind it stored an
  11-pin frame. It now re-checks the whole resulting frame and 400s. This
  only became easy to hit once bowlers could correct their own scores.

## Routes

- `/display/:laneId` — overhead monitor (16:9), one lane's bowlers only
- `/kiosk/:laneId` — bowler terminal on the lane console (9:16 portrait):
  start/end a game, extend or end the session, names, handicaps, call for
  help or a server, cycle/re-rack the pinsetter
- `/control/:laneId` — scoresheet / manual-correction tablet (9:16 portrait)
- `/` — dev-only launcher listing all 8 lanes with links to all three; not
  part of the real deployment (each physical device is pointed straight at
  its own URL, no device ever visits `/`)

## File layout

```
src/
  App.jsx                    route table
  main.jsx                   React root + BrowserRouter
  lib/
    scoring.js                presentational-only helpers now (ballGlyph,
                               currentTotal, gameComplete, nextThrow,
                               countStrikes/countSpares/pinfall) — derives
                               from the backend's own per-frame data,
                               doesn't compute scores itself anymore. See
                               its module docstring and API.md §3.1.
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
    useLaneFeed.js             REAL per-lane connection to the compute
                               node — WebSocket for state, REST for every
                               action (roster, handicap, score correction,
                               lane activate/deactivate, game start/end,
                               session extend, staff calls, pinsetter),
                               auto-reconnect. Actions resolve to
                               { ok, data } / { ok, error }, never reject.
                               Starts no games on its own. Shape:
                               { lane, actions } — see API.md §3.2/3.4
    useTakeoverFeed.js         ⚠ DUMMY BACKEND STAND-IN — mock schedule
                               for full-screen ad/video/message
                               takeovers (no real ad-scheduling backend
                               exists). Real shape: { activeTakeover }
  components/
    control/ControlLane.jsx    9:16 tablet: roster, turn rotation,
                               tap-a-frame pin-picker correction modal
    kiosk/
      KioskLane.jsx            bowler terminal — the migrated
                               openlanescheduler kiosk. Three states in
                               order: pick hours/games → enter the roster →
                               play (API.md §1). Start/end game, extend or
                               end session, names, handicaps, call for help
                               / a server, cycle / re-rack, edit a score
      theme.jsx                the kiosk's OWN tokens: light + dark on CSS
                               variables, plus every layout rule that needs
                               a media query (orientation split, modal
                               geometry). Not lib/theme.js — see API.md §1
      SessionClock.jsx         wall clock + countdown; freezes (and says
                               why) while a problem is open — API.md §3.2.1
      RosterModal.jsx          the roster, in a dialog, + RosterSummary (the
                               one-line card the main screen shows instead)
      ScoreEditModal.jsx       behind an explicit "Edit score" tap: pick a
                               bowler, then a frame, one per scrolling row
      PinPickerModal.jsx       the kiosk's pin deck
      Modal.jsx                the dialog shell: centred, content-sized,
                               Escape to close
      ActionButton.jsx         one big two-line tap target
      Modals.jsx               text prompt, number pad, confirm
      Toasts.jsx               transient outcome toasts + useToasts()
      styles.js                flat panel/card/sunken/filled helpers and the
                               duration/clock formatters
    shared/scoresheet/
      useBallCorrection.js     the correction RULES, headless — shared by
                               the kiosk's pin deck and ControlLane's. The
                               two screens don't share a visual system, so
                               they render their own decks around it
      CorrectionModal.jsx      ControlLane's pin deck (Midnight Arcade)
    shared/Chrome.jsx          Clock, LivePill (used by display)
    display/
      DisplayLane.jsx          the big one — pure presentational 16:9
                               screen. Contains BowlerSheet, BowlerQueue,
                               and the whole layout. See below.
      DisplayLanePage.jsx      route container: wires useLaneFeed +
                               useTakeoverFeed + theme into <DisplayLane>,
                               decides what fills the below-scores slot
                               (EventLog + MiniAd)
      Ticker.jsx                bottom banner, only renders when enabled
      ScoreBug.jsx               compact all-bowlers strip (used during
                                 ad/video/message takeovers)
      MiniAd.jsx / EventLog.jsx  small persistent ad slot / event log —
                                 passed into DisplayLane as children, not
                                 hardcoded inside it
      layers/
        TakeoverLayer.jsx        renders whatever activeTakeover prop says
                                 (ad/video/message) — no scheduling logic
                                 of its own
        CelebrationLayer.jsx     event-triggered (not externally
                                 scheduled) short overlay, e.g. a strike
                                 burst — self-contained, watches lane
                                 events directly
```

## DisplayLane's standardized props API

`<DisplayLane laneId lane theme activeTakeover tickerMessages
tickerEnabled celebrationAssets>{children}</DisplayLane>` — full prop
docs are in the JSDoc block at the bottom of the file. It's pure: all
state comes in via props, nothing is fetched or hardcoded inside it — it
can be driven by the real feed (useLaneFeed) or hand-authored data
(API.md §4) with zero changes to the component itself.

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
import. **Neither tablet screen was migrated onto this system —
`ControlLane.jsx` and everything in `components/kiosk/` still import the
old static `lib/theme.js`.** Bringing them onto the same theme system is an
open item, not done; the kiosk was deliberately built to match
`ControlLane`'s existing convention rather than half-migrate one screen.

## Layout rules (product requirements, enforced in code)

- Every distinct content block a bowler is meant to *read* (the bottom
  ticker strip, each bowler sheet) is **at least 10% of screen height** —
  `MIN_COMPONENT_VH` in `themes.js`.
  - **Exception: the stats slot** (`STATS_SLOT_VH = 6.5`). Ball speed and
    strike/spare counts are glanceable extras, not something anyone reads
    from thirty feet; at 10vh they competed with the scorecards and took
    height the sheets could use. Fixed height, not a minimum.
- The bottom strip is **one row**: the sponsor slot (`tickerLead`) on the
  left, the ticker filling the rest. Its height is fixed by `DisplayLane`
  so a sponsor image's own aspect ratio can't inflate it at the
  scorecards' expense.
- **Frame labels persist.** Every frame up to and including the live one is
  numbered above the sheet region (`FrameSpotlight`) so a bowler can tell
  which frame a score belongs to — a single travelling label only answers
  that for the current frame. Earlier frames drop the fill and the border
  but stay legible; deference is not the same as being too faint to read
  at distance (`T.muted` is ~2:1 against this background and vanishes).
  They hang *above* the sheets, so `FRAME_LABEL_CLEARANCE_VH` reserves a
  band under the stats row for them.
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

`TakeoverLayer` renders three kinds: `ad`, `video`, `message`. (A fourth,
`stats`, existed when this was all mock data — rendered lane-wide
strike-rate/nightly-pinfall/jam counts. Removed: `game_state.py` is
per-game, not per-night, so there's nothing real to show. Bring it back
if that data ever exists server-side.)
- `ad` / `video` / `message` keep a persistent `ScoreBug` in their own
  reserved row below the content (previously this was absolutely
  positioned *over* the content — fixed).
- **Advertising (`ad`/`video` only) is gated on there being no active
  game** — `DisplayLanePage` computes `hasActiveGame` from the real
  `lane.machineState` and passes it into `useTakeoverFeed`; the
  *gating decision* is real, the *takeover schedule itself* is still the
  mock (there's no ad-scheduling backend to hand that decision to yet).

No real ad/video/celebration media assets exist yet — `MOCK_MINI_AD`
and the takeover `SCRIPT` in `useTakeoverFeed.js` use an inline
placeholder SVG; `celebrationAssets` defaults to `{}` (no-op).

## Real backend connection (`useLaneFeed.js`)

- WebSocket to `/ws/display/{laneId}` on the compute node
  (`state_machine/api.py`), read-only — every mutating action is a separate
  REST call (API.md §3.4), never sent over the socket.
- Auto-reconnects on close (3s delay) rather than surfacing a dead
  connection permanently; `lane.connected` reflects live state,
  `ControlLane`'s topbar shows it instead of the old fake
  "pinsetter live/paused" toggle (which had no real backend equivalent —
  there's no "pause accepting pinsetter events" endpoint).
- Auto-starts a game: immediately once bowlers exist on an otherwise-idle
  lane, and a few seconds after `machineState` reaches `GAME_COMPLETE`
  (product decision — no manual "next game" button today). Guarded
  against a duplicate `POST /games` race with a ref, not a real lock.
- `events` (EventLog/CelebrationLayer) aren't pushed by the backend as a
  list — synthesized client-side by diffing successive state snapshots
  for newly-appended balls, plus `assistance_requested` broadcasts.
  Purely cosmetic; scoring never depends on it. Strike-triggered
  celebration events only fire on a literal 10-pin ball value today, not
  no-tap's relaxed 9-pin threshold — celebrations have no real video
  assets yet either way, so this wasn't worth the extra precision.

## Known gaps

- **`useTakeoverFeed` still has no real backend** — no ad-scheduling
  service exists on the compute node at all, only game state.
- **No pin-deck visuals, jam alerts, or session stats.** These existed in
  the old mock `Lane` shape (`pins`/`flashPins`/`alert`/`nightlyPins`/
  `strikes`/`deliveries`/`stops`/`jams`) and were dropped when wiring in
  the real backend, since nothing produces them server-side — pin-deck
  needs `vision/pinfall.py` (not implemented), jam detection needs
  something to act on the mesh's `STATUS_RELAY_FAULT` (nothing does yet),
  session stats would need the backend to track more than one game.
- **10th-frame-specific UI (frame-box count, "isTenth" checks) still
  assumes ten-pin's 2-then-3-ball shape.** The backend now supports
  duckpin (3 balls per *regular* frame, not just the final one) via
  `game_types.py`, but `ControlLane`/`DisplayLane`'s frame-box rendering
  wasn't adapted for a variable regular-frame ball count — picking
  `game_type: "duckpin"` when starting a game will under-render frame
  boxes for anyone who takes a 3rd ball in a regular frame. Ten-pin and
  no-tap (still 2-then-3) render correctly.
- **No `game_type` picker anywhere in the UI.** Both `POST /games` and
  `/activate` accept one; nothing exposes it, so every game is ten-pin.
  (Starting a game IS a real control now — the kiosk's — it just always
  starts the default type.)
- **The siteserver message bus doesn't exist.** A lane can only be
  activated from the kiosk or a direct REST call today. The backend is
  already shaped for it (`api.activate_lane()` is the shared entry point
  both paths use), but there's no bus and no consumer.
- **The kiosk trusts whoever's standing at it.** Anyone can end a session,
  extend time, or clear a staff call — there's no staff PIN or any other
  gate, matching the compute node's existing "anyone on the lane's network
  is trusted" posture (see `api.py`'s CORS note). Worth revisiting before
  extend-time is tied to anything that bills.
- **Both tablet screens still on the old theme system** (`lib/theme.js`),
  not `lib/themes.js` — inconsistent with the display side.

## Reference material this was built from

`dev/doodles/scoredash/src/scoredash.jsx` (finished overhead-dashboard
prototype) and `dev/doodles/openlanescheduler-scoring.jsx` (per-lane bowler
control-UI prototype) were the design/behavior references for the
display and control screens respectively — both were fully self-mocked
prototypes with no real data layer; see
`~/.claude/projects/.../memory/project_openlanelink_ui.md` for the full
review notes from when those were first surveyed.

## Next

1. ~~Build the real compute-node WebSocket service and rewrite
   `useLaneFeed`~~ — done (2026-08-06), see "Real backend connection"
   above. `useTakeoverFeed` still needs an ad-scheduling backend to
   connect to, which doesn't exist yet.
2. ~~Share state across a lane's display + control tablet~~ — done as a
   side effect of #1: both routes now independently connect to the same
   server-side lane state (own WS connection each, not a shared client
   store), so a control tablet's changes are visible on that lane's
   display within one broadcast round-trip.
3. Adapt frame-box rendering for duckpin's variable regular-frame ball
   count (see "Known gaps") — needed before duckpin is actually usable
   from the UI, not just the backend.
4. Expose `game_type` selection in the UI (currently REST-only) — the
   kiosk's Start panel is the natural place now that it exists.
5. Migrate `ControlLane` and `components/kiosk/` onto `lib/themes.js`.
6. Source real ad/video/celebration media once available; wire ad/video
   content into `MOCK_MINI_AD`/the takeover `SCRIPT` (still per-venue
   content, not theme-owned), and celebration clips into each preset's
   `assets.celebrationAssets` in `lib/themes.js`.
7. Decide on and implement device-identity/config delivery for real
   kiosk hardware (still just a URL param today, per-lane).
8. Build an actual theme select/create UI (a venue-facing picker or
   editor that produces the descriptor object `resolveTheme()` already
   accepts) — the data model supports arbitrary custom themes today, but
   nothing surfaces that to a non-developer yet.
9. Build the siteserver message bus and its consumer, so a lane sold at
   the front desk activates itself. The backend entry point it should call
   already exists (`api.activate_lane()`); do NOT reimplement the
   activate → new game → begin sequence in the consumer.
10. Decommission `software/openlanescheduler/kiosk/` once the terminal
    here is proven on real hardware. Deliberately left running for now.
