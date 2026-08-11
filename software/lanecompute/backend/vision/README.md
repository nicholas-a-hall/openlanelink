# openlanelink vision daemon

Camera-based pinfall detection. Runs as its own daemon directly on the Pi,
**outside Docker**, with direct access to the camera hardware — deliberately
NOT part of the `state_machine/` Docker-composed API service. See
`../DEVELOPING.md` for the platform-wide reasoning; short version: device
passthrough for a camera (and whatever hardware acceleration OpenCV wants)
is exactly the kind of thing that's simpler to give direct host access than
to fight through a container boundary, so this stays a separate, un-Dockerized
process instead.

This first version targets a plain USB webcam via OpenCV `VideoCapture`. A
firmware port to an ESP32-CAM running the same per-pin brightness-threshold
approach is planned once this Python version is proven out on the bench.

## Relationship to state_machine

`state_machine` is fully standalone and knows nothing about this daemon.
The only link between the two is this daemon POSTing an observation to the
already-existing `POST /api/lanes/{lane}/pinfall` endpoint
(`../state_machine/api.py`) — the same endpoint a bowler tablet or staff UI
can hit for manual entry.

That observation is deliberately raw and stateless: `/capture/{lane}` has
no memory of any earlier capture at all -- it answers "which pins are
standing right now," full stop, the same every time regardless of what
came before. It does NOT try to figure out how many pins fell on *this*
ball; that requires knowing what was already standing going into it, which
only `state_machine` actually tracks (whose ball it is, what's already
been recorded this frame). `state_machine.py`'s `on_pinfall_observed()`
does that derivation, via `game_state.LaneState.standing_mask_before_next_ball()`
-- diffing the reported `standing_mask` against whatever it already knows
was standing gives the real per-ball fallen count/mask. This mirrors the
same "dumb node, the thing with the actual state does the correlating"
principle the ESP32 mesh already follows (a beam sensor emits a raw edge,
it doesn't try to pair its own readings into a speed) -- an earlier version
of this daemon tracked its own "before" state across calls and computed
the delta itself; that turned out to be exactly the wrong layer to own it,
since a manual `reset` flag was needed to tell it when a frame started
over, and getting that flag wrong (or a dropped/retried request) silently
corrupted the game's scoresheet instead of vision just staying stateless
and letting the one place that actually knows "what ball is this" do that
part.

**Self-triggering (2026-08-07):** `bridge_client.py` makes this daemon its
own independent client of the uart_bridge service's WS `/events` feed (the
same feed `state_machine` reads) — it watches for a downstream
ball-detection beam break (from a `speed_node` today, or a future
`ball_detect_node`; see that module's docstring for how the two are told
apart) and self-triggers a capture after `VISION_CAPTURE_DELAY_S` (default
2.5s, letting the ball reach the pins and settle), gated by
`VISION_TRIGGER_COOLDOWN_S` (default 5.0s) per lane so a bounced beam or
overlapping node coverage can't double-fire. This is NOT something
`state_machine` or `uart_bridge` calls into — vision is the side that
depends on knowing when a ball was detected, so it owns the client glue,
keeping the standalone boundary (see `../state_machine/main.py`'s
`on_beam_event()` comment, which explicitly disclaims triggering vision).
`/capture/{lane}` remains available for manual/bench triggering regardless
(curl, a bench script, `--once`).

## Approach

Per-pin brightness thresholding, not full-frame ML detection and not
similarity-to-reference diffing either (an earlier version of this daemon
did the latter — see git history/PR discussion if curious why that was
replaced): pins are light-colored/reflective, the lane surface a fallen pin
exposes is darker, so a pin reads standing if its calibrated ROI is bright
enough, fallen if it's gone dark. `calibration.py` records each pin's fixed
pixel location once (per lane, per camera position) against a reference
frame of the empty, fully-racked deck — that reference frame's per-pin
brightness is each pin's own baseline, since lighting isn't uniform across
the whole deck, so one global brightness cutoff for all 10 pins wouldn't be
reliable. `pinfall.py` also corrects for a real, separate problem: each
capture reopens the camera, and auto-exposure re-settles to a visibly
different overall brightness every time even with nothing physically
changed — `normalize_brightness()` rescales the whole frame to match the
reference's overall brightness before any per-pin comparison, so that
global drift doesn't get mistaken for a pin falling. That correction is
itself capped (`MIN_BRIGHTNESS_GAIN`/`MAX_BRIGHTNESS_GAIN`, both directions)
-- beyond a ~2x swing either way, the frame no longer represents a real
pin-deck state at all (camera covered/blocked on the dark side; something
bright and reflective held up close on the light side), and forcing it to
match the reference's brightness anyway flattens exactly the signal that
would've said "something's wrong here" into looking like an ordinary frame,
leaving classification riding on leftover pixel noise. Both directions were
observed producing scattered, wrong per-pin results on the bench before the
cap existed -- see `normalize_brightness()`'s docstring for the actual
numbers. Deliberately simple and deterministic rather than a trained model,
since the same approach needs to realistically port to an ESP32-CAM later,
which has nowhere near the compute for a full object detector.

