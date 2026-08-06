import React from 'react';
import { F, neuInset } from '../shared';
import { useColors } from '../theme';

export default function CountdownTimer({ remaining = '∞', timeExpired = false }) {
  const C = useColors();
  const inactive = remaining === '∞';

  return (
    <div style={{
      padding: 'clamp(10px, 1.8vh, 20px)',
      background: C.surface,
      borderRadius: 12,
      boxShadow: neuInset(C),
      textAlign: 'center',
      flexShrink: 0,
      opacity: inactive ? 0.4 : 1,
      fontFamily: F.head,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: 8,
        color: inactive ? C.dim : `${C.amber}cc`,
      }}>
        TIME REMAINING
      </div>
      <div style={{
        fontSize: 42,
        fontWeight: 400,
        letterSpacing: 8,
        fontFamily: '"SevenSegment", "Courier New", monospace',
        color: inactive ? C.dim : C.amber,
        textShadow: inactive ? 'none' : `0 0 10px ${C.amber}59`,
      }}>
        {remaining}
      </div>
      {timeExpired && (
        <div style={{
          marginTop: 12,
          fontSize: 14,
          fontWeight: 700,
          color: C.red,
          textShadow: `0 0 10px ${C.red}66`,
          letterSpacing: 2,
          fontFamily: F.head,
        }}>
          ⚠️ TIME EXPIRED ⚠️
        </div>
      )}
    </div>
  );
}
