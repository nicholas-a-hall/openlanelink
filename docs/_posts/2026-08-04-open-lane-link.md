---
layout: post
title: "Open Lane Link"
date: 2026-08-04
---

## Background

My family and I bought a small, inactive bowling alley in Hillsboro Illinois after a personally, professionally, and financially difficult year. We looked around in our local community and found few places for people to gather together and have a good time. Our idea was simple - there isn't much for our kids to do, so let's build something for them. Our friends and neighbors can come, too.

What we didn't fully realize is what a battle it would be to do so.

Our pinsetters made horrible noises when they first activated. None of the 8 cycled perfectly. It took our family three weeks to bowl a complete game together. Our scoring was locked out, our fouling didn't work, our roof leaked, and our bar area needed a top-to-bottom remodel. Running out of time and money, we upgraded and repaired what we could, isolated sections that were under construction from the public, and opened our doors.

We've faced plumbing problems, A/C and facilities issues, broken pinsetters, uneven lanes, broken ball returns and more. Finally, eventually… we ran into a problem we couldn't fix. A power surge from the transformer that fed our building fried multiple arcades, some partner equipment, and one of our lane computers.

The cost was more than we could afford, so as a 21-year technology veteran, I started building my own system instead.

## Concept

Scoring systems are one of the single most expensive pieces of equipment in a bowling center, for good reason. They often form the backbone of a center's operation - running everything from point-of-sale, shoe rental, arcade token tracking, league tracking, and then some. All of this is in addition to the scoring, pinsetter control, and rich media features that any given scoring system on the market provides. A scoring system is therefore incredibly important to the operation of a modern center - especially one that runs lean, with minimal staff available during the off-season.

On the other hand, operating a lane with a Brunswick A2 is relatively simple. The basic workflow is easy: Detect a ball, wait a few seconds, count the standing pins on the deck, take score, read pinsetter state (ball 1, 2, out-of-range), trigger pinsetter cycle mechanism. There are of course edge cases and more advanced logic at play, but the critical path is clear.

As bowling is a relatively small industry, solutions for it are niche, and often kept behind closed doors. There are few (if any) open-source projects designed for supporting a bowling center. As a result, any software required for the operation of a bowling center at any scale often comes with a large capital expense. While bowling is an event-driven, data-rich sport; scoring systems are frequently closed in nature. This data therefore stays locked behind whatever interfaces are made available at time of purchase, limiting a proprietor's opportunity to innovate within their business.

By creating an open-source-first alternative, using commodity hardware, OpenLaneLink aims to enable proprietors of any size center. Its goals are to expose the data layer, enable a proprietor's ability to innovate and pivot rapidly, and keep costs minimal by using common components with rapid-replacement capabilities in lieu of purpose-built hardware.

In other words, the goal is simple: We want there to be more bowling centers in the world. We built OpenLaneLink to help make that possible.

## Requirements

- **Lane-pair survivability**: a lane must keep bowling with zero server dependency during an active session. If the site aggregator, Redis, or the network dies mid-frame, the lane still detects pins, scores, and cycles the pinsetter. Loss of upstream = loss of visibility, not loss of function.
- **Vendor lock avoidance**: relay/optocoupler deploy pattern over OLL interconnects.
- **Hot-swap in 5 minutes**: any node can be pulled and replaced with a cold spare in ~5 min. A spare must not need per-node configuration at swap time.
- **Commodity hardware only**: no purpose-built boards where an ESP32 + off-the-shelf sensor does the job. Cost and repairability over elegance.

## Architecture overview

![Architecture Overview](/assets/architecture-overview.svg)

- **Transport, last hop**: ESPNow primary, RS-485 wired fallback. These are orthogonal failure axes — RS-485 isn't a degraded ESPNow, it's a second physical path.
- **Per-lane compute**: Raspberry Pi. Runs the lane's local state machine, redis, and MQTT client. This is the box that keeps the lane alive if the site bus goes down.
- **Site message bus**: Redis Streams, unified from lane-local through site aggregation.
- **Integration bus**: separate MQTT bus, kept deliberately decoupled from the core Redis Streams bus, so external integrations (Home Assistant, etc.) can't back-pressure or couple to internal lane logic. MQTT is an optional egress adapter only — not a control path.
- **Server authority model**: async-only. The server does not hold synchronous authority over lane hardware. Commands go out, lanes act on local authority, state reconciles.

### Peer registration

ESPNow peer registration uses a broadcast handshake pattern, governed by software within the lane-compute + gateway node.
