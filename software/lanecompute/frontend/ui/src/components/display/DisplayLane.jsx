import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ballGlyph, computeUp, currentTotal, gameComplete, nextThrow, scoreGame } from "../../lib/scoring.js";
import { MIN_COMPONENT_VH, ThemeProvider, useTheme } from "../../lib/themes.js";
import { Clock, LivePill } from "../shared/Chrome.jsx";
import Ticker from "./Ticker.jsx";
import CelebrationLayer from "./layers/CelebrationLayer.jsx";
import TakeoverLayer from "./layers/TakeoverLayer.jsx";

/* Bowler scores cap out at 20% (1/5 screen height) so a 1-2 bowler lane
   doesn't blow a single card up to fill the whole screen. Per-block, the
   MIN_COMPONENT_VH floor (10%) lives in lib/themes.js so every component
   that needs it — Ticker, this file — reads the same number. Of
   everything on this screen, only the bowler-sheet list is allowed to
   shrink below its natural size; the ticker, topbar, and the slot below
   the scores hold their ground. */
const MAX_BOWLER_SHEET_VH = 20;

/* The bowler-sheet container's height never changes — it's a fixed flex
   region, not something that grows with roster size — so how many sheets
   can ever be shown at once is a fixed number too, not something to
   measure at runtime. 6 is comfortably provable at the 10-20vh sizing
   against the rest of this screen's fixed chrome (topbar + ticker +
   below-scores slot); a lane roster can hold up to 12 (see MAX_BOWLERS in
   scoring/useLaneFeed), so anything beyond 6 queues rather than shrinking
   sheets further or being cut off. */
const MAX_VISIBLE_BOWLERS = 6;

/* How long the display waits, after a bowler's turn actually ends (their
   frame closes — second ball, or a strike, or the 10th frame's bonus
   balls), before sliding the queue: long enough to see the finished
   frame and let a celebration animation play out, per the product call. */
const REORDER_DELAY_MS = 3000;
const REORDER_ANIM_MS = 500;

function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }

function ballColor(sym, T) {
  if (sym === "X") return T.red;
  if (sym === "/") return T.yellow;
  if (sym === "-") return T.muted;
  return T.text;
}

/* The frame the whole lane is "on" — the lowest frame index any
   still-playing bowler hasn't finished yet. Deliberately NOT just the
   currently-active bowler's frame: the moment a bowler finishes frame N
   they're immediately on frame N+1, but they stay shown as "active" for
   a few more seconds (see BowlerQueue's hand-off delay) while everyone
   else is still working on frame N — using their frame would make the
   spotlight jump ahead before the frame is actually done lane-wide. */
function laneFrameIndex(bowlers) {
  const playing = bowlers.filter((b) => !gameComplete(b.frames));
  if (playing.length === 0) return null;
  let min = 9;
  for (const b of playing) {
    const nt = nextThrow(b.frames);
    const f = nt ? nt.frame : 9;
    if (f < min) min = f;
  }
  return min;
}

/* One bowler's full ten-frame sheet, sized for the overhead monitor.
   The sheet's own height varies (10-20vh, depending on how many bowlers
   are sharing the screen — see MIN/MAX_BOWLER_SHEET_VH), so text inside
   it is sized in container-query units (cqh) rather than viewport units:
   the name, score, ball glyphs, and frame totals all scale with THIS
   sheet's actual height, not the window's. `container-type: size` below
   is what turns this div into that query context.

   Only font-size uses cqh/cqw here — layout spacing (padding, gaps) uses
   plain vh/vw. Padding defined in cqh/cqw would feed back into the same
   content-box the query units are measured against (a circular
   reference), which silently produced much smaller computed sizes than
   the clamp() values implied.

   forwardRef so <BowlerQueue> can measure and animate this element
   directly (the FLIP reorder transition), without an extra wrapper div
   that would break its own flex sizing. */
