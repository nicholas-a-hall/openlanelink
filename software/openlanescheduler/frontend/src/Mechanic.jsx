import { useSocket } from './shared';
import { useColors, useTheme } from './theme';
import MechanicsView from './MechanicsView';

/**
 * Mechanic - Standalone mechanics interface at /mechanic route
 * Styled to match kiosk cyberpunk/terminal aesthetic
 */
export default function Mechanic() {
  const { state: S, dispatch, socket } = useSocket();
  const C = useColors();
  const { isDark } = useTheme();

  const res = S?.reservations || [];
  const walks = S?.walkIns || [];
  const maint = S?.maintenance || {};
  const serviceCalls = S?.serviceCalls || {};

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: ${C.bg};
          min-height: 100vh;
        }

        /* Subtle CRT Effects */
        .scanlines-mechanic {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: repeating-linear-gradient(0deg, rgba(0,0,0,var(--ll-scanline-opacity)) 0px, rgba(0,0,0,var(--ll-scanline-opacity)) 1px, transparent 1px, transparent 2px);
          pointer-events: none;
          z-index: 10000;
        }

        .crt-overlay-mechanic {
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: radial-gradient(ellipse at center, transparent 0%, rgba(0,0,0,var(--ll-vignette-opacity)) 100%);
          pointer-events: none;
          z-index: 9999;
        }
      `}</style>

      {/* CRT Effects — only in dark mode */}
      {isDark && <div className="scanlines-mechanic" />}
      {isDark && <div className="crt-overlay-mechanic" />}

      <MechanicsView
        reservations={res}
        walkIns={walks}
        maintenance={maint}
        serviceCalls={serviceCalls}
        dispatch={dispatch}
        socket={socket}
      />
    </>
  );
}
