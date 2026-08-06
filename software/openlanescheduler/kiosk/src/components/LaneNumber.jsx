import React from 'react';
import { F } from '../shared';
import { useColors } from '../theme';

// Maps a lane status to its accent color.
const statusColor = (C, status) => ({
  idle: C.dim,
  maintenance: C.maint,
  active: C.kioskGreen,
  service_call: C.kioskYellow,
  service_call_acked: C.kioskCyan,
}[status] || C.dim);

export default function LaneNumber({ lane, status = 'idle' }) {
  const C = useColors();
  const color = statusColor(C, status);
  const glow = status !== 'idle' && status !== 'maintenance';

  return (
    <div style={{
      fontFamily: F.head,
      fontSize: 'clamp(48px, 9vh, 96px)',
      fontWeight: 700,
      lineHeight: 1,
      textAlign: 'center',
      padding: 'clamp(4px, 1.2vh, 20px) 0',
      flexShrink: 0,
      color,
      opacity: status === 'maintenance' ? 0.6 : 1,
      textShadow: glow ? `0 0 14px ${color}66` : 'none',
      transition: 'color 0.3s ease, text-shadow 0.3s ease',
    }}>
      {String(lane).padStart(2, '0')}
    </div>
  );
}
