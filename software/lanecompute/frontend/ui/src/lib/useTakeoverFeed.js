import { useEffect, useRef, useState } from "react";

/* ═══════════════════════════════════════════════════════════════════
   DUMMY TAKEOVER FEED

   Stand-in for the compute node externally scheduling full-screen
   ad/video/message takeovers (per the product decision: the
   display itself has no scheduling logic — it only renders whatever
   `activeTakeover` it's handed). This hook fakes that external schedule
   with a local interval. Swapping in the real feed later means rewriting
   this file only; <DisplayLane> already just takes `activeTakeover` as
   a prop.

   No real ad/video assets exist yet, so the mock content below uses an
   inline placeholder SVG rather than pointing at files that don't exist.
   ═══════════════════════════════════════════════════════════════════ */

const PLACEHOLDER_AD_IMG =
  "data:image/svg+xml;utf8," + encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="450">
      <rect width="800" height="450" fill="#181520"/>
      <rect x="1" y="1" width="798" height="448" fill="none" stroke="#3a3050" stroke-width="2"/>
      <text x="400" y="235" font-family="sans-serif" font-size="34" fill="#e0c030" text-anchor="middle">SPONSOR AD PLACEHOLDER</text>
    </svg>
  `);

// No "stats" step -- that takeover kind was removed (see TakeoverLayer.jsx):
// it rendered lane.strikes/deliveries/stops/jams/nightlyPins, none of which
// the backend tracks (state_machine/game_state.py is per-game, not per-night).
const SCRIPT = [
  { showMs: 14000 }, // score view
  { takeoverMs: 6000, kind: "message", title: "$2 SODAS ALL NIGHT", subtitle: "Ask your server at the front desk" },
  { showMs: 14000 },
  { takeoverMs: 6000, kind: "ad", imageUrl: PLACEHOLDER_AD_IMG, alt: "sponsor placeholder" },
];

const ADVERTISING_KINDS = new Set(["ad", "video"]);

let _id = 0;

/**
 * useTakeoverFeed — mock schedule for full-screen takeovers.
 *
 * `hasActiveGame` stands in for a real decision the compute node will own
 * in production: advertising (ad/video kinds) only fires between games,
 * never over live play — house-info takeovers (stats, promotional
 * messages) aren't gated the same way. Since this is only a mock schedule
 * stepping through a fixed script, an ad/video slot that lands during an
 * active game is deferred (re-checked shortly) rather than skipped
 * outright, so the house still gets its ad slot once the lane goes idle.
 */
export function useTakeoverFeed({ enabled = true, hasActiveGame = false } = {}) {
  const [activeTakeover, setActiveTakeover] = useState(null);
  const hasActiveGameRef = useRef(hasActiveGame);
  useEffect(() => { hasActiveGameRef.current = hasActiveGame; }, [hasActiveGame]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let step = 0;

    function runStep() {
      if (cancelled) return;
      const s = SCRIPT[step % SCRIPT.length];

      if (s.takeoverMs && ADVERTISING_KINDS.has(s.kind) && hasActiveGameRef.current) {
        setTimeout(runStep, 2000); // re-check shortly, don't advance past this slot
        return;
      }
      step += 1;

      if (s.takeoverMs) {
        setActiveTakeover({ id: ++_id, ...s });
        setTimeout(() => {
          if (!cancelled) setActiveTakeover(null);
          setTimeout(runStep, 10);
        }, s.takeoverMs);
      } else {
        setTimeout(runStep, s.showMs);
      }
    }

    const t = setTimeout(runStep, 3000);
    return () => { cancelled = true; clearTimeout(t); };
  }, [enabled]);

  return { activeTakeover };
}

export const MOCK_MINI_AD = { imageUrl: PLACEHOLDER_AD_IMG, label: "sponsored" };

export const MOCK_TICKER_MESSAGES = [
  { id: "promo-1", text: "Cosmic Bowl every Friday 9pm–close · $15 unlimited" },
  { id: "promo-2", text: "Birthday parties booking now for next month" },
];
