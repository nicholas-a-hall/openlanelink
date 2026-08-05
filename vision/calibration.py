"""Camera + pin-position calibration.

NOT YET IMPLEMENTED. Two calibration steps are needed before pinfall.py can
work:
  1. Camera calibration -- lens distortion / perspective correction so pixel
     coordinates map cleanly onto real lane coordinates.
  2. Pin-position calibration -- the pixel (or lane-coordinate) location of
     each of the 10 standard pin spots, specific to this camera's mounting.

Plan: a one-time interactive routine (e.g. click each pin spot in a captured
reference frame with a full rack) that writes a small config file consumed by
pinfall.py. Not started.
"""