const BowlerSheet = forwardRef(function BowlerSheet({ bowler, isUp }, ref) {
  const { T, elevation } = useTheme();
  const card = elevation("card");
  const inset = elevation("inset");
  const scored = scoreGame(bowler.frames);
  const total = currentTotal(bowler.frames);
  let activeFrame = -1;
  for (let i = 0; i < 10; i++) if ((bowler.frames[i] || []).length > 0) activeFrame = i;
  // Which exact ball is about to be thrown — only meaningful for the
  // bowler actually up right now.
  const upNext = isUp ? nextThrow(bowler.frames) : null;

  return (
    <div ref={ref} style={{
      ...card,
      // "Up" is a strong semantic state — override with an accent-colored
      // highlight regardless of what the base elevation strategy looks
      // like, rather than each theme having to special-case it.
      background: isUp ? "rgba(224,64,48,0.06)" : card.background,
      border: isUp ? `1px solid ${T.red}` : card.border,
      boxShadow: isUp ? `${card.boxShadow}, 0 0 18px rgba(224,64,48,0.22)` : card.boxShadow,
      borderRadius: "clamp(8px,0.9vmin,14px)",
      padding: "clamp(4px,1vh,12px) clamp(8px,1vw,18px)",
      display: "flex", alignItems: "stretch", gap: "1.2vw",
      transition: "border-color 0.5s, box-shadow 0.5s",
      flex: "1 1 0", minHeight: `${MIN_COMPONENT_VH}vh`, maxHeight: `${MAX_BOWLER_SHEET_VH}vh`,
      containerType: "size",
      // Plays once when this DOM node first mounts — i.e. whenever a
      // bowler newly appears in the visible list, whether from being
      // added to the roster or rotating in from the hidden queue tail.
      // A brand-new node has no "before" rect for the FLIP logic below
      // to animate from, so without this it would just pop in instantly.
      animation: "ll-sheet-enter 420ms ease",
    }}>
      <div style={{ width: "clamp(70px,11vw,170px)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
        <div style={{
          fontFamily: T.fontDisplay, fontSize: "clamp(16px,40cqh,90px)", fontWeight: 700,
          color: isUp ? T.yellow : T.text, letterSpacing: "0.03em",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          textShadow: isUp ? "0 0 10px rgba(224,192,48,0.4)" : "none",
        }}>{bowler.name.toUpperCase()}</div>
      </div>

      <div style={{
        ...inset,
        flex: 1, display: "flex", gap: "0.5vw", padding: "clamp(3px,0.8vh,8px) clamp(3px,0.5vw,8px)",
        borderRadius: 8,
        opacity: isUp ? 1 : 0.5, transition: "opacity 0.5s",
      }}>
        {bowler.frames.map((fr, fi) => {
          const isTenth = fi === 9;
          const boxes = isTenth ? 3 : 2;
          const isActive = fi === activeFrame;
          const isEmpty = fr.length === 0;
          return (
            <div key={fi} style={{
              flex: isTenth ? "1.4" : "1", display: "flex", flexDirection: "column",
              borderRadius: 4, overflow: "hidden",
              background: isEmpty ? "rgba(0,0,0,0.25)" : T.surface,
              boxShadow: isEmpty ? `inset 2px 2px 5px ${T.shadowD}` : isActive ? `3px 3px 7px ${T.shadowD}` : "none",
            }}>
              <div style={{ flex: 1, display: "flex" }}>
                {Array.from({ length: boxes }).map((_, bi) => {
                  const glyph = ballGlyph(fr, bi, isTenth);
                  const isNextBall = upNext && upNext.frame === fi && upNext.ball === bi;
                  return (
                    <div key={bi} style={{
                      flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                      fontFamily: T.fontMono, fontSize: "clamp(18px,30cqh,60px)", fontWeight: 700,
                      color: isNextBall ? T.text : ballColor(glyph, T),
                      borderLeft: bi > 0 ? `1px solid ${T.shadowD}` : "none",
                      background: isNextBall ? "rgba(64,144,216,0.28)" : "transparent",
                      boxShadow: isNextBall ? "inset 0 0 0 2px rgba(64,144,216,0.8)" : "none",
                      transition: "background 0.3s, box-shadow 0.3s",
                    }}>{glyph}</div>
                  );
                })}
              </div>
              <div style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: T.fontDisplay, fontSize: "clamp(18px,30cqh,56px)", fontWeight: 600,
                color: scored[fi].running != null ? T.text : T.dim,
                background: scored[fi].running != null ? T.raised : "transparent",
              }}>{scored[fi].running ?? ""}</div>
            </div>
          );
        })}
      </div>

      <div style={{ width: "clamp(60px,9vw,140px)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "flex-start" }}>
        <div style={{ fontFamily: T.fontMono, fontSize: "clamp(32px,55cqh,130px)", fontWeight: 700, color: isUp ? T.yellow : T.muted, lineHeight: 1.05 }}>
          {total}
        </div>
      </div>
    </div>
  );
});

/**
 * FrameSpotlight — a translucent vertical band marking which frame is
 * currently being bowled, laid over the whole bowler-list region so it
 * visually spans every sheet at once rather than repeating per-row.
 *
 * It works with no JS measurement at all: it mirrors BowlerSheet's exact
 * horizontal structure — same outer border width, same outer padding,
 * same name-column width, same frames-grid INNER padding (easy to miss:
 * the real frames-grid has its own inset padding around the 10 cells,
 * separate from the sheet's outer padding — omitting it here made every
 * cell wider than the real one, so the drift was small at frame 1 and
 * compounded larger by frame 10), same frame flex-ratios, same
 * score-column width — so its highlighted cell lands at the same
 * x-position as the real frame column in every sheet underneath it,
 * regardless of screen width. Only the targeted frame gets a background;
 * everything else in this overlay is fully transparent and
 * `pointerEvents: "none"` so it never blocks interaction with what's
 * beneath it.
 */
function FrameSpotlight({ frameIdx }) {
  const { T } = useTheme();
  if (frameIdx == null) return null;
  return (
    <div style={{
      position: "absolute", inset: 0, display: "flex", alignItems: "stretch",
      gap: "1.2vw", padding: "0 clamp(8px,1vw,18px)", pointerEvents: "none", zIndex: 2,
      border: "1px solid transparent", boxSizing: "border-box",
    }}>
      <div style={{ width: "clamp(70px,11vw,170px)", flexShrink: 0 }} />
      <div style={{ flex: 1, display: "flex", gap: "0.5vw", padding: "0 clamp(3px,0.5vw,8px)" }}>
        {Array.from({ length: 10 }).map((_, fi) => (
          <div key={fi} style={{
            position: "relative",
            flex: fi === 9 ? "1.4" : "1",
            background: fi === frameIdx ? "rgba(64,144,216,0.1)" : "transparent",
            borderLeft: fi === frameIdx ? "1px solid rgba(64,144,216,0.45)" : "none",
            borderRight: fi === frameIdx ? "1px solid rgba(64,144,216,0.45)" : "none",
            borderRadius: 8,
            transition: "background 0.4s, border-color 0.4s",
          }}>
            {fi === frameIdx && (
              <div style={{
                position: "absolute", top: "-2.6vh", left: "50%", transform: "translateX(-50%)",
                whiteSpace: "nowrap", fontFamily: T.fontMono, fontWeight: 700,
                fontSize: "clamp(8px,1.1vh,13px)", letterSpacing: "0.1em", color: T.blue,
                background: "rgba(64,144,216,0.16)", border: "1px solid rgba(64,144,216,0.45)",
                borderRadius: 4, padding: "0.2vh 0.7vw",
              }}>FRAME {frameIdx + 1}</div>
            )}
          </div>
        ))}
      </div>
      <div style={{ width: "clamp(60px,9vw,140px)", flexShrink: 0 }} />
    </div>
  );
}

/**
 * BowlerQueue — renders the front MAX_VISIBLE_BOWLERS bowlers of a
 * rotating queue, keyed by turn order rather than roster order.
 *
 * Which bowler is shown as active (highlight + top position) is its OWN
 * delayed state (`displayActiveId`), deliberately decoupled from the
 * real-time `activeId` prop the game engine reports. A real bowler can't
 * throw both balls of a frame inside a few seconds, so the moment
 * `activeId` flips to a new bowler, the display doesn't follow yet — it
 * keeps showing the bowler who just finished as active until: their
 * second-ball score has been visible, any celebration animation tied to
 * it (`celebrating`) has actually finished playing, AND REORDER_DELAY_MS
 * has elapsed. Only then do the highlight and the top-of-list slide
 * happen — together, in the same instant, not one before the other.
 *
 * The slide is a FLIP animation (First/Last/Invert/Play): capture each
 * visible sheet's position before the swap, let React re-render in the
 * new order, then transform each sheet from its old position back to its
 * new one and transition that away — a plain reorder has no native way
 * to animate, this is the standard technique for it.
 */
function BowlerQueue({ bowlers, activeId, allComplete, celebrating = false }) {
  const [queue, setQueue] = useState(() => bowlers.map((b) => b.id));
  const [displayActiveId, setDisplayActiveId] = useState(activeId ?? null);
  const nodeRefs = useRef(new Map());
  const flipFromRef = useRef(null);
  // At most one hand-off is ever in flight — a real bowler's frame takes
  // far longer than REORDER_DELAY_MS, so by the time the display catches
  // up to one turn change, the next one hasn't happened yet.
  const pendingRef = useRef(null);
  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  const celebratingRef = useRef(celebrating);
  useEffect(() => { celebratingRef.current = celebrating; }, [celebrating]);

  // Keep the queue's membership in sync with roster changes (bowler
  // added/removed) without disturbing the existing turn order.
  useEffect(() => {
    setQueue((prev) => {
      const ids = bowlers.map((b) => b.id);
      const idSet = new Set(ids);
      const kept = prev.filter((id) => idSet.has(id));
      const added = ids.filter((id) => !kept.includes(id));
      if (kept.length === prev.length && added.length === 0) return prev;

      // Capture positions so the EXISTING sheets smoothly reflow into
      // their new sizes/slots too, not just the new one fading in. A
      // newly added bowler's sheet used to "pop" in because the
      // siblings resized instantly (flex redistributing space across a
      // new count) while only the new sheet got any animation at all.
      const rects = new Map();
      nodeRefs.current.forEach((node, id) => { if (node) rects.set(id, node.getBoundingClientRect()); });
      flipFromRef.current = rects;

      return [...kept, ...added];
    });
  }, [bowlers]);

  // Whenever the display is behind reality (activeId has moved on from
  // whoever we're currently showing as active), start — or continue — the
  // hand-off toward catching up.
  useEffect(() => {
    if (activeId == null || activeId === displayActiveId) return;
    if (pendingRef.current) return; // already mid hand-off; it'll pick up the latest activeId when it fires

    const finishedId = displayActiveId;
    if (finishedId == null) {
      // No one was shown as active yet (lane just went from empty to
      // having a first bowler) — nothing to wait on, snap immediately.
      setDisplayActiveId(activeId);
      return;
    }

    function attempt() {
      if (celebratingRef.current) {
        pendingRef.current = setTimeout(attempt, 250);
        return;
      }
      pendingRef.current = null;
      const nextActiveId = activeIdRef.current; // fresh, in case reality moved on again while waiting

      const rects = new Map();
      nodeRefs.current.forEach((node, id) => { if (node) rects.set(id, node.getBoundingClientRect()); });
      flipFromRef.current = rects;

      // Highlight and position change together, atomically.
      setDisplayActiveId(nextActiveId);
      setQueue((prev) => {
        if (!prev.includes(finishedId)) return prev;
        const withoutFinished = prev.filter((id) => id !== finishedId);
        if (nextActiveId == null || !withoutFinished.includes(nextActiveId)) {
          return [...withoutFinished, finishedId];
        }
        const rest = withoutFinished.filter((id) => id !== nextActiveId);
        return [nextActiveId, ...rest, finishedId];
      });
    }

    pendingRef.current = setTimeout(attempt, REORDER_DELAY_MS);
  }, [activeId, displayActiveId]);

  // Clear a still-pending hand-off on unmount.
  useEffect(() => () => clearTimeout(pendingRef.current), []);

  // Invert + play: after the queue reorders/resizes and the DOM reflects
  // the new layout, jump each already-mounted sheet back to where it
  // visually was — position AND size — then transition that away. Size
  // (scaleY) matters here too, not just position: adding or removing a
  // bowler changes how many sheets share the fixed-height region, so
  // every sheet's height shifts, not just the reordered ones'. A
  // brand-new sheet has no "before" rect (not in prevRects) and is left
  // alone — its own mount animation (see BowlerSheet) handles it.
  useLayoutEffect(() => {
    const prevRects = flipFromRef.current;
    if (!prevRects) return;
    flipFromRef.current = null;

    nodeRefs.current.forEach((node, id) => {
      if (!node) return;
      const prevRect = prevRects.get(id);
      if (!prevRect) return;
      const newRect = node.getBoundingClientRect();
      const deltaY = prevRect.top - newRect.top;
      const scaleY = newRect.height > 0 ? prevRect.height / newRect.height : 1;
      if (!deltaY && scaleY === 1) return;
      node.style.transformOrigin = "top center";
      node.style.transition = "none";
      node.style.transform = `translateY(${deltaY}px) scaleY(${scaleY})`;
      requestAnimationFrame(() => {
        node.style.transition = `transform ${REORDER_ANIM_MS}ms ease`;
        node.style.transform = "";
      });
    });
  }, [queue]);

  const byId = new Map(bowlers.map((b) => [b.id, b]));
  const visible = queue.slice(0, MAX_VISIBLE_BOWLERS).map((id) => byId.get(id)).filter(Boolean);

  // The spotlight tracks the whole lane's frame, not just whoever's
  // currently shown as active — see laneFrameIndex.
  const spotlightFrame = allComplete ? null : laneFrameIndex(bowlers);

  return (
    <>
      <FrameSpotlight frameIdx={spotlightFrame} />
      {visible.map((b) => (
        <BowlerSheet
          key={b.id}
          ref={(node) => { if (node) nodeRefs.current.set(b.id, node); else nodeRefs.current.delete(b.id); }}
          bowler={b}
          isUp={!allComplete && b.id === displayActiveId}
        />
      ))}
    </>
  );
}

function DisplayLaneInner({ laneId, lane, activeTakeover, tickerMessages = [], tickerEnabled = false, celebrationAssets, children }) {
  const { T, layout, assets } = useTheme();
  // The theme owns a default asset bundle (celebration clips, webfont
  // import) as part of its visual identity; an explicit prop still wins,
  // so a venue can override just the clips without forking the theme.
  const resolvedCelebrationAssets = celebrationAssets ?? assets.celebrationAssets;
  const up = computeUp(lane.bowlers);
  const allComplete = lane.bowlers.length > 0 && lane.bowlers.every((b) => gameComplete(b.frames));
  // Whether a celebration clip is actually playing right now — the
  // bowler queue's turn-change reorder waits for this in addition to its
  // own delay floor, rather than assuming a fixed animation length.
  const [celebrating, setCelebrating] = useState(false);

  const sr = pct(lane.strikes, lane.deliveries);

  const badge = lane.alert
    ? { label: "JAM", color: "#f07060", bg: "rgba(224,64,48,0.18)", border: "rgba(224,64,48,0.4)" }
    : lane.bowlers.length === 0
    ? { label: "OPEN", color: T.muted, bg: "rgba(0,0,0,0.4)", border: T.dim }
    : { label: "ACTIVE", color: "#60a0e0", bg: "rgba(64,144,216,0.12)", border: "rgba(64,144,216,0.3)" };

  const tickerItems = [
    { id: "strike-rate", text: `Lane ${laneId} strike rate ${sr}%`, color: "accent" },
    { id: "pins-tonight", text: `${lane.nightlyPins.toLocaleString()} pins tonight` },
    ...tickerMessages,
  ];

  return (
    <>
      <style>{`
        ${assets.fontImport}
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body, #root { width: 100%; height: 100%; overflow: hidden; background: ${T.bg}; }
        @keyframes ll-sheet-enter { from { opacity: 0; transform: scaleY(0.85); } to { opacity: 1; transform: scaleY(1); } }
      `}</style>
      <div style={{
        position: "relative", width: "100vw", height: "100vh",
        background: `radial-gradient(ellipse at 15% 0%, rgba(90,20,14,0.2) 0%, transparent 55%), ${T.bg}`,
        color: T.text, fontFamily: T.fontUi, display: "flex", flexDirection: "column",
        padding: "1.4vh 1.6vw", gap: "1vh", overflow: "hidden",
      }}>
        {/* topbar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${T.border}`, paddingBottom: "0.8vh", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "1.2vmin" }}>
            <span style={{ fontFamily: "'Orbitron','Barlow Condensed',sans-serif", fontSize: "clamp(14px,2.6vmin,32px)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              LANE {laneId}
            </span>
            <span style={{
              fontFamily: T.fontMono, fontSize: "clamp(8px,1.1vmin,14px)", padding: "0.3vmin 1vmin", borderRadius: 6,
              background: badge.bg, color: badge.color, border: `1px solid ${badge.border}`, letterSpacing: "0.08em",
            }}>{badge.label}</span>
            {lane.ballSpeed && lane.bowlers.length > 0 && (
              <span style={{ fontFamily: T.fontMono, fontSize: "clamp(8px,1.2vmin,16px)", color: T.muted }}>{lane.ballSpeed} mph</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1.5vmin" }}>
            <Clock />
            <LivePill />
          </div>
        </div>

        {/* slot for whatever else belongs above the scores (extended
            stats, mini-ads, anything else) — DisplayLane doesn't decide
            what goes here, the caller does, via children. */}
        {children && (
          <div style={{ minHeight: `${MIN_COMPONENT_VH}vh`, flexShrink: 0, display: "flex", gap: "1vw" }}>
            {children}
          </div>
        )}

        {/* bowler sheets — the whole point of this screen. This region's
            own height is fixed (flex:1 against fixed siblings, never
            driven by how many bowlers are on the lane); how many sheets
            it can show is therefore also fixed (MAX_VISIBLE_BOWLERS).
            Beyond that, bowlers queue: the active bowler is always
            eventually at the top, the one who just finished slides to
            the back — see BowlerQueue for the timing/animation. */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {/* The theme's layout policy controls how wide the scorecard
              column runs and how it's positioned — full-bleed for
              midnight-arcade, a narrower centered column for a
              broadcast-style theme, etc. (see lib/themes.js). This inner
              div is the ONE thing both BowlerQueue's sheets and
              FrameSpotlight are laid out relative to, so narrowing it
              narrows — and keeps aligned — both together. alignSelf (not
              justifyContent) is what does the horizontal positioning
              here, because the OUTER container is column-direction: its
              cross-axis is horizontal, which is exactly what
              scorecardAlign needs to control. */}
          <div style={{
            position: "relative", width: layout.scorecardWidth, alignSelf: layout.scorecardAlign,
            flex: 1, display: "flex", flexDirection: "column", gap: "0.8vh", minHeight: 0,
          }}>
            {lane.bowlers.length === 0 ? (
              <div style={{ textAlign: "center", color: T.muted, fontFamily: T.fontUi, padding: "4vh" }}>
                No bowlers on this lane
              </div>
            ) : (
              <BowlerQueue bowlers={lane.bowlers} activeId={up?.id ?? null} allComplete={allComplete} celebrating={celebrating} />
            )}
            {allComplete && lane.bowlers.length > 0 && (
              <div style={{
                textAlign: "center", padding: "1vh", fontFamily: T.fontMono, fontSize: "clamp(9px,1.2vmin,15px)",
                color: T.yellow, letterSpacing: "0.1em", flexShrink: 0,
              }}>GAME COMPLETE — next game starting shortly</div>
            )}
          </div>
        </div>

        {/* ticker lives at the very bottom of the screen, and only takes
            up space at all when explicitly enabled */}
        <Ticker items={tickerItems} enabled={tickerEnabled} />

        <CelebrationLayer latestEvent={lane.events[0] || null} assets={resolvedCelebrationAssets} onPlayingChange={setCelebrating} />
        <TakeoverLayer activeTakeover={activeTakeover} lane={lane} laneId={laneId} activeBowlerId={up?.id} />
      </div>
    </>
  );
}

/**
 * DisplayLane — the 16:9 overhead-monitor screen for a single lane.
 * Pure presentational component: all state comes in via props, so it can
 * be driven by the dummy data hooks today or a real compute-node feed
 * later without any change here. See DisplayLanePage for the route-level
 * wiring (useParams + data hooks + ThemeProvider).
 *
 * Props:
 *   laneId: string | number
 *   lane: {
 *     bowlers, pins, flashPins, ballSpeed, alert, lastEvent, events,
 *     nightlyPins, strikes, deliveries, stops, jams
 *   }                                            — see useLaneFeed's shape
 *   theme?: string | object | { preset, overrides } — see lib/themes.js
 *   activeTakeover?: { id, kind, ...payload } | null — see TakeoverLayer
 *   tickerMessages?: { id, text, color? }[]      — extra banner items,
 *     merged with the built-in lane-stat ticker items
 *   tickerEnabled?: boolean                       — default false; the
 *     ticker (bottom of screen) renders nothing and claims no layout
 *     space unless explicitly turned on
 *   celebrationAssets?: { [eventType]: webmUrl }  — see CelebrationLayer.
 *     Defaults to the active theme's own asset bundle (useTheme().assets
 *     .celebrationAssets, see lib/themes.js) if omitted; pass this prop
 *     only to override a specific venue's clips without forking the theme
 *   children?: ReactNode                          — rendered in a slot
 *     above the bowler scores, below the topbar (extended stats for the
 *     active bowler, mini-ads, anything else) — each top-level child
 *     should size itself to at least 10% of screen height to match the
 *     rest of the screen's density rule
 */
export default function DisplayLane({ laneId, lane, theme, activeTakeover = null, tickerMessages, tickerEnabled, celebrationAssets, children }) {
  return (
    <ThemeProvider theme={theme}>
      <DisplayLaneInner
        laneId={laneId}
        lane={lane}
        activeTakeover={activeTakeover}
        tickerMessages={tickerMessages}
        tickerEnabled={tickerEnabled}
        celebrationAssets={celebrationAssets}
      >
        {children}
      </DisplayLaneInner>
    </ThemeProvider>
  );
}
