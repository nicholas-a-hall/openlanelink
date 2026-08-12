"""Camera-based pinfall detection.

Per-pin brightness thresholding, not similarity-to-reference: pins are
light-colored/reflective, the lane surface a fallen pin exposes is darker,
so a pin is standing if its calibrated ROI is bright enough, fallen if it's
gone dark -- see pin_is_standing()'s docstring for why this replaced an
earlier "diff against the reference frame" approach that produced random
results under uneven scene brightness (e.g. holding a bright sheet of paper
up to the camera). This is deliberately simple (no ML, no full-frame blob
detection) so the same approach can realistically be ported to an
ESP32-CAM later -- see ../vision-esp32cam once that exists.

Pinfall convention: raw detection produces a **standing**-pin bitmask (bit
N-1 set = pin N still up), and that's ALL this daemon ever reports --
`/capture/{lane}` has no memory of any earlier capture and no `reset`
concept. It doesn't know whether this is the first ball of a frame or the
fifth; it just answers "which pins are standing right now." Turning that
into "here's what fell on THIS ball" requires knowing what was already
standing going into it, which is state_machine's job, not this daemon's --
see state_machine/game_state.py's standing_mask_before_next_ball() and
state_machine.py's on_pinfall_observed(). This mirrors the same "dumb
node, the thing with the actual state does the correlating" principle the
ESP32 mesh already follows (firmware/HANDOFF.md) -- vision emits a raw
observation and nothing else, same as a beam sensor emitting a raw edge
rather than trying to pair its own readings into a speed.

Grayscale only, never color: capture_frame() converts immediately after
reading from the camera, and calibration.py's saved reference frame is
grayscale too (see its capture_reference_frame() docstring) -- brightness
thresholding never looks at color, so nothing downstream of capture ever
touches a 3-channel frame.

Usage:
    uv run pinfall.py --lane 7 --once      # single capture, prints result, no server
    uv run pinfall.py                      # run the daemon (default if no --once)
"""

import argparse
import asyncio
import logging
import os
import threading
import time
from contextlib import asynccontextmanager

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Response

from bridge_client import watch_ball_detected
from calibration import DEFAULT_OUTPUT_DIR, LaneCalibration, PinROI, load_calibration

log = logging.getLogger("vision.pinfall")

ALL_PINS_MASK = 0b11_1111_1111  # 10 bits -- used only to complement a standing mask into a fallen-right-now one for display

# A pin counts as fallen once its ROI brightness drops below this fraction
# of its own calibrated (standing) reference brightness. Per-pin and
# relative, not one global absolute brightness cutoff, since lighting is
# not uniform across the whole pin deck.
DEFAULT_BRIGHTNESS_RATIO = 0.6
STATE_MACHINE_URL = os.environ.get("STATE_MACHINE_URL", "http://localhost:8000")
UART_BRIDGE_URL = os.environ.get("UART_BRIDGE_URL", "http://localhost:8100")
API_HOST = "0.0.0.0"
API_PORT = 8200

