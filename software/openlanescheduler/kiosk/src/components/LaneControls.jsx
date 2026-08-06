import React from 'react';
import LaneButton from './LaneButton';
import { neuInset } from '../shared';
import { useColors } from '../theme';

export default function LaneControls({
  status,
  walkIn = null,
  cycling = false,
  timeExpired = false,
  onPinsetter,
  onServiceCall,
  onExtend,
}) {
  const C = useColors();
  const inactive = status === 'idle' || status === 'maintenance';

  const buttons = [
    {
      key: 'pinsetter',
      icon: '⚙️',
      label: cycling ? 'Cycling' : 'Pinsetter',
      title: 'Cycle pinsetter — reset pins manually',
      color: C.kioskMagenta,
      spinning: cycling,
      disabled: inactive || cycling || timeExpired,
      onClick: onPinsetter,
    },
    {
      key: 'service',
      icon: '📢',
      label: 'Service',
      title: 'Service call — request assistance',
      color: C.kioskOrange,
      disabled: inactive || timeExpired,
      onClick: onServiceCall,
    },
    {
      key: 'extend',
      icon: '⏰',
      label: walkIn?.type === 'hourly' ? '+1 Hour' : walkIn ? '+1 Game' : 'Extend',
      title: 'Extend session',
      color: C.kioskGreen,
      disabled: !walkIn,
      onClick: onExtend,
    },
  ];

  // Even spacing around the ring, first button at the top (12 o'clock).
  const n = buttons.length;
  const radiusPct = 34; // distance of each button center from the ring center

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      aspectRatio: '1 / 1',
      maxWidth: 'clamp(210px, 36vh, 340px)',
      margin: '0 auto',
      flexShrink: 0,
    }}>
      {/* Decorative center hub ties the ring together */}
      <div style={{
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: '30%',
        height: '30%',
        borderRadius: '50%',
        background: C.surface,
        boxShadow: neuInset(C),
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
      }} />

      {buttons.map((b, i) => {
        const angle = (-90 + i * (360 / n)) * (Math.PI / 180);
        const x = 50 + radiusPct * Math.cos(angle);
        const y = 50 + radiusPct * Math.sin(angle);
        return (
          <div
            key={b.key}
            style={{
              position: 'absolute',
              left: `${x}%`,
              top: `${y}%`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <LaneButton
              icon={b.icon}
              label={b.label}
              title={b.title}
              color={b.color}
              spinning={b.spinning}
              disabled={b.disabled}
              onClick={b.onClick}
            />
          </div>
        );
      })}
    </div>
  );
}
