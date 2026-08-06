import React from 'react';
import { F, neuInset } from '../shared';
import { useColors } from '../theme';

export default function LaneStatusBox({ status = 'idle', serviceCall = null }) {
  const C = useColors();

  const map = {
    idle: { text: 'LANE IDLE', color: C.dim },
    maintenance: { text: 'MAINTENANCE', color: C.maint },
    active: { text: 'READY', color: C.kioskGreen },
    service_call: {
      text: serviceCall?.origin === 'kiosk' ? 'SERVICE CALL REQUESTED' : 'PLEASE WAIT',
      color: C.kioskYellow,
    },
    service_call_acked: { text: 'STAFF RESPONDING — PLEASE WAIT', color: C.kioskYellow },
  };
  const { text, color } = map[status] || map.idle;
  const glow = status === 'active' || status === 'service_call' || status === 'service_call_acked';
  const wide = status === 'idle' || status === 'maintenance' || status === 'active';

  return (
    <div style={{
      background: C.surface,
      borderRadius: 12,
      boxShadow: neuInset(C),
      padding: 'clamp(12px, 2vh, 25px)',
      textAlign: 'center',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      flexShrink: 0,
      fontFamily: F.head,
    }}>
      <div style={{
        fontSize: status === 'service_call' ? 16 : 20,
        fontWeight: 700,
        letterSpacing: wide ? 3 : 1.5,
        textTransform: 'uppercase',
        lineHeight: 1.2,
        color,
        opacity: status === 'maintenance' ? 0.7 : 1,
        textShadow: glow ? `0 0 8px ${color}59` : 'none',
      }}>
        {text}
      </div>
      {serviceCall && !serviceCall.acked && (
        <div style={{
          marginTop: 8,
          fontSize: 14,
          color: C.text,
          fontWeight: 400,
          letterSpacing: 1,
          fontFamily: F.mono,
        }}>
          {serviceCall.origin === 'kiosk' ? 'Help requested' : 'Staff initiated service'}
        </div>
      )}
    </div>
  );
}
