"""Live camera view with the calibrated pins overlaid: each pin's ROI
circle, current brightness vs. its calibrated cutoff, and a
standing/fallen color -- for eyeballing detection quality (and spotting a
bad calibration, like an outlier baseline) without reading raw numbers off
a one-off diagnostic script every time.

Not part of the actual detection path (pinfall.py) or the calibration
tool (calibration.py) -- this only reads an existing calibration and
displays what pinfall.py's detect_standing_mask() would currently see.

REQUIRES THE VISION DAEMON, same as calibration.py and for the same
reason: frames come from its GET /frame/{camera_index} rather than from a
device opened here, so this shows the exact frames detection is working
from. A separately-opened device would have its own exposure state, which
would make this overlay a plausible-looking view of something detection
never sees -- the worst possible failure for a diagnostic tool.

Usage:
    uv run debug_view.py --lane 7
"""

import argparse

import cv2
import numpy as np

from calibration import DEFAULT_OUTPUT_DIR, fetch_frame, list_cameras, load_calibration
from pinfall import DEFAULT_BRIGHTNESS_RATIO, crop_roi, normalize_brightness

STANDING_COLOR = (0, 255, 0)
FALLEN_COLOR = (0, 0, 255)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lane", type=int, required=True)
    parser.add_argument("--brightness-ratio", type=float, default=DEFAULT_BRIGHTNESS_RATIO)
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    calib, reference_gray = load_calibration(args.lane, args.output_dir)

    # Checked up front against the daemon's own enumeration rather than
    # discovered one failed frame at a time. A calibration records the
    # camera index it was made against, so pointing this at a daemon that
    # doesn't have that camera -- a lane calibration opened on a laptop, a
    # camera not plugged in yet -- otherwise just spins on 503s with
    # nothing saying which camera is missing or which ones exist.
    available = {cam["index"] for cam in list_cameras()}
    if calib.camera_index not in available:
        raise SystemExit(
            f"lane {args.lane} is calibrated against camera index {calib.camera_index}, "
            f"which the vision daemon does not have (it found: {sorted(available) or 'none'}). "
            f"Point VISION_URL at the daemon that owns that camera, or recalibrate this lane."
        )

    baselines = {pin.pin: float(np.mean(crop_roi(reference_gray, pin))) for pin in calib.pins}

    window = f"openlanelink vision - lane {args.lane} live overlay"
    try:
        while True:
            # jpeg, not png: this is a live view, and q90 shifts a pin's
            # mean brightness by under 0.1 against a ~90-unit standing/
            # fallen margin, so the verdicts shown still match what
            # detection would decide on the raw frame.
            frame_gray = fetch_frame(calib.camera_index, "jpeg")
            normalized = normalize_brightness(frame_gray, reference_gray)

            # Color overlay drawn on a BGR copy of the (grayscale) live
            # frame -- matches calibration.py's same display-only pattern,
            # the underlying comparison below stays grayscale throughout.
            display = cv2.cvtColor(frame_gray, cv2.COLOR_GRAY2BGR)
            standing_count = 0
            for pin in calib.pins:
                current = float(np.mean(crop_roi(normalized, pin)))
                baseline = baselines[pin.pin]
                cutoff = baseline * args.brightness_ratio
                standing = current >= cutoff
                standing_count += standing
                color = STANDING_COLOR if standing else FALLEN_COLOR
                radius = max(pin.radius, 1)
                cv2.circle(display, (pin.x, pin.y), radius, color, 2)
                cv2.putText(
                    display, f"{pin.pin}: {current:.0f}/{cutoff:.0f}",
                    (pin.x - radius, pin.y - radius - 6),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1,
                )

            cv2.putText(
                display, f"{standing_count}/10 standing -- q to quit",
                (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2,
            )
            cv2.imshow(window, display)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    finally:
        cv2.destroyWindow(window)


if __name__ == "__main__":
    main()