# After the downstream ball-detection beam breaks, wait this long before
# assuming the ball has reached the pins and settled, then snap a photo --
# same idea as ../state_machine/main.py's now-unused PHOTO_COOLDOWN_S, moved
# here since self-triggering vision is the process that actually acts on it
# (see bridge_client.py).
#
# Was 2.5s, which by itself overran the whole beam-break-to-scoresheet
# budget (target: under 1600ms end to end) before a single frame was even
# read. 500ms is the ceiling now, and note what that actually buys: the
# trigger beam sits UPSTREAM of the pins, so the ball is still travelling
# for roughly the first 100-200ms of this window -- 500ms after the beam is
# only ~300-400ms of real settling time after impact.
#
# How much travel time is in that window depends on WHICH node triggered, and
# this single constant covers both: a ball_detect_node's beam sits just
# before the pin deck (so nearly the whole window is settling time), while a
# speed_node's downstream beam is further back (so more of it is flight). A
# lane running both triggers off whichever fires first, i.e. the speed node's.
# If one node's placement ends up wanting a materially different delay than
# the other's, that's the point to split this into a per-role value rather
# than keep compromising between them.
#
# TUNE ON REAL HARDWARE, and tune it by watching for UNDERCOUNTS
# specifically: this delay's failure mode is asymmetric. Too long only
# costs latency, but too short reads a pin that is mid-topple (still
# upright, still bright) as standing, so the error is always a pinfall
# count that is too LOW -- a wrong score, not a slow one. A big hit with
# pins deflecting off the kickbacks back onto the deck is the case most
# likely to expose it. If undercounts show up here, the fix is to stop
# guessing a fixed number and settle adaptively (frame-to-frame diff over
# the pin deck until motion stops, floor ~500ms / ceiling ~1300ms) rather
# than to walk this constant back up.
CAPTURE_DELAY_S = float(os.environ.get("VISION_CAPTURE_DELAY_S", "0.5"))

# ---- Camera stream tuning (see _CameraStream) ----

# Frames older than this are refused rather than scored. The grabber thread
# republishes at camera framerate (~33ms at 30fps), so anything approaching
# a second old means the thread is wedged or the device stopped delivering.
# Returning a stale frame anyway is the dangerous failure here: it isn't a
# visibly broken capture, it's a confident pin count for a rack that may
# already have been swept -- same class of silent-wrong-answer this module
# guards against in normalize_brightness()'s gain cap.
FRAME_MAX_AGE_S = float(os.environ.get("VISION_FRAME_MAX_AGE_S", "1.0"))

# Discarded on OPEN only, not per capture -- auto-exposure/auto-white-balance
# need a few frames to settle after the device starts streaming, which is
# what the old per-capture reopen was paying for every single ball.
OPEN_WARMUP_FRAMES = int(os.environ.get("VISION_OPEN_WARMUP_FRAMES", "5"))

# How long the grabber thread waits before retrying a device that failed to
# open or stopped delivering -- unplugged/re-enumerated USB camera, mostly.
REOPEN_INTERVAL_S = float(os.environ.get("VISION_REOPEN_INTERVAL_S", "2.0"))

# Only ever paid by the capture that opens a stream (process start, or the
# first ball after POST /camera/release) -- it covers device open plus
# OPEN_WARMUP_FRAMES. Generous on purpose: this is the one path where a slow
# USB enumeration is normal rather than a fault, and failing it means
# dropping a real ball's score.
FIRST_FRAME_TIMEOUT_S = float(os.environ.get("VISION_FIRST_FRAME_TIMEOUT_S", "5.0"))

# Optional fixed exposure, applied once at open. Left unset by default
# because the right values are device-specific (and on V4L2 the
# auto-exposure property is an enum -- commonly 3 = auto, 1 = manual -- not
# a bool). Setting these is what actually removes the frame-to-frame
# brightness drift normalize_brightness() exists to correct; keeping the
# camera open removes most of it, pinning exposure removes the rest.
AUTO_EXPOSURE = os.environ.get("VISION_AUTO_EXPOSURE")  # e.g. "1" for manual on V4L2
EXPOSURE = os.environ.get("VISION_EXPOSURE")

# Camera indices probed once at startup to build the /cameras list.
CAMERA_PROBE_MAX_INDEX = int(os.environ.get("VISION_CAMERA_PROBE_MAX_INDEX", "8"))

# A probed index has to actually hand back a frame, not merely open. Windows
# in particular reports indices as opened that never deliver anything, and an
# operator picking one of those off a calibration menu gets a camera that
# looks selectable and then produces nothing.
CAMERA_PROBE_READS = 3


