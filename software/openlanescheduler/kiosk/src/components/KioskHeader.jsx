import React from 'react';
import { F, neuRaised } from '../shared';
import { useColors } from '../theme';

export default function KioskHeader({ lanes = [] }) {
  const C = useColors();

  return (
    <header style={{
      flexShrink: 0,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 24,
      padding: '15px 20px',
      background: C.surface,
      borderRadius: 10,
      boxShadow: neuRaised(C),
      fontFamily: F.head,
    }}>
      <div style={{
        fontSize: 20,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 3,
        color: `${C.kioskCyan}80`,
        textShadow: `0 0 5px ${C.kioskCyan}4d`,
        opacity: 0.6,
      }}>
        OPENLANE SCHEDULER
      </div>
      <div style={{
        fontSize: 18,
        color: C.kioskCyan,
        textTransform: 'uppercase',
        fontWeight: 700,
        letterSpacing: 2,
      }}>
        Lanes {lanes.join(' & ')}
      </div>
    </header>
  );
}
