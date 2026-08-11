import { useTheme } from "../../../lib/themes.js";
import ScoreBug from "../ScoreBug.jsx";

// A "stats" takeover kind (lane-wide strike rate / nightly pinfall / jam
// count) existed here when this was all mock data. Removed: the backend
// doesn't track lane-session stats like this at all (state_machine/game_state.py
// is per-game, not per-night), so there's nothing real to render. Bring
// it back if/when that data actually exists server-side.

function AdSlide({ item }) {
  return (
    <img src={item.imageUrl} alt={item.alt || ""} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
  );
}

function VideoSlide({ item }) {
  return (
    <video
      src={item.videoUrl}
      poster={item.poster}
      autoPlay
      muted
      playsInline
      loop={item.loop !== false}
      style={{ width: "100%", height: "100%", objectFit: "contain" }}
    />
  );
}

function MessageSlide({ item }) {
  const { T } = useTheme();
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: "2vh", textAlign: "center", padding: "0 6vw" }}>
      <div style={{ fontFamily: T.fontDisplay, fontSize: "clamp(24px,5.5vmin,70px)", fontWeight: 700, color: T.text }}>{item.title}</div>
      {item.subtitle && (
        <div style={{ fontFamily: T.fontUi, fontSize: "clamp(12px,2vmin,26px)", color: T.muted }}>{item.subtitle}</div>
      )}
    </div>
  );
}

const RENDERERS = { ad: AdSlide, video: VideoSlide, message: MessageSlide };

/**
 * TakeoverLayer — renders whatever `activeTakeover` an external feed hands
 * down. This component has no scheduling logic of its own (per the product
 * decision: ad/video/message takeovers are externally triggered) — it's a
 * pure function of the `activeTakeover` prop, so swapping the mock
 * takeover feed for a real one from the compute node requires no changes
 * here.
 *
 * Props:
 *   activeTakeover: {
 *     id, kind: 'ad'|'video'|'message',
 *     scoreBug?: boolean,   // override the kind-based default
 *     ...kind-specific payload (imageUrl / videoUrl / title+subtitle)
 *   } | null
 *   lane, laneId, activeBowlerId — passed through to the persistent ScoreBug.
 */
export default function TakeoverLayer({ activeTakeover, lane, laneId, activeBowlerId }) {
  const { T } = useTheme();
  if (!activeTakeover) return null;

  const Renderer = RENDERERS[activeTakeover.kind];
  if (!Renderer) return null;

  const showScoreBug = activeTakeover.scoreBug ?? true;

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 30, background: T.bg,
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      {/* Renderer gets whatever's left after the score bug's own row below
          claims its space — previously the score bug was absolutely
          positioned on top of this area instead, overlapping ad/video/
          message content instead of sitting beside it. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Renderer item={activeTakeover} lane={lane} laneId={laneId} />
      </div>
      {showScoreBug && (
        <div style={{ flexShrink: 0, padding: "0 1.6vw 1.4vh" }}>
          <ScoreBug laneId={laneId} bowlers={lane.bowlers} activeBowlerId={activeBowlerId} floating />
        </div>
      )}
    </div>
  );
}
