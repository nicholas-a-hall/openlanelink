import { useTheme } from "../../../lib/themes.js";
import ScoreBug from "../ScoreBug.jsx";

function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }

function StatsSlide({ lane, laneId }) {
  const { T } = useTheme();
  const sr = pct(lane.strikes, lane.deliveries);
  const stopr = pct(lane.stops, lane.deliveries);
  const items = [
    { label: "PINS TONIGHT", value: lane.nightlyPins.toLocaleString(), color: T.red },
    { label: "STRIKE RATE", value: `${sr}%`, color: T.green },
    { label: "STOP RATE", value: `${stopr}%`, color: T.blue },
    { label: "DELIVERIES", value: lane.deliveries, color: T.text },
    { label: "JAMS", value: lane.jams, color: T.yellow },
  ];
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      height: "100%", gap: "3vh",
    }}>
      <div style={{ fontFamily: T.fontMono, fontSize: "clamp(10px,1.6vmin,20px)", color: T.muted, letterSpacing: "0.2em" }}>
        LANE {laneId} · TONIGHT
      </div>
      <div style={{ display: "flex", gap: "3vw", flexWrap: "wrap", justifyContent: "center" }}>
        {items.map((it) => (
          <div key={it.label} style={{ textAlign: "center" }}>
            <div style={{ fontFamily: T.fontDisplay, fontSize: "clamp(30px,7vmin,90px)", fontWeight: 700, color: it.color, textShadow: `0 0 24px ${it.color}55` }}>
              {it.value}
            </div>
            <div style={{ fontFamily: T.fontMono, fontSize: "clamp(8px,1vmin,13px)", color: T.muted, letterSpacing: "0.14em", marginTop: 6 }}>
              {it.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

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

const RENDERERS = { ad: AdSlide, video: VideoSlide, stats: StatsSlide, message: MessageSlide };

/**
 * TakeoverLayer — renders whatever `activeTakeover` an external feed hands
 * down. This component has no scheduling logic of its own (per the product
 * decision: ads/stats/video/message takeovers are externally triggered) —
 * it's a pure function of the `activeTakeover` prop, so swapping the mock
 * takeover feed for a real one from the compute node requires no changes
 * here.
 *
 * Props:
 *   activeTakeover: {
 *     id, kind: 'ad'|'video'|'stats'|'message',
 *     scoreBug?: boolean,   // override the kind-based default
 *     ...kind-specific payload (imageUrl / videoUrl / title+subtitle)
 *   } | null
 *   lane, laneId, activeBowlerId — passed through to the built-in stats
 *     slide and the persistent ScoreBug.
 */
export default function TakeoverLayer({ activeTakeover, lane, laneId, activeBowlerId }) {
  const { T } = useTheme();
  if (!activeTakeover) return null;

  const Renderer = RENDERERS[activeTakeover.kind];
  if (!Renderer) return null;

  // stats takeovers fully replace the screen; ad/video/message keep a
  // persistent score bug so scores are never fully hidden by sponsor content
  const showScoreBug = activeTakeover.scoreBug ?? activeTakeover.kind !== "stats";

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