def crop_roi(gray_image: np.ndarray, pin: PinROI) -> np.ndarray:
    """Bounds-clamped square crop around a pin's calibrated center, sized
    by that pin's own radius (independently configurable per pin, down to
    a single pixel at radius=0 -- the +1 below is what makes radius=0
    yield a real 1x1 crop instead of an empty one). A square is simpler
    than a circular mask and close enough given the ROI is just a local
    brightness sample, not a precise pin outline. Takes an already-gray
    image -- see normalize_brightness()'s docstring for why grayscale
    conversion happens once for the whole frame rather than per-ROI."""
    h, w = gray_image.shape[:2]
    r = pin.radius
    x0, x1 = max(0, pin.x - r), min(w, pin.x + r + 1)
    y0, y1 = max(0, pin.y - r), min(h, pin.y + r + 1)
    return gray_image[y0:y1, x0:x1]


# Cap how much normalize_brightness() is allowed to correct a frame's
# overall brightness by, in EITHER direction -- see its docstring.
MAX_BRIGHTNESS_GAIN = 2.0
MIN_BRIGHTNESS_GAIN = 1.0 / MAX_BRIGHTNESS_GAIN


def normalize_brightness(frame_gray: np.ndarray, reference_gray: np.ndarray) -> np.ndarray:
    """Scales frame_gray so its overall mean brightness matches
    reference_gray's before any per-pin diffing happens -- but the gain is
    clamped to [MIN_BRIGHTNESS_GAIN, MAX_BRIGHTNESS_GAIN] in both
    directions. Beyond that range this is no longer "the same scene,
    slightly different exposure" (which is what it's actually for -- see
    below), it's "this frame doesn't represent the pin deck at all"
    (camera covered/blocked on the dark side; something bright and
    reflective held up close, e.g. paper, on the light side), and forcing
    it to match the reference's brightness anyway is actively harmful:
    that FLATTENS the one signal that would've said "something's wrong
    here" (a mean brightness wildly unlike any real pin-deck state) down
    into the SAME range as a normal frame, leaving classification riding
    on whatever's left -- camera noise, a paper's slight non-uniformity --
    which lands on either side of different pins' cutoffs essentially at
    random. Both directions were observed on the bench producing exactly
    that scattered, wrong per-pin result before this cap existed:
    - Dark/covered: ~23 mean vs a ~91 reference wanted a 4x gain.
      Uncapped, that pushed uniform sensor noise up past SOME pins'
      cutoffs and not others. Capped at 2x, the normalized frame stays
      well below every pin's cutoff -- correctly all 10 fallen.
    - Bright/paper: ~213 mean vs the same ~91 reference wanted a 0.43x
      gain. Uncapped, that dragged a frame that was unambiguously
      brighter than the reference everywhere back down to look like a
      completely ordinary one. Capped at 0.5x, the normalized frame stays
      well above every pin's cutoff -- correctly all 10 standing.

    This originally existed because every capture reopened the camera, so
    auto-exposure/auto-white-balance re-settled to a slightly different
    point every time even with nothing physically different in the scene --
    observed on the bench as a ~25-point mean-brightness swing between two
    back-to-back captures, i.e. a gain around 1.3x, well inside the cap
    either way. That showed up as a uniform diff increase across nearly
    every pin's ROI at once (a global lighting change), swamping the local,
    per-pin difference an actually-fallen pin produces.

    _CameraStream now holds the device open continuously, so exposure
    settles once at open and that per-capture swing is largely gone (and
    setting AUTO_EXPOSURE/EXPOSURE removes what's left). This correction
    stays anyway: house lights, a lane-side display, or daylight through a
    door all still drift the whole scene over a game, and it's the same
    cheap single-gain fix for that as it was for the reopen jitter. It's
    also still cheap enough to make sense on an ESP32-CAM later."""
    frame_mean = float(np.mean(frame_gray))
    if frame_mean < 1.0:
        return frame_gray
    gain = float(np.mean(reference_gray)) / frame_mean
    gain = max(MIN_BRIGHTNESS_GAIN, min(gain, MAX_BRIGHTNESS_GAIN))
    return np.clip(frame_gray.astype(np.float32) * gain, 0, 255).astype(np.uint8)


