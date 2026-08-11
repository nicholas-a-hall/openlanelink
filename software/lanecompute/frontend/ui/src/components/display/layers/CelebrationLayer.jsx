import { useEffect, useRef, useState } from "react";

/**
 * CelebrationLayer — short, event-triggered overlay (e.g. a strike burst).
 * Self-contained: watches `latestEvent` and fires on its own the instant a
 * matching event type comes through, no external scheduling involved. This
 * is deliberately separate from <TakeoverLayer>, which only shows whatever
 * an external feed/prop tells it to.
 *
 * Plays alpha-channel WebM (per the product decision) so the celebration
 * composites over the live score view instead of covering it with an
 * opaque box. No real assets ship yet — pass `assets` (a map of event type
 * -> .webm URL) once celebration clips exist; with no matching asset this
 * layer silently renders nothing.
 *
 * Reports its own playing/not-playing state via `onPlayingChange` so
 * other parts of the screen — notably the bowler queue's turn-change
 * reorder — can wait for a celebration to actually finish instead of
 * assuming a fixed duration. With no asset for a given event (the
 * default, since no clips exist yet), nothing plays and this reports
 * `false` immediately, so downstream consumers aren't blocked on an
 * animation that was never going to happen.
 *
 * Props:
 *   latestEvent: { type, msg, ts } | null   — most recent lane event
 *   assets: { [eventType: string]: string } — event type -> webm URL
 *   onPlayingChange?: (isPlaying: boolean) => void
 */
export default function CelebrationLayer({ latestEvent, assets = {}, onPlayingChange }) {
  const [playing, setPlaying] = useState(null); // the webm URL currently playing
  const lastKeyRef = useRef(null);

  useEffect(() => {
    if (!latestEvent) return;
    const key = `${latestEvent.ts}:${latestEvent.msg}`;
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    const src = assets[latestEvent.type];
    if (src) setPlaying(src);
  }, [latestEvent, assets]);

  useEffect(() => {
    onPlayingChange?.(playing != null);
  }, [playing, onPlayingChange]);

  if (!playing) return null;

  return (
    <div style={{
      position: "absolute", inset: 0, zIndex: 40,
      pointerEvents: "none", display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <video
        key={playing}
        src={playing}
        autoPlay
        muted
        playsInline
        onEnded={() => setPlaying(null)}
        onError={() => setPlaying(null)}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    </div>
  );
}
