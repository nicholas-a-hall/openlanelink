"""Interactive pin-position calibration for a single lane's camera.

Run once per lane (or whenever the camera gets bumped): freezes a still
frame of the empty, fully-racked pin deck, then lets the operator mark
each of the 10 pin positions -- standard USBC numbering:

        7  8  9  10
         4  5  6
          2  3
           1

Marking is pin-first, not click-order-first: press a digit key (1-9, 0 for
pin 10) to select which pin you're placing, then click its location on the
frame. Re-pressing a digit and clicking again overwrites that pin's
coordinate, so you can mark pins in whatever order the camera angle makes
them identifiable and fix a single misclick without redoing the others.

Each pin's detection ROI is independently resizable, down to a single
pixel: +/- (or -/_) adjust the selected pin's radius by 1px, [ and ]
adjust it by 5px. A newly-placed pin starts at whatever radius was most
recently set (DEFAULT_ROI_RADIUS_PX to start), so dialing in a size once
and then placing several pins in a row keeps that size without
re-adjusting each one -- but every pin's radius is saved independently,
so any of them can still be shrunk or grown on its own afterwards.

Saves the reference frame + per-pin ROI centers/radii to a JSON file that
pinfall.py loads at detection time.

REQUIRES THE VISION DAEMON. This tool never opens a capture device itself
-- every frame comes from pinfall.py's GET /frame/{camera_index} (see that
endpoint's docstring for why all three of pinfall/calibration/debug_view
share one stream). So the daemon has to be running before you calibrate.
That's deliberate rather than a limitation worked around with a fallback:
if the daemon can't start, the lane can't score anyway, so a calibration
tool that quietly kept working against a device the daemon couldn't hold
would just produce a reference frame captured under different camera
settings than detection will ever see.

Because the reference is captured through the daemon's stream, it also
bakes in whatever exposure settings that daemon was started with -- if
VISION_AUTO_EXPOSURE/VISION_EXPOSURE change later, recalibrate.

Usage:
    uv run calibration.py --lane 7                # prompts if more than one camera is detected
    uv run calibration.py --lane 7 --camera 0      # or pick one explicitly, no prompt
    uv run calibration.py --list-cameras           # just probe and list, no calibration
"""

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import httpx
import numpy as np

import cv2

DEFAULT_OUTPUT_DIR = Path(__file__).parent / "calibration"
DEFAULT_ROI_RADIUS_PX = 18
PIN_ORDER = list(range(1, 11))  # click order: pin 1 through pin 10


VISION_URL = os.environ.get("VISION_URL", "http://localhost:8200")

# Generous because a cold camera index costs the daemon a device open plus
# its warm-up frames before the first frame exists (pinfall.py's
# FIRST_FRAME_TIMEOUT_S covers the same wait on its side).
FRAME_FETCH_TIMEOUT_S = float(os.environ.get("VISION_FRAME_FETCH_TIMEOUT_S", "10.0"))


class DaemonUnreachableError(RuntimeError):
    """The daemon isn't answering at all. Deliberately distinct from
    CameraUnavailableError so probing can't collapse "the vision service is
    down" into "no cameras found" -- those want completely different
    actions from the operator, and the second one sends them hunting for a
    cable that's fine."""


class CameraUnavailableError(RuntimeError):
    """The daemon is up but can't get frames from this camera index."""


# One reused connection, not httpx.get() per call. This is not a
# micro-optimisation: building a fresh client per request measured ~2070ms
# on Windows (connection setup, before a single byte of frame moves),
# against 7.5ms for a jpeg frame over a warm connection. Per-call clients
# made the preview loops in this module and debug_view.py run at well
# under 1 fps and looked exactly like a slow camera.
_client = httpx.Client(timeout=FRAME_FETCH_TIMEOUT_S)


def fetch_frame(camera_index: int, fmt: str = "png") -> np.ndarray:
    """Pulls one grayscale frame from the daemon. png (default) is
    lossless and is what a saved reference frame must come from; jpeg is
    for preview loops, where PNG's ~34ms encode per frame is the limiting
    cost. See pinfall.py's /frame endpoint for why frames come from there
    rather than from a device this process opens."""
    url = f"{VISION_URL.rstrip('/')}/frame/{camera_index}"
    try:
        resp = _client.get(url, params={"format": fmt})
    except httpx.HTTPError as e:
        raise DaemonUnreachableError(
            f"vision daemon unreachable at {VISION_URL} ({e}) -- it must be running, see this module's docstring"
        ) from e
    if resp.status_code == 503:
        raise CameraUnavailableError(f"camera index {camera_index} is not producing frames: {resp.text}")
    resp.raise_for_status()
    frame = cv2.imdecode(np.frombuffer(resp.content, np.uint8), cv2.IMREAD_GRAYSCALE)
    if frame is None:
        raise CameraUnavailableError(f"could not decode frame returned for camera index {camera_index}")
    return frame