def pin_is_standing(frame_gray: np.ndarray, reference_gray: np.ndarray, pin: PinROI, brightness_ratio: float) -> bool:
    """Bright = standing, dark = fallen -- not "changed from the
    reference" in either direction. reference_gray isn't a live
    similarity check here, it's just where each pin's OWN baseline
    brightness comes from (lighting varies across the deck, so one
    global brightness cutoff for all 10 pins isn't reliable -- a pin
    under a dimmer part of the lane can be legitimately standing at a
    brightness another pin would only reach by falling). A pin standing
    but somehow *brighter* than its baseline (glare, reflection) still
    correctly reads standing, unlike the old diff-based check, which
    would have flagged that as "changed" too."""
    frame_roi = crop_roi(frame_gray, pin)
    ref_roi = crop_roi(reference_gray, pin)
    if frame_roi.size == 0 or ref_roi.size == 0:
        log.warning("pin %d empty ROI (frame=%s ref=%s), assuming standing", pin.pin, frame_roi.shape, ref_roi.shape)
        return True
    baseline = float(np.mean(ref_roi))
    if baseline < 1.0:
        log.warning("pin %d has a near-black calibrated baseline (%.1f), assuming standing", pin.pin, baseline)
        return True
    current = float(np.mean(frame_roi))
    return current >= baseline * brightness_ratio


def detect_standing_mask(frame_gray: np.ndarray, calib: LaneCalibration, reference_gray: np.ndarray, brightness_ratio: float = DEFAULT_BRIGHTNESS_RATIO) -> int:
    """frame_gray/reference_gray are already grayscale -- capture_frame()
    and calibration.load_calibration() both hand back grayscale directly
    now (see this module's docstring), so there's no color to convert
    away here anymore."""
    # normalize_brightness() is still worth running even with a per-pin
    # relative threshold and a continuously-open camera: any whole-scene
    # lighting drift makes every pin's *current* brightness read low
    # relative to its baseline regardless of whether it actually fell (see
    # its docstring).
    frame_gray = normalize_brightness(frame_gray, reference_gray)

    mask = 0
    for pin in calib.pins:
        if pin_is_standing(frame_gray, reference_gray, pin, brightness_ratio):
            mask |= 1 << (pin.pin - 1)
    return mask


def mask_to_pins(mask: int) -> list[int]:
    """Decodes a bitmask into the sorted list of pin numbers it contains
    -- callers (the /capture response) shouldn't have to decode bit
    positions themselves."""
    return [pin for pin in range(1, 11) if mask & (1 << (pin - 1))]


