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
import logging
import os

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException

from calibration import DEFAULT_OUTPUT_DIR, LaneCalibration, PinROI, load_calibration

log = logging.getLogger("vision.pinfall")

ALL_PINS_MASK = 0b11_1111_1111  # 10 bits -- used only to complement a standing mask into a fallen-right-now one for display

# A pin counts as fallen once its ROI brightness drops below this fraction
# of its own calibrated (standing) reference brightness. Per-pin and
# relative, not one global absolute brightness cutoff, since lighting is
# not uniform across the whole pin deck.
DEFAULT_BRIGHTNESS_RATIO = 0.6
STATE_MACHINE_URL = os.environ.get("STATE_MACHINE_URL", "http://localhost:8000")
API_HOST = "0.0.0.0"
API_PORT = 8200


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

    Each capture reopens the camera fresh (see capture_frame()), so
    auto-exposure/auto-white-balance re-settles to a slightly different
    point every time even with nothing physically different in the
    scene -- observed on the bench as a ~25-point mean-brightness swing
    between two back-to-back captures, i.e. a gain around 1.3x, well
    inside the cap either way. Without this correction that shows up as a
    uniform diff increase across nearly every pin's ROI at once (a global
    lighting change), swamping the local, per-pin difference an
    actually-fallen pin produces. A single global gain correction is
    enough to separate the two and is cheap enough to still make sense on
    an ESP32-CAM later."""
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
    # normalize_brightness() is still needed even with a per-pin relative
    # threshold: reopening the camera each capture re-settles
    # auto-exposure differently every time (see its docstring), which
    # would otherwise make every pin's *current* brightness read low
    # relative to baseline regardless of whether it actually fell.
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


def capture_frame(camera_index: int) -> np.ndarray:
    """Returns grayscale -- see this module's docstring for why color
    never makes it past this point."""
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        raise RuntimeError(f"could not open camera index {camera_index}")
    try:
        for _ in range(5):  # let auto-exposure settle, same as calibration.py
            cap.read()
        ok, frame = cap.read()
        if not ok:
            raise RuntimeError("camera read failed during capture")
        return cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    finally:
        cap.release()


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
app = FastAPI(title="openlanelink vision", version="0.1.0")


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


@app.get("/health")
async def health():
    return {"status": "ok"}


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
