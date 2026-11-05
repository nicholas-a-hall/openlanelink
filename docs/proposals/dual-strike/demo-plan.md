---
layout: default
title: DUAL-STRIKE — proposed isolated demo
---

# DUAL-STRIKE: proposed demo and validation plan

**Status: proposal, not a runnable demo.** This document defines the next software milestone and its acceptance targets. The launcher, fixture format, fake transport, and tests are not implemented by this documentation change. No production API, firmware, or safety behavior changes here.

[Return to the integration proposal]({{ '/proposals/dual-strike/' | relative_url }}).

## Proposal

Build a repeatable demo around OpenLaneLink's existing lane-compute and scoring boundaries, with **two independent lane contexts from the start**. The same design must also run with one configured/connected lane and an absent partner; a physical single-pin or single-lane bench setup does not reduce the software target to one lane.

The demo should consume deterministic sensor events and recorded/synthetic image fixtures, record requested machine operations in a fake sink, and expose enough lane state to inspect the normal UI/API flow. It must not open a serial port, send mesh commands, probe cameras, or connect to live actuator control.

## Separate the evidence layers

| Layer | Input and output | What it establishes | What it does not establish |
|---|---|---|---|
| Game-flow baseline | Known sensor events and standing masks; inspect scores and requested operations | Selected scoring, event, and lane-isolation behavior against expected results | Image recognition, real sensors, transport reliability, motion, or safety |
| Offline vision | Labelled recorded/synthetic images with matching calibration; inspect detector results | Detector behavior on the fixture set and explicit invalid/uncertain cases | Field accuracy, real settling time, camera stabilization, or complete failure detection |
| Mock string workflow | Explicit next-rack intent and simulated operation/verification outcomes | Proposed orchestration, cumulative masks, readiness and recovery scenarios | An implemented wire contract or a physically feasible motion sequence |
| Later bench integration | Separately authorized real sensors, gateway, controller and protected rig | Measured behavior for the tested hardware and conditions | General reliability, competition compliance, or public-operation certification |

Report these layers separately. Posting a synthetic standing mask does not test image processing; a successful fake completion does not prove a motor or brake can perform the operation.

## Isolation requirements

The implementation proposal should satisfy these boundaries before a demo is run:

1. Select demo mode explicitly and bind its control surface to a local/isolated environment. Production behavior and default configuration remain unchanged.
2. Use a recording fake transport/adapter with no route to `SerialLink`, ESP-NOW, RS485, or a physical actuator. Fail closed if a live device/transport is selected; do not rely only on an unplugged cable or an unavailable URL.
3. Keep simulated reachability and fake operation outcomes visibly distinct from real hardware readiness in state, logs, and evidence. Do not describe a demo flag as a safety interlock.
4. Use an explicit fixture image source. Do not enter the production vision camera-probe loop or open a capture device during fixture-only runs.
5. Never forward synthetic images, masks, beam/foul events, or fake status into a live machine-control installation. A debug endpoint's name does not guarantee isolation from its subscribers.
6. Keep game/scoring authority in the existing lane-compute layer. Do not build a second scoring engine for the simulator.
7. A restart or reset must fence stale work and preserve the distinction between game state and pending machine operations in the proposed string workflow. Baseline A2 tests must characterize existing behavior rather than silently change it.

These are requirements for a future implementation and test review, not claims that the current services already enforce them. The demo is not a deployment mode for operating lanes.

## Configurations to exercise

- **Paired:** two configured contexts, for example installation lanes 7 and 8, with independent game, capture, and fake-operation state.
- **Standalone:** one configured/connected lane while its partner is absent; no wait for a nonexistent second camera/controller.
- **Delayed partner:** one lane has a slow fixture or unresolved outcome while the other continues without state leakage.
- **Misconfigured input:** reject lane zero, an unconfigured lane, mismatched source/request context, and accidental association with the other lane.

Configuration must preserve actual installation lane IDs across each boundary. A two-slot array is capacity, not permission to index it by lane 7 or 8.

## Proposed acceptance scenarios