class _CameraStream:
    """One long-lived VideoCapture per camera index, with a background
    thread continuously reading frames so a capture is a memory read rather
    than a device open.

    This replaced a capture_frame() that did the whole
    open -> discard 5 frames -> read -> release dance on EVERY ball, which
    was the single largest cost in the beam-break-to-scoresheet budget:
    device open plus stream negotiation on a USB camera is typically
    300-1500ms, and the 5 discarded frames add another ~165ms at 30fps, to
    produce one frame that per-pin thresholding then classifies in about
    5ms. Holding the device open moves all of that to process start.

    It's also a correctness fix, not just a speed one. Reopening the device
    per capture made auto-exposure re-settle to a slightly different point
    every single time -- the ~25-point mean-brightness swing between
    back-to-back captures that normalize_brightness() was written to
    correct for (see its docstring). One continuously-streaming device
    settles once and stays settled, so that correction now has far less to
    do; setting AUTO_EXPOSURE/EXPOSURE removes the rest.

    Why a grabber thread rather than calling read() on demand: V4L2 hands
    back the OLDEST buffered frame, so an idle device accumulates a queue
    and an on-demand read returns something from seconds ago. Draining
    continuously means the newest frame is always the one on hand. CAP_PROP_
    BUFFERSIZE=1 asks the driver for the same thing, but it's advisory and
    widely ignored, so the thread is what actually guarantees it.

    The thread does the full read() (grab + decode) rather than splitting
    grab() here and retrieve() on the caller's thread: the split is a real
    OpenCV idiom, but a VideoCapture isn't safe to drive from two threads
    at once, and the frame it would save is worth ~1-3ms against a budget
    that has ~1500ms of margin once the device stays open.

    BGR is stashed and converted to grayscale on demand rather than in the
    thread -- converting at framerate would burn CPU continuously on a Pi
    to serve roughly one capture per ball."""

    def __init__(self, camera_index: int):
        self.camera_index = camera_index
        self._cap: cv2.VideoCapture | None = None
        self._frame: np.ndarray | None = None
        self._frame_at: float = 0.0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        # Set once the first frame lands. Streams open lazily, so without
        # something to wait on, the capture that TRIGGERS the open would
        # always lose the race against the device warming up -- i.e. the
        # first ball after startup, and every `--once` run, which opens a
        # stream and reads from it immediately.
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"camera-{camera_index}")

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)
        if self._cap is not None:
            self._cap.release()
            self._cap = None

    def _open(self) -> bool:
        cap = cv2.VideoCapture(self.camera_index)
        if not cap.isOpened():
            cap.release()
            return False
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if AUTO_EXPOSURE is not None:
            cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, float(AUTO_EXPOSURE))
        if EXPOSURE is not None:
            cap.set(cv2.CAP_PROP_EXPOSURE, float(EXPOSURE))
        for _ in range(OPEN_WARMUP_FRAMES):
            cap.read()
        self._cap = cap
        log.info("camera %d opened", self.camera_index)
        return True

    def _run(self) -> None:
        while not self._stop.is_set():
            if self._cap is None:
                if not self._open():
                    log.warning("camera %d unavailable, retrying in %.0fs", self.camera_index, REOPEN_INTERVAL_S)
                    self._stop.wait(REOPEN_INTERVAL_S)
                continue

            ok, frame = self._cap.read()
            if not ok:
                # Don't keep publishing the last good frame: read_gray()'s
                # age check is what turns a dead camera into a refused
                # capture instead of a wrong pin count, and that only works
                # if _frame_at stops advancing.
                log.warning("camera %d read failed, reopening", self.camera_index)
                self._cap.release()
                self._cap = None
                self._stop.wait(REOPEN_INTERVAL_S)
                continue

            with self._lock:
                self._frame = frame
                self._frame_at = time.monotonic()
            self._ready.set()

    def wait_ready(self, timeout: float) -> None:
        """Blocks until the device has produced its first frame. No-op once
        it has, so this only ever costs anything on the capture that opened
        the stream."""
        if not self._ready.wait(timeout):
            raise RuntimeError(f"camera {self.camera_index} produced no frame within {timeout:.1f}s of opening")

    def read_gray(self) -> np.ndarray:
        """Returns grayscale -- see this module's docstring for why color
        never makes it past this point. Raises rather than returning a
        stale frame; see FRAME_MAX_AGE_S."""
        with self._lock:
            frame = self._frame
            age = time.monotonic() - self._frame_at
        if frame is None:
            raise RuntimeError(f"camera {self.camera_index} has not delivered a frame yet")
        if age > FRAME_MAX_AGE_S:
            raise RuntimeError(f"camera {self.camera_index} frame is {age:.1f}s old (max {FRAME_MAX_AGE_S}s), refusing to score it")
        return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)


# camera_index -> its stream. Keyed by index, not lane, so two lanes sharing
# one camera share one device handle rather than fighting over it.
_streams: dict[int, _CameraStream] = {}


def get_stream(camera_index: int) -> _CameraStream:
    """Opened lazily on first use rather than at startup, so the daemon
    doesn't hold every camera open before a single ball has been thrown --
    that matters because a V4L2 device generally admits ONE capturing
    process, so a running daemon locks calibration.py and debug_view.py out
    of the device (see release_all())."""
    if camera_index not in _streams:
        stream = _CameraStream(camera_index)
        _streams[camera_index] = stream
        stream.start()
    return _streams[camera_index]


