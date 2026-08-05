import { useParams } from "react-router-dom";
import { useLaneFeed } from "../../lib/useLaneFeed.js";
import { useTakeoverFeed, MOCK_MINI_AD, MOCK_TICKER_MESSAGES } from "../../lib/useTakeoverFeed.js";
import { computeUp, gameComplete } from "../../lib/scoring.js";
import DisplayLane from "./DisplayLane.jsx";
import BowlerStatsPanel from "./BowlerStatsPanel.jsx";
import MiniAd from "./MiniAd.jsx";

/**
 * DisplayLanePage — route container for /display/:laneId. Wires the dummy
 * data hooks to the presentational <DisplayLane>, and decides what goes in
 * the slot above the bowler scores (currently extended stats for whoever's
 * up + a mini-ad — swap or add to these freely, DisplayLane itself has no
 * opinion). This is also the file to change when a real compute-node feed
 * replaces the mock hooks; the `theme` prop here is where a venue's
 * configured theme would come from once that's sourced from the backend
 * instead of hardcoded.
 */
export default function DisplayLanePage() {
  const { laneId } = useParams();
  const { lane } = useLaneFeed(laneId);
  // Advertising only fires between games — in production this decision
  // belongs to the compute node, not the display; hasActiveGame here is
  // this mock's stand-in for that signal.
  const hasActiveGame = lane.bowlers.length > 0 && !lane.bowlers.every((b) => gameComplete(b.frames));
  const { activeTakeover } = useTakeoverFeed({ hasActiveGame });
  const activeBowler = computeUp(lane.bowlers);

  return (
    <DisplayLane
      laneId={laneId}
      lane={lane}
      theme="midnight-arcade"
      activeTakeover={activeTakeover}
      tickerMessages={MOCK_TICKER_MESSAGES}
      tickerEnabled
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <BowlerStatsPanel bowler={activeBowler} ballSpeed={lane.ballSpeed} />
      </div>
      <div style={{ width: "clamp(140px,16vw,260px)", flexShrink: 0 }}>
        <MiniAd ad={MOCK_MINI_AD} />
      </div>
    </DisplayLane>
  );
}
