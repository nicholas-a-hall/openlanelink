import React from 'react';
import { F, neuRaised } from '../shared';
import { useColors } from '../theme';

export default function NotificationStack({ notifications = [] }) {
  const C = useColors();
  const colorFor = (type) => (type === 'success' ? C.kioskGreen : C.kioskCyan);

  return (
    <>
      {notifications.map((n, i) => {
        const color = colorFor(n.type);
        return (
          <div
            key={n.id}
            style={{
              position: 'fixed',
              left: '50%',
              transform: 'translateX(-50%)',
              top: 100 + i * 60,
              padding: '15px 30px',
              borderRadius: 8,
              zIndex: 2000,
              textTransform: 'uppercase',
              letterSpacing: 2,
              fontSize: 14,
              fontWeight: 700,
              fontFamily: F.head,
              background: C.surface,
              color,
              boxShadow: `${neuRaised(C)}, 0 0 20px ${color}4d`,
            }}
          >
            {n.message}
          </div>
        );
      })}
    </>
  );
}