# Filled once by the lifespan startup, served by GET /cameras.
_available_cameras: list[dict] = []


def probe_cameras(max_index: int = CAMERA_PROBE_MAX_INDEX) -> list[dict]:
    """Enumerates camera indices that actually produce a frame, as
    {index, width, height}.

    Runs once at startup, before any stream exists, and deliberately does
    NOT go through _CameraStream: a stream treats a silent device as
    something to keep reopening forever, which is right for a lane camera
    that got unplugged mid-game and wrong for "is there anything on index
    5". This opens each index directly, requires a real successful read,
    and releases it again.

    Doing it here rather than in the calibration tool is what makes the
    answer trustworthy: this process is the one that will actually hold
    the device, so an index it can't read from is one detection could
    never have used either."""
    found = []
    for index in range(max_index):
        cap = cv2.VideoCapture(index)
        try:
            if not cap.isOpened():
                continue
            for _ in range(CAMERA_PROBE_READS):
                ok, frame = cap.read()
                if ok:
                    height, width = frame.shape[:2]
                    found.append({"index": index, "width": width, "height": height})
                    break
        finally:
            cap.release()
    return found


def drop_stream(camera_index: int) -> None:
    """Closes one stream and forgets it, so the next request for that index
    starts a fresh one."""
    stream = _streams.pop(camera_index, None)
    if stream is not None:
        stream.stop()


def release_all() -> None:
    """Drops every open device. Called from the lifespan shutdown so the
    daemon doesn't leave capture devices held on exit."""
    for stream in _streams.values():
        stream.stop()
    _streams.clear()


def capture_frame(camera_index: int) -> np.ndarray:
    """Kept as the seam the rest of this module captures through -- it just
    reads the newest frame off the always-on stream now. Only the capture
    that opens a stream pays FIRST_FRAME_TIMEOUT_S; every one after it is a
    memory read."""
    stream = get_stream(camera_index)
    stream.wait_ready(FIRST_FRAME_TIMEOUT_S)
    return stream.read_gray()


class _LaneDetector:
    """Caches a lane's calibration + reference frame (both static once
    calibrated) so /capture doesn't re-read files from disk on every
    call. That's the only thing cached -- no per-ball/per-lane state at
    all, unlike an earlier version of this class (see this module's
    docstring for why that changed)."""

    def __init__(self, output_dir=DEFAULT_OUTPUT_DIR):
        self.output_dir = output_dir
        self._calib_cache: dict[int, tuple[LaneCalibration, np.ndarray]] = {}

    def _calib(self, lane: int) -> tuple[LaneCalibration, np.ndarray]:
        if lane not in self._calib_cache:
            try:
                self._calib_cache[lane] = load_calibration(lane, self.output_dir)
            except FileNotFoundError as e:
                raise HTTPException(status_code=404, detail=f"no calibration for lane {lane}: {e}")
        return self._calib_cache[lane]

    def capture(self, lane: int, brightness_ratio: float) -> dict:
        calib, reference = self._calib(lane)
        frame = capture_frame(calib.camera_index)
        standing_mask = detect_standing_mask(frame, calib, reference, brightness_ratio)
        standing_pins = mask_to_pins(standing_mask)
        fallen_pins = mask_to_pins(~standing_mask & ALL_PINS_MASK)
        return {
            "lane": lane,
            "standingMask": standing_mask,
            "standingCount": len(standing_pins),
            "fallenCount": len(fallen_pins),
            "standingPins": standing_pins,
            "fallenPins": fallen_pins,
        }


detector = _LaneDetector()

