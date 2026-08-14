import { useParams } from "react-router-dom";
import { useLaneFeed } from "../../lib/useLaneFeed.js";
import { useDocumentTitle } from "../../lib/useDocumentTitle.js";
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
  useDocumentTitle(`Lane ${laneId} Overhead`);
  const { lane } = useLaneFeed(laneId);
  // Full-screen takeovers are OFF. The schedule driving them is a mock
  // (useTakeoverFeed) with no backend behind it, so what it actually does
  // today is cover a live scoreboard with invented adverts at random —
  // which makes the display useless to look at while anyone is working on
  // it. Flip this back on when there's a real ad-scheduling backend and a
  // real decision about when a takeover is allowed to interrupt a game;
  // the whole path below still works, it just isn't fed.
  const TAKEOVERS_ENABLED = false;
  const hasActiveGame = lane.bowlers.length > 0 && lane.machineState !== "GAME_COMPLETE";
  const { activeTakeover } = useTakeoverFeed({ hasActiveGame });
  const activeBowler = lane.bowlers.find((b) => b.id === lane.currentBowlerId) ?? null;

  return (
    <DisplayLane
      laneId={laneId}
      lane={lane}
      theme="midnight-arcade"
      activeTakeover={TAKEOVERS_ENABLED ? activeTakeover : null}
      tickerMessages={MOCK_TICKER_MESSAGES}
      tickerEnabled
      // The sponsor slot shares the bottom ticker strip now, rather than
      // taking a column in the band above the scores -- both are venue
      // messaging, so they belong together, and the scorecards get the
      // height back.
      tickerLead={<MiniAd ad={MOCK_MINI_AD} />}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <BowlerStatsPanel bowler={activeBowler} ballSpeed={lane.ballSpeed} />
      </div>
    </DisplayLane>
  );
}