def list_cameras() -> list[dict]:
    """The daemon's startup camera enumeration, as {index, width, height}.

    This process does no probing of its own. It used to walk indices 0..8
    asking the daemon for a frame from each, which was wrong twice over:
    every absent index cost a full FIRST_FRAME_TIMEOUT_S
    before it gave up (so listing cameras took the better part of a
    minute), and an index that opens without ever delivering a frame --
    common on Windows -- still got offered to the operator as a real
    choice. The daemon already answers this correctly at startup, before
    it holds any device, so ask it. See pinfall.py's probe_cameras()."""
    url = f"{VISION_URL.rstrip('/')}/cameras"
    try:
        resp = _client.get(url)
    except httpx.HTTPError as e:
        raise DaemonUnreachableError(
            f"vision daemon unreachable at {VISION_URL} ({e}) -- it must be running, see this module's docstring"
        ) from e
    resp.raise_for_status()
    return resp.json()["cameras"]


def find_camera() -> int:
    """Returns the first working camera index. Raises if none is found --
    callers should tell the operator to plug one in and pick an explicit
    --camera rather than silently guessing. Kept as a standalone
    single-answer helper (unlike choose_camera() below) since a future
    automated/headless caller -- or the configuration UI this is meant to
    grow into, see choose_camera()'s docstring -- may want "just give me
    a camera" without a terminal prompt in the loop."""
    cameras = list_cameras()
    if not cameras:
        raise RuntimeError("the vision daemon found no working cameras -- check that one is plugged in, then restart the daemon so it re-probes")
    return cameras[0]["index"]


def choose_camera() -> int:
    """Lists detected cameras and, if more than one is found, prompts the
    operator to pick one interactively rather than silently defaulting to
    the first (find_camera()'s behavior) -- guessing wrong on a machine
    with more than one camera attached (a laptop's built-in webcam
    alongside a USB one, for instance) means calibrating against the
    wrong physical camera with no obvious symptom until detection is
    already misbehaving on a live lane. Auto-picks without prompting when
    there's only one candidate, since there's nothing to actually choose.

    This is the CLI-only version of camera selection -- a real picker
    (dropdown, live preview thumbnails) belongs in the configuration UI
    this project is expected to grow eventually; list_cameras() already
    returns exactly the {index, width, height} data such a UI would want,
    this function's terminal input() loop is the part that wouldn't
    carry over."""
    cameras = list_cameras()
    if not cameras:
        raise RuntimeError("the vision daemon found no working cameras -- check that one is plugged in, then restart the daemon so it re-probes")
    if len(cameras) == 1:
        return cameras[0]["index"]

    print("Multiple cameras detected:")
    for i, cam in enumerate(cameras):
        print(f"  [{i}] index {cam['index']}: {cam['width']}x{cam['height']}")
    while True:
        choice = input(f"Select a camera [0-{len(cameras) - 1}]: ").strip()
        if choice.isdigit() and 0 <= int(choice) < len(cameras):
            return cameras[int(choice)]["index"]
        print(f"Invalid selection {choice!r}, try again.")


@dataclass
class PinROI:
    pin: int
    x: int
    y: int
    radius: int  # pixels; 0 = a single pixel. Independent per pin, not lane-wide.


@dataclass
class LaneCalibration:
    lane: int
    camera_index: int
    frame_width: int
    frame_height: int
    reference_image: str  # filename, relative to the calibration file's own directory
    pins: list[PinROI]

    def to_json(self) -> dict:
        d = asdict(self)
        return d

    @staticmethod
    def from_json(d: dict) -> "LaneCalibration":
        pins = [PinROI(**p) for p in d["pins"]]
        return LaneCalibration(
            lane=d["lane"],
            camera_index=d["camera_index"],
            frame_width=d["frame_width"],
            frame_height=d["frame_height"],
            reference_image=d["reference_image"],
            pins=pins,
        )


def calibration_paths(lane: int, output_dir: Path) -> tuple[Path, Path]:
    """Returns (json_path, reference_image_path) for a lane's calibration."""
    return output_dir / f"lane_{lane}.json", output_dir / f"lane_{lane}_reference.png"