# Lanes with a self-triggered capture currently between trigger and report.
# This replaced a flat 5s TRIGGER_COOLDOWN_S, which was trying to express
# "one capture per ball" as a duration and got it wrong in both directions:
# too short to be a real guarantee if a capture ever ran long, and long
# enough to silently DROP a legitimately fast second ball -- an outcome that
# gets more likely, not less, now that a capture completes in well under a
# second.
#
# What it's actually defending against is unchanged: a bounced or re-broken
# beam (both emitting nodes debounce at 30ms, so a re-break past that emits a
# second BROKEN), and a lane covered by BOTH a speed_node and a
# ball_detect_node, where two sensors legitimately report the same ball --
# no longer hypothetical as of 2026-08-12, when ball_detect_node was
# actually built. Neither is a "too soon" problem, they're a "this ball is
# already being handled" problem, so that's what's tracked.
#
# It matters that this is a duplicate-SCORE guard and not just a
# duplicate-work one. A second report for one ball reaches state_machine's
# ungated /pinfall endpoint, gets diffed against an already-updated
# standing_mask_before_next_ball(), derives zero pins fallen, and records a
# phantom second ball of 0 on the scoresheet.
#
# A plain set needs no lock: every mutation happens in _on_ball_detected on
# the single event loop, and there's no await between the membership check
# and the add.
_capture_in_flight: set[int] = set()
_bridge_task: asyncio.Task | None = None


async def _report_standing_mask(lane: int, standing_mask: int) -> None:
    """POSTs to state_machine's generic pinfall endpoint -- the raw
    observation, nothing derived (see this module's docstring).
    state_machine computes the actual pinfall count/fallen-mask itself.
    Key name is snake_case to match that endpoint's own body convention
    (PinfallObserved.standing_mask), not this daemon's own camelCase
    /capture response."""
    import httpx

    url = f"{STATE_MACHINE_URL}/api/lanes/{lane}/pinfall"
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.post(url, json={"standing_mask": standing_mask})
            if resp.status_code >= 400:
                log.warning("state machine rejected pinfall report: %s %s", resp.status_code, resp.text)
    except httpx.HTTPError as e:
        log.warning("state machine unreachable, dropping pinfall report for lane %s: %s", lane, e)


async def _on_ball_detected(lane: int) -> None:
    """Callback for bridge_client.watch_ball_detected() -- fires on every
    ball-at-the-pins beam break for a lane, from either emitting node (see
    that module's TRIGGER_ROLES). Applies the same settle-then-capture shape
    as a manual /capture/{lane} call, just self-triggered instead of
    operator- or bench-triggered.

    The in-flight guard covers the whole settle-capture-report span, not
    just the capture: the duplicate trigger this exists to absorb (a bounced
    beam, or a second sensor on the same lane) arrives during the settle
    wait, which is the one window where nothing else would catch it."""
    if lane in _capture_in_flight:
        log.info("Lane %d: capture already in flight, duplicate trigger ignored", lane)
        return
    _capture_in_flight.add(lane)
    try:
        await asyncio.sleep(CAPTURE_DELAY_S)
        try:
            result = detector.capture(lane, DEFAULT_BRIGHTNESS_RATIO)
        except (HTTPException, RuntimeError) as e:
            # RuntimeError is the camera stream refusing to hand back a
            # stale frame (see _CameraStream.read_gray) -- reporting
            # nothing is correct there, since the alternative is scoring a
            # frame that may predate this ball entirely.
            detail = e.detail if isinstance(e, HTTPException) else str(e)
            log.warning("Lane %d: self-triggered capture failed: %s", lane, detail)
            return
        await _report_standing_mask(lane, result["standingMask"])
        log.info("Lane %d: self-triggered capture -- standing pins %s", lane, result["standingPins"])
    finally:
        _capture_in_flight.discard(lane)


@asynccontextmanager
async def _lifespan(_app):
    global _bridge_task
    global _available_cameras
    # Before anything opens a stream, so the probe isn't fighting a device
    # this process is already holding.
    _available_cameras = probe_cameras()
    log.info(
        "cameras available: %s",
        ", ".join(f"{c['index']} ({c['width']}x{c['height']})" for c in _available_cameras) or "none",
    )

    _bridge_task = asyncio.create_task(watch_ball_detected(UART_BRIDGE_URL, _on_ball_detected))
    log.info("watching UART bridge at %s for ball-detection events", UART_BRIDGE_URL)
    yield
    _bridge_task.cancel()
    release_all()


