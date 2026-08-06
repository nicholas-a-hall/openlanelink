# openlanelink vision daemon

Camera-based pinfall detection. Runs as its own daemon directly on the Pi,
**outside Docker**, with direct access to the camera hardware — deliberately
NOT part of the `state_machine/` Docker-composed API service. See
`../DEVELOPING.md` for the platform-wide reasoning; short version: device
passthrough for a camera (and whatever hardware acceleration OpenCV wants)
is exactly the kind of thing that's simpler to give direct host access than
to fight through a container boundary, so this stays a separate, un-Dockerized
process instead.

## Layout
- `pinfall.py` — camera capture + standing-pin detection. **Not implemented.**
- `calibration.py` — camera/pin-position calibration routine. **Not implemented.**

## Status (2026-07-18)
Nothing here is implemented yet — both modules raise `NotImplementedError`.
`pinfall.py`'s raw output is a **standing**-pin mask (bit=1 = pin still up),
since that's the direct thing a frame can tell you; `standing_to_pinfall_mask()`
converts that (as a before/after diff) into the **fallen**-pin convention
`firmware/PROTOCOL.md`'s `MSG_SCORE_EVENT.pinfallMask` actually uses. Don't
conflate the two — they're complements of each other.

## Integration with the scoring API — NOT YET SPECIFIED
This daemon needs to:
1. Know **when** to capture (triggered by the compute node's ball-speed
   cooldown timer, currently in `state_machine/main.py`'s `on_beam_event` TODO).
2. Report the resulting pinfall back to the compute node once determined.

Neither direction is wired up yet. The likely shape — this daemon exposing a
small local HTTP endpoint the compute node calls to trigger a capture, and
calling back into the compute node's REST API (`state_machine/api.py`) once it has
a result — follows the platform's "REST is the command interface" principle,
but hasn't been confirmed. Pick this up before wiring `on_beam_event`'s
capture TODO.

## Running
```
pip install -r requirements.txt
python pinfall.py   # once there's an entry point -- none yet
```