def load_calibration(lane: int, output_dir: Path = DEFAULT_OUTPUT_DIR) -> tuple[LaneCalibration, "cv2.Mat"]:
    """Loads a lane's saved calibration and its reference frame together --
    pinfall.py always needs both, never just one. cv2.imread() defaults to
    loading as 3-channel BGR even for a single-channel PNG on disk, so
    IMREAD_GRAYSCALE is required here -- without it, this would silently
    hand back a 3-channel Mat that just happens to have R=G=B everywhere,
    not the single-channel array the rest of this module (and pinfall.py)
    assumes."""
    json_path, _ = calibration_paths(lane, output_dir)
    data = json.loads(json_path.read_text())
    calib = LaneCalibration.from_json(data)
    ref_path = output_dir / calib.reference_image
    reference = cv2.imread(str(ref_path), cv2.IMREAD_GRAYSCALE)
    if reference is None:
        raise FileNotFoundError(f"reference image missing or unreadable: {ref_path}")
    return calib, reference


class _ClickCollector:
    """Owns the frozen-frame window's mouse callback and click state so the
    main loop below can stay a plain, readable state machine instead of
    threading click state through globals.

    Pins are identified by number, not by click order: a digit key (1-9,
    0 for pin 10) selects which pin you're about to place -- the
    highlighted one in the render -- and a click places/overwrites *that*
    pin's coordinate. This lets you mark pins in whatever order they're
    actually identifiable from the camera angle, and fix a single
    misclick by reselecting that pin and clicking again, rather than
    being locked into a fixed 1-10 order with only a stack-style undo."""

    def __init__(self, frame, default_radius: int):
        self.frame = frame
        self.marks: dict[int, PinROI] = {}
        self.selected = 1
        self.current_radius = default_radius  # applied to the next newly-placed pin

    @property
    def done(self) -> bool:
        return len(self.marks) == len(PIN_ORDER)

    def select(self, pin: int):
        if pin not in PIN_ORDER:
            return
        self.selected = pin
        if pin in self.marks:
            self.current_radius = self.marks[pin].radius

    def on_mouse(self, event, x, y, _flags, _userdata):
        if event != cv2.EVENT_LBUTTONDOWN:
            return
        self.marks[self.selected] = PinROI(pin=self.selected, x=x, y=y, radius=self.current_radius)
        remaining = [p for p in PIN_ORDER if p not in self.marks]
        if remaining:
            self.selected = remaining[0]  # convenience: hop to the next unmarked pin

    def resize_selected(self, delta: int):
        """Adjusts the radius that will apply to the selected pin -- if
        it's already placed, its saved radius updates live; if not, this
        just changes what the next click will use."""
        self.current_radius = max(0, self.current_radius + delta)
        if self.selected in self.marks:
            mark = self.marks[self.selected]
            self.marks[self.selected] = PinROI(pin=mark.pin, x=mark.x, y=mark.y, radius=self.current_radius)

    def ordered_marks(self) -> list[PinROI]:
        return [self.marks[p] for p in PIN_ORDER]

    def render(self):
        display = self.frame.copy()
        for pin_num, mark in self.marks.items():
            color = (0, 165, 255) if pin_num == self.selected else (0, 255, 0)
            cv2.circle(display, (mark.x, mark.y), max(mark.radius, 1), color, 2)
            cv2.putText(
                display, str(pin_num), (mark.x - 6, mark.y + 6),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2,
            )
        status = (
            f"Selected pin {self.selected}, radius {self.current_radius}px -- click to place "
            f"(digits 1-9,0=pin10 select, +/-=resize 1px, [/]=resize 5px, r=restart, q=quit) -- "
            f"{len(self.marks)}/10 marked"
        )
        if self.done:
            status += " -- press s to save"
        cv2.putText(display, status, (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 2)
        return display


def capture_reference_frame(camera_index: int):
    """Live preview until the operator confirms the deck is empty and
    presses SPACE, then fetches the frame that gets saved as the reference.
    Frames come from the daemon's stream, not a device opened here -- see
    this module's docstring and pinfall.py's /frame endpoint. No warm-up
    loop anymore: the daemon's stream is already running and settled by the
    time this asks it for anything.

    The preview polls jpeg but the returned reference is re-fetched as
    png. That's the one place the distinction matters: every later
    detection is a ratio against this frame's per-pin brightness, so it has
    to be exactly what the camera produced, not a re-encode of it. The
    extra fetch costs one frame's latency on an empty deck where nothing is
    moving, so the operator gets what they were looking at.

    Returns grayscale, not the camera's native color frame: detection
    (pinfall.py) is a brightness-only comparison and never looks at color
    at all, so carrying color through capture/storage/comparison the
    whole way is pure waste -- and this needs to port to an ESP32-CAM
    later, which would much rather grab a small grayscale/Y-plane frame
    than a full-color one. The preview window itself is converted back to
    BGR only so the on-screen instructions can be drawn in color (see
    below) -- that's a display-only copy, not what's captured/returned."""
    window = "openlanelink calibration - reference frame"
    try:
        while True:
            frame_gray = fetch_frame(camera_index, "jpeg")
            preview = cv2.cvtColor(frame_gray, cv2.COLOR_GRAY2BGR)
            cv2.putText(
                preview, "Empty, fully-racked deck? Press SPACE to capture, q to quit",
                (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2,
            )
            cv2.imshow(window, preview)
            key = cv2.waitKey(1) & 0xFF
            if key == ord(" "):
                return fetch_frame(camera_index, "png")
            if key == ord("q"):
                sys.exit("calibration aborted")
    finally:
        cv2.destroyWindow(window)


def collect_pin_clicks(frame, default_radius: int = DEFAULT_ROI_RADIUS_PX):
    window = "openlanelink calibration - mark pins"
    collector = _ClickCollector(frame, default_radius)
    cv2.namedWindow(window)
    # Show the window and pump the event loop once *before* attaching the
    # mouse callback -- some OpenCV HighGUI backends don't reliably bind a
    # callback to a window that hasn't been shown/drawn yet.
    cv2.imshow(window, collector.render())
    cv2.waitKey(1)
    cv2.setMouseCallback(window, collector.on_mouse)
    try:
        while True:
            cv2.imshow(window, collector.render())
            key = cv2.waitKey(20) & 0xFF
            if ord("0") <= key <= ord("9"):
                digit = key - ord("0")
                collector.select(10 if digit == 0 else digit)
            elif key in (ord("+"), ord("=")):
                collector.resize_selected(1)
            elif key in (ord("-"), ord("_")):
                collector.resize_selected(-1)
            elif key == ord("]"):
                collector.resize_selected(5)
            elif key == ord("["):
                collector.resize_selected(-5)
            elif key == ord("r"):
                collector.marks.clear()
                collector.selected = 1
            elif key == ord("s") and collector.done:
                return collector.ordered_marks()
            elif key == ord("q"):
                sys.exit("calibration aborted")
    finally:
        cv2.destroyWindow(window)


def run_calibration(lane: int, camera_index: int, default_radius: int, output_dir: Path) -> Path:
    frame_gray = capture_reference_frame(camera_index)
    height, width = frame_gray.shape[:2]
    # The click-marking window still wants color (green/orange markers) --
    # converted from the grayscale frame just for that display, same as
    # capture_reference_frame()'s own preview. What gets saved to disk
    # below is the grayscale frame, not this.
    display_frame = cv2.cvtColor(frame_gray, cv2.COLOR_GRAY2BGR)
    pins = collect_pin_clicks(display_frame, default_radius)

    output_dir.mkdir(parents=True, exist_ok=True)
    json_path, ref_path = calibration_paths(lane, output_dir)
    cv2.imwrite(str(ref_path), frame_gray)

    calib = LaneCalibration(
        lane=lane,
        camera_index=camera_index,
        frame_width=width,
        frame_height=height,
        reference_image=ref_path.name,
        pins=pins,
    )
    json_path.write_text(json.dumps(calib.to_json(), indent=2))
    return json_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lane", type=int, help="required unless --list-cameras")
    parser.add_argument("--camera", type=int, default=None, help="OpenCV camera index; auto-detected if omitted")
    parser.add_argument("--default-radius", type=int, default=DEFAULT_ROI_RADIUS_PX, help="starting ROI radius (px) for newly-placed pins; each pin is independently resizable during calibration")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--list-cameras", action="store_true", help="probe camera indices and list what's found, then exit")
    args = parser.parse_args()

    if args.list_cameras:
        cameras = list_cameras()
        if not cameras:
            print("no cameras detected by the vision daemon -- plug one in and restart it so it re-probes")
        for cam in cameras:
            print(f"  index {cam['index']}: {cam['width']}x{cam['height']}")
        return

    if args.lane is None:
        parser.error("--lane is required unless --list-cameras is given")

    camera_index = args.camera
    if camera_index is None:
        camera_index = choose_camera()
        print(f"using camera index {camera_index}")

    json_path = run_calibration(args.lane, camera_index, args.default_radius, args.output_dir)
    print(f"Saved calibration for lane {args.lane} to {json_path}")


if __name__ == "__main__":
    main()