app = FastAPI(title="openlanelink vision", version="0.1.0", lifespan=_lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/cameras")
async def cameras():
    """Camera indices this daemon found at startup. calibration.py's
    picker and debug_view.py's preflight check both read this instead of
    probing devices themselves -- they can't probe anyway once this
    process holds the cameras, and an index this daemon can't read is one
    they should never offer."""
    return {"cameras": _available_cameras}


@app.get("/frame/{camera_index}")
def frame(camera_index: int, format: str = "png"):
    """The one place a frame leaves this process. calibration.py and
    debug_view.py both pull frames through here instead of opening the
    capture device themselves, which is what actually keeps the three in
    sync:

    - Identical resolution. A calibration captured at one frame size and
      detection running at another pushes every pin ROI off the frame, and
      crop_roi()'s empty-slice fallback then reports each affected pin as
      STANDING -- i.e. a strike silently scores as a full rack. Sharing one
      stream makes that mismatch unrepresentable rather than something to
      validate against.
    - Identical exposure state. Detection is a ratio between a pin's
      current brightness and its calibrated baseline, so a reference frame
      captured through a separately-opened device (its own auto-exposure
      settle, its own properties) biases every comparison made against it.
    - One opener. V4L2 generally only lets one process capture from a
      device, so the tools and the daemon can't both hold it.

    png is lossless and is what capture_reference_frame() must use. jpeg
    exists for live preview polling, where 34ms of PNG encode per frame is
    the bottleneck; at q90 it moves a pin's mean brightness by under 0.1
    against the ~90-unit margin between a standing pin and its cutoff, so
    it stays safe for detection too.

    Sync `def` on purpose: FastAPI runs it in a threadpool, so waiting on a
    cold device here can't stall the event loop that the self-triggered
    captures and the bridge subscription run on."""
    if format not in ("png", "jpeg"):
        raise HTTPException(status_code=400, detail=f"unknown format {format!r}, expected 'png' or 'jpeg'")

    stream = get_stream(camera_index)
    try:
        stream.wait_ready(FIRST_FRAME_TIMEOUT_S)
        gray = stream.read_gray()
    except RuntimeError as e:
        # Forget the stream rather than leave its grabber thread reopening
        # a device that isn't there: calibration.py probes camera indices
        # through this endpoint, so every miss would otherwise leak a
        # thread that retries forever.
        drop_stream(camera_index)
        raise HTTPException(status_code=503, detail=str(e))

    if format == "png":
        ok, buf = cv2.imencode(".png", gray)
        media_type = "image/png"
    else:
        ok, buf = cv2.imencode(".jpg", gray, [cv2.IMWRITE_JPEG_QUALITY, 90])
        media_type = "image/jpeg"
    if not ok:
        raise HTTPException(status_code=500, detail=f"could not encode frame as {format}")
    return Response(content=buf.tobytes(), media_type=media_type)


@app.post("/capture/{lane}")
async def capture(lane: int, brightness_ratio: float = DEFAULT_BRIGHTNESS_RATIO):
    result = detector.capture(lane, brightness_ratio)
    await _report_standing_mask(lane, result["standingMask"])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lane", type=int, help="required for --once")
    parser.add_argument("--once", action="store_true", help="single capture printed to stdout, no server")
    parser.add_argument("--brightness-ratio", type=float, default=DEFAULT_BRIGHTNESS_RATIO, help="pin counted as fallen once its ROI brightness drops below this fraction of its calibrated baseline")
    parser.add_argument("--host", default=API_HOST)
    parser.add_argument("--port", type=int, default=API_PORT)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)

    if args.once:
        if args.lane is None:
            parser.error("--once requires --lane")
        print(detector.capture(args.lane, args.brightness_ratio))
        return

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
