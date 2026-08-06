import React from 'react';
import { F } from '../shared';
import { useColors } from '../theme';

export default function BootScreen({ lanes = [] }) {
  const C = useColors();

  return (
    <div style={{
      minHeight: '100vh',
      background: C.surface,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: F.head,
    }}>
      <div style={{
        fontSize: 36,
        fontWeight: 700,
        color: C.kioskCyan,
        textShadow: `0 0 16px ${C.kioskCyan}66`,
        marginBottom: 40,
        letterSpacing: 4,
      }}>
        LUNAR LANES
      </div>
      <div style={{
        fontFamily: F.mono,
        fontSize: 14,
        color: C.kioskGreen,
      }}>
        INITIALIZING LANES {lanes.join(' & ')} TERMINAL...
      </div>
      <div style={{
        fontFamily: F.mono,
        fontSize: 14,
        color: C.kioskGreen,
        marginTop: 20,
        opacity: 0.6,
      }}>
        ████████████░░░░░░░░ 60%
      </div>
    </div>
  );
}