| Scenario | Expected evidence |
|---|---|
| Startup / missing partner | Explicit demo status; selected lane contexts initialize without real device access; no phantom lane or readiness inferred for absent hardware |
| Ordinary gutter, open frame, strike and spare | Expected scores and turn/rack intent; existing A2 command planning unchanged in baseline characterization |
| Tenth-frame `X,7,3` and `7,/,10` | Correct entitlement and full/partial next rack; no unconditional fresh rack after every tenth-frame delivery |
| Fouls | Zero counting pinfall, correct shot correlation and next-rack intent; string mock motion waits for explicit clearance rather than the foul edge alone |
| Cumulative held state | Repeated string mock operations retain already held pins; newly fallen mask is not confused with the entire target-held set |
| Manual observation | Pin identities available where string orchestration needs them; count-only input does not fabricate a mask |
| Unknown / invalid image | Explicit unresolved outcome and no guessed score; distinguish invalid calibration/occlusion/stale data from a valid zero mask |
| Verification | A full or partial expected deck is checked against its pending operation; verification never records another ball |
| Duplicate / late / wrong-context input | No phantom second delivery, cross-lane score, or stale READY transition in the proposed correlated path |
| Interleaved lanes | Independent expected results under overlapping events and delayed capture work; no unbounded queue/task creation |
| Lost completion / restart / reset | Proposed string mock flow inhibits and reconciles uncertain operation state rather than blindly repeating movement |
| Isolation negative tests | Attempts to configure real serial/mesh/camera access fail before a device is opened or a command is sent |

String-specific readiness, correlation, and recovery rows are **future contract targets**, not assertions about current A2 behavior. Keep existing-behavior tests separate from tests of the proposed extensions and record any observed baseline limitations honestly.

## Fixture and evidence expectations

- Document deterministic input order, configured lane IDs, expected scores/masks, and expected recorded commands.
- For images, include fixture provenance, expected physical pin state, compatible calibration/ROI data, and conditions represented. Prefer synthetic or explicitly redistributable fixtures; do not add private club images without permission.
- Distinguish game-flow masks from detector-produced observations in logs. Correlated string tests will also need agreed lane/session/shot-or-operation/request identity; final field names are a later contract decision.
- Capture both positive and negative results, including UNKNOWN coverage. Do not present a heuristic confidence value or a small successful fixture set as a measured field-accuracy guarantee.
- Provide reproducible startup/teardown instructions after the harness exists. This proposal intentionally does not advertise an unimplemented demo command or feature flag.
- Report what ran, what was mocked, which checks failed, and what was not tested. There is no hardware/safety exit criterion that can be satisfied by software fixtures alone.

## Existing code to build on, not assume complete

The proposal was reviewed against commit `c7f8317690cb1be8de4a1e016c3ba5cfaf51a39e`:

- `software/lanecompute/backend/state_machine/simulate_game.py` exercises a live API/UI flow and explicitly is not a test suite. It is not already an isolated two-lane image simulator.
- `state_machine/api.py`, `state_machine.py`, and `game_state.py` provide the current event/game/scoring boundaries. Simply starting an API without an explicit recording fake bridge is not a demonstrated demo.
- `uart_bridge/main.py` constructs a real `SerialLink`. A future fake transport must not accidentally fall through to that path.
- `uart_bridge/service.py` has a debug beam-event endpoint, but subscribers can trigger capture, scoring, and subsequent machine requests. Treat the whole event chain as potentially active unless it is isolated end to end.
- `vision/pinfall.py` provides the detector/camera path; its normal startup probes cameras, and capture can report into scoring. Offline fixture acquisition and non-scoring verification need explicit boundaries.

Use the current [installation guide]({{ '/installation.html' | relative_url }}) for existing service context, not as an instruction to connect this proposed demo to operating machinery.

## Suggested delivery sequence

1. Review this documentation proposal and the integration boundaries.
2. Propose baseline regression coverage and a recording, device-free game-flow harness.
3. Add offline image fixtures and explicitly separate their evidence from mask-only tests.
4. Review the backend, observation/readiness, and protocol/recovery contracts in focused follow-up changes.
5. Only then plan separately authorized protected hardware/rig tests with qualified mechanical and safety engineering.

An isolated demo can be developed while the design is being reviewed, but it must not smuggle production firmware, final protocol allocations, or live control into a documentation change.
