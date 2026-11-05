---
layout: default
title: DUAL-STRIKE — string-pinsetter proposal
---

# DUAL-STRIKE: proposed string-pinsetter support

**Status: design proposal, not implemented.** This documentation proposes an additive integration and a hardware-isolated demo. It does not add string firmware, change A2 behavior, allocate protocol IDs, or establish mechanical feasibility or safety certification.

## Proposal

DUAL-STRIKE is a planned custom ten-pin string pinsetter, not a retrofit controller for an existing commercial machine. The candidate mechanism uses one bidirectional main motor per lane and ten individually controlled string-retention channels. Clutch/brake spools and capture/alignment guides are design candidates that still need a single-pin test rig and detailed engineering.

The intended normal partial-setting operation raises all pins still on the deck, retains fallen pins overhead, and returns the required standing set. Already suspended pins remain retained. A full-setting operation returns all ten pins. Reliable capture, orientation, individual seating feedback, and load retention remain open mechanical validation work; nominal repositioning is not a claim of competition-rule compliance.

The software should support **two independent lane contexts from the outset**, while also working with one configured/connected lane and an absent partner. The next practical goal is an isolated demo with emulated I/O and recorded or synthetic images—not live machine operation.

Read the [proposed demo and validation plan]({{ '/proposals/dual-strike/demo-plan.html' | relative_url }}) for scope, isolation requirements, and acceptance targets.

## Preserve OpenLaneLink's existing boundaries

| Component | Proposed treatment |
|---|---|
| Gateway | Retain one existing gateway per lane pair; propose explicit lane-aware routing for new string controllers. Do not add a second mesh-to-Pi bridge. |
| Lane compute | Keep game/scoring decisions on the Pi and reuse existing services and REST/WebSocket boundaries. Site services must not become a synchronous active-game dependency. |
| A2 interface | Preserve the existing `pinsetter_node`, message bytes, defaults, cycle/rerack planning, and per-pulse completion handling. Do not reinterpret solenoid commands as string motion. |
| Foul and speed nodes | Reuse the existing paired sensor-node behavior with explicit lane/pin configuration: one foul gate and two ball gates per lane. Their end-to-end hardware behavior still needs bench validation. |
| Vision | Keep the camera game-stateless: report the actual standing-pin set, not a score. Stability, uncertainty outcomes, capture correlation, and non-scoring verification are proposed extensions. |
| String control | Add a separate local controller per lane for bounded motion, retention, feedback, and interlock supervision. It must not decide frames, turns, or pinfall. |
| Protective hardware | Independently engineer hardwired emergency stopping, guarding, and suspended-load retention. Network STOP and MCU diagnostics are not substitutes. |

String tension, motor position, and retention telemetry may supervise motion or gate capture timing, but **must never determine scored pinfall**. Scoring uses accepted optical observations or explicit operator observations.

## Proposed topology

### One connected lane

This view represents operation with one lane present, not a single-lane-only software architecture. The paired sensor boards may initially have only that lane's channels connected/configured.

![Proposed DUAL-STRIKE architecture with one connected lane]({{ '/assets/dual-strike/one-lane.svg' | relative_url }})

[Editable Mermaid source]({{ '/assets/dual-strike/one-lane.mmd' | relative_url }}).

### Lane pair

![Proposed DUAL-STRIKE lane pair with independent controllers and shared infrastructure]({{ '/assets/dual-strike/lane-pair.svg' | relative_url }})

[Editable Mermaid source]({{ '/assets/dual-strike/lane-pair.mmd' | relative_url }}).

Both controller links use the **same shared RS485 bus**, plus separately addressed ESP-NOW peers. Safety arrows represent independent protective hardware, not a stop mediated by the ESP32. The diagram's lane 1/2 labels are illustrative; preserve installation IDs such as 7/8 through events, APIs, routing, and correlation, using validated ID-to-slot lookup rather than external IDs as array indices.

Local motion-controller faults should be isolated where safe, but the Pi, gateway, UART, shared bus, paired sensor boards, and any shared safety zone remain common failure domains. Two camera objects alone also do not establish concurrent lane processing: capture scheduling and blocking I/O need explicit review.

## Proposed software contracts

1. **Backend boundary.** A game-facing pinsetter adapter should preserve ordinary A2 cycle/rerack behavior while allowing a separate string backend to prepare the scoring-required next rack. A2 must not emulate string-only capabilities.
2. **Next-rack intent.** Derive the required standing set from game state after recording a delivery, including tenth-frame bonuses and fouls. The cumulative held target is not necessarily the same as the pins fallen on that delivery. Latch fouls to a shot; a foul edge alone never authorizes motion before ball/deck clearance.
3. **Observations versus verification.** A BALL observation records a delivery once. RACK_VERIFY or STANDING_VERIFY inspects an expected completed operation and never records another ball. Uncertain or mismatched outcomes inhibit automatic progression and require explicit resolution.
4. **Command outcomes and recovery.** Transport receipt, semantic acceptance, progress, completion, and rack readiness are distinct. Duplicate suppression, restart/session identity, bounded retries, retained-outcome reconciliation, a local communication lease, and deliberate recovery need a reviewed contract before real motion is enabled.
5. **Compatibility.** Preserve the 72-byte `NodeMessage` and existing message values. Separate proposed string command/status families must not overload A2 semantics. New IDs, UART layouts, configuration, and APIs need maintainer agreement and tests; this proposal reserves none.

The wire reference remains [`firmware/PROTOCOL.md`](https://github.com/nicholas-a-hall/openlanelink/blob/main/firmware/PROTOCOL.md). Agreed allocations should be recorded there in the relevant implementation change, not inferred from names in this proposal.

## Why this approach?

- A separate gateway would duplicate routing, serial links, and recovery state without solving local string motion.
- Repurposing A2 pulse commands would conflate different machine semantics and risk legacy behavior.
- Moving score authority into a controller or camera would duplicate game logic and weaken observation/operation separation.
- Starting with an embedded ESP32 camera would add optics, compute, calibration, and identity work before validating the existing Pi vision path. Pi + USB or offline image fixtures are the initial reference; an embedded observation node is deferred.

Separate per-lane controllers cost an additional MCU/controller compared with a combined board, and shared compute/transport still couples availability. Those are explicit trade-offs, not a claim of complete lane independence or a proven lowest-cost mechanism.

## Decisions requested

- Is this per-lane controller plus game-facing backend boundary appropriate for upstream?
- Is this proposal location suitable, and which detailed mechanical/protocol material would be useful next?
- What demo evidence and A2 regression coverage should precede production changes?
- How should the new message/node allocations and restart/lease/observation contracts be reviewed and recorded?

This documentation-only change leaves production code and defaults untouched. The proposed next contribution is baseline regression coverage and a recording, hardware-isolated lane-pair demo. Live sensor/mesh testing, controller firmware, mechanical bench work, and complete string game flow require separate scoped implementation and validation.

## Diagram maintenance

Static SVGs keep the site readable without adding a Mermaid JavaScript dependency or changing the global theme. To regenerate them with an existing Mermaid CLI, from the repository root:

```sh
mmdc -i docs/assets/dual-strike/one-lane.mmd -o docs/assets/dual-strike/one-lane.svg
mmdc -i docs/assets/dual-strike/lane-pair.mmd -o docs/assets/dual-strike/lane-pair.svg
```

The Mermaid sources include their rendering configuration. Generating diagrams does not validate the architecture or machinery.
