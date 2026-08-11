import { useParams } from "react-router-dom";
import { useLaneFeed } from "../../lib/useLaneFeed.js";
import { useTakeoverFeed, MOCK_MINI_AD, MOCK_TICKER_MESSAGES } from "../../lib/useTakeoverFeed.js";
import DisplayLane from "./DisplayLane.jsx";
import BowlerStatsPanel from "./BowlerStatsPanel.jsx";
import MiniAd from "./MiniAd.jsx";

/**
 * DisplayLanePage — route container for /display/:laneId. Wires the real
 * compute-node feed (useLaneFeed) to the presentational <DisplayLane>, and
 * decides what goes in the slot above the bowler scores (currently
 * extended stats for whoever's up + a mini-ad — swap or add to these
 * freely, DisplayLane itself has no opinion). useTakeoverFeed is still a
 * mock (see its own docstring) — the compute node has no ad-scheduling
 * backend; only useLaneFeed's game-state connection is real. The `theme`
 * prop here is where a venue's configured theme would come from once
 * that's sourced from the backend instead of hardcoded.
 */
export default function DisplayLanePage() {
  const { laneId } = useParams();
  const { lane } = useLaneFeed(laneId);
  // Advertising only fires between games — in production this decision
  // belongs to the compute node, not the display; hasActiveGame here is
  // the mock takeover schedule's stand-in for that signal.
  const hasActiveGame = lane.bowlers.length > 0 && lane.machineState !== "GAME_COMPLETE";
  const { activeTakeover } = useTakeoverFeed({ hasActiveGame });
  const activeBowler = lane.bowlers.find((b) => b.id === lane.currentBowlerId) ?? null;

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
