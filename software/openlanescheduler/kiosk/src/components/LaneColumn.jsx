import React from 'react';
import LaneNumber from './LaneNumber';
import LaneStatusBox from './LaneStatusBox';
import LaneControls from './LaneControls';
import CountdownTimer from './CountdownTimer';
import { useColors } from '../theme';

export default function LaneColumn({
  lane,
  status,
  serviceCall = null,
  walkIn = null,
  remaining = '∞',
  timeExpired = false,
  cycling = false,
  onPinsetter,
  onServiceCall,
  onExtend,
}) {
  const C = useColors();
  const maintenance = status === 'maintenance';

  // Diagonal hazard stripes down each edge while a lane is under maintenance.
  const hazard = (side) => ({
    position: 'absolute',
    top: 0,
    bottom: 0,
    [side]: 0,
    width: 20,
    zIndex: 10,
    pointerEvents: 'none',
    background: `repeating-linear-gradient(${side === 'left' ? '45deg' : '-45deg'}, ${C.maint}4d, ${C.maint}4d 15px, ${C.dim}4d 15px, ${C.dim}4d 30px)`,
  });

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 'clamp(8px, 1.6vh, 20px)',
      padding: '0 30px',
      position: 'relative',
      height: '100%',
      minHeight: 0,
    }}>
      {maintenance && <div style={hazard('left')} />}
      {maintenance && <div style={hazard('right')} />}

      <LaneNumber lane={lane} status={status} />
      <LaneStatusBox status={status} serviceCall={serviceCall} />
      <LaneControls
        status={status}
        walkIn={walkIn}
        cycling={cycling}
        timeExpired={timeExpired}
        onPinsetter={onPinsetter}
        onServiceCall={onServiceCall}
        onExtend={onExtend}
      />
      <CountdownTimer remaining={remaining} timeExpired={timeExpired} />
    </div>
  );
}