Grayscale only, everywhere: `capture_frame()` and `calibration.py`'s saved
reference frame are both grayscale, never the camera's native color output
-- brightness thresholding never looks at color, so carrying it through
capture/storage/comparison was pure waste, and it's one less thing to
reproduce on an ESP32-CAM later (which would rather grab a small
grayscale/Y-plane frame than a full-color one). Color only ever reappears
as a display-only conversion back to BGR, purely so `calibration.py`'s and
`debug_view.py`'s on-screen overlays can be drawn in color -- the actual
captured/compared arrays stay single-channel throughout.

## Layout
- `calibration.py` — interactive click-to-mark tool. Freezes a reference
  frame of the empty deck, then lets the operator mark each of the 10 pins:
  press a digit key (1-9, 0 for pin 10) to select which pin, click to place
  it, `+`/`-` (or `[`/`]` for bigger steps) to resize the selected pin's
  detection ROI down to a single pixel if needed, `r` to restart, `s` to
  save once all 10 are marked, `q` to quit without saving. Pin-first, not
  click-order-first, so pins can be marked in whatever order the camera
  angle makes them identifiable, and any pin -- including after all 10 are
  placed -- can be re-clicked or resized at any time by reselecting it.
  Each pin's ROI radius is independent, not a single lane-wide size. Saves
  `calibration/lane_<N>.json` (pin center + radius per pin, camera index)
  + `calibration/lane_<N>_reference.png`.
- `pinfall.py` — detection + daemon. `detect_standing_mask()` does the
  per-pin brightness check and that's the whole answer -- no per-lane
  state, no `reset`, no before/after diffing (see "Relationship to
  state_machine" above for why that moved to `state_machine.py`).
  `/capture/{lane}` returns the raw standing mask plus `standingPins`/
  `fallenPins` (the two lists of pin numbers, decoded from the mask for
  convenience -- `fallenPins` here just means "not standing right now,"
  not "fell on this specific ball").
- `bridge_client.py` — WS client of uart_bridge's `/events` feed; drives
  `pinfall.py`'s self-triggered capture off ball-detection beam events (see
  "Self-triggering" above). Trimmed compared to
  `../state_machine/bridge_client.py` -- vision only ever consumes events
  off the bridge, it never issues commands to it.
- `debug_view.py` — live camera view with the calibrated pins overlaid:
  each pin's ROI circle (green=standing, red=fallen) plus its current
  brightness vs. cutoff (`current/cutoff`), refreshed every frame. Reads
  an existing calibration and mirrors `detect_standing_mask()`'s exact
  logic for display purposes; doesn't touch state_machine, the `_LaneDetector`
  daemon, or any per-ball bookkeeping. For eyeballing detection quality
  and spotting a bad calibration (an outlier baseline pin, an ROI that
  drifted onto glare/background) without reading raw numbers off a
  one-off diagnostic script every time.

## Running

Calibrate a lane first (needs a webcam attached, opens a couple of OpenCV
preview windows). If `--camera` is omitted, every working camera index gets
probed and, if more than one is found, you're prompted in the terminal to
pick which one to use (auto-picked with no prompt if there's only one):
```
uv run calibration.py --lane 7
uv run calibration.py --lane 7 --camera 0   # or pick one explicitly, no prompt
uv run calibration.py --list-cameras        # just probe and list, no calibration
```

Single manual capture, no server, prints the result:
```
uv run pinfall.py --lane 7 --once
```

Run the daemon (self-triggers off ball-detection beam events -- see
"Self-triggering" above -- in addition to manual/bench triggering):
```
uv run pinfall.py
```
Config is via environment variables (all optional, defaults shown):
```
STATE_MACHINE_URL=http://localhost:8000
UART_BRIDGE_URL=http://localhost:8100
VISION_CAPTURE_DELAY_S=2.5
VISION_TRIGGER_COOLDOWN_S=5.0
```
Manual capture still works the same as before, e.g.:
```
curl -X POST http://localhost:8200/capture/7
```

Live calibration/detection overlay, for eyeballing what the algorithm
currently sees (needs a display — see calibration.py's own headless note,
same constraint applies here):
```
uv run debug_view.py --lane 7
```
