import React from 'react';
import { F, LANES, useCompact } from '../shared';
import { useColors } from '../theme';

export default function LaneSelector({
  selectedDate,
  selectedTime,
  selectedDuration,
  selectedLane,
  selectedLanes = [],
  onLaneSelect,
  multiSelect = false,
  reservations = [],
  maintenance = {},
  walkIns = [],
  serviceCalls = {}
}) {
  const compact = useCompact();
  const C = useColors();

  // Convert time string to number (hours + fraction)
  const timeToNum = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h + m / 60;
  };

  // Calculate walk-in duration in minutes
  const walkMins = (w) => {
    const baseMins = w.type === 'hourly' ? (w.hours || 1) * 60 : ((w.bowlers || 1) * (w.games || 1) * 10 + 15);
    return baseMins + 5; // 5 minute grace period
  };

  // Calculate service call minutes for a walk-in
  const serviceCallMins = (walkIn) => {
    let ms = walkIn.serviceCallMs || 0;
    const serviceCall = serviceCalls[walkIn.lane];
    if (serviceCall) {
      ms += Date.now() - serviceCall.start;
    }
    return ms / 60000;
  };

  // Calculate walk-in estimated end time as a number (hours + fraction)
  const getWalkInEndTime = (walkIn) => {
    const openedAt = new Date(walkIn.openedAt);
    const durationMins = walkMins(walkIn);
    const serviceCallMinutes = serviceCallMins(walkIn);
    const totalMins = durationMins + serviceCallMinutes;

    const endTime = new Date(openedAt.getTime() + totalMins * 60000);
    return endTime.getHours() + endTime.getMinutes() / 60;
  };

  // Check if a lane is available for the selected time slot
  const isLaneAvailable = (lane) => {
    if (!selectedDate || !selectedTime || !selectedDuration) return true;

    const startNum = timeToNum(selectedTime);
    const endNum = startNum + selectedDuration;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Check if lane is in maintenance (blocks all dates)
    if (maintenance[lane]) return false;

    // Check for walk-in conflicts (only if same date as today)
    if (selectedDate === today) {
      const walkIn = walkIns.find(w => w.lane === lane);
      if (walkIn) {
        // Only block if reservation start time is before walk-in end time (+ 30m buffer)
        const walkInEnd = getWalkInEndTime(walkIn);
        if (startNum < walkInEnd) return false;
      }
    }

    // Check for reservation conflicts
    for (const res of reservations) {
      if (res.lane !== lane) continue;

      const resDate = res.date || today;
      if (resDate !== selectedDate) continue;

      const resStart = timeToNum(res.start);
      const resEnd = timeToNum(res.end);

      // Check for overlap
      if (startNum < resEnd && endNum > resStart) {
        return false;
      }
    }

    return true;
  };

  // Get reason why a lane is unavailable
  const getUnavailableReason = (lane) => {
    if (!selectedDate || !selectedTime || !selectedDuration) return null;

    const startNum = timeToNum(selectedTime);
    const endNum = startNum + selectedDuration;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Maintenance blocks all dates
    if (maintenance[lane]) return 'Maintenance';

    // Walk-ins only relevant for today
    if (selectedDate === today) {
      const walkIn = walkIns.find(w => w.lane === lane);
      if (walkIn) {
        // Only show as unavailable if reservation starts before walk-in end time (+ 30m buffer)
        const walkInEnd = getWalkInEndTime(walkIn);
        if (startNum < walkInEnd) return 'Walk-in';
      }
    }

    for (const res of reservations) {
      if (res.lane !== lane) continue;

      const resDate = res.date || today;
      if (resDate !== selectedDate) continue;

      const resStart = timeToNum(res.start);
      const resEnd = timeToNum(res.end);

      if (startNum < resEnd && endNum > resStart) {
        return 'Reserved';
      }
    }

    return null;
  };

  const Btn = ({ children, color, onClick, active, disabled, subtitle }) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick?.();
      }}
      disabled={disabled}
      style={{
        fontFamily: F.mono,
        fontSize: compact ? '0.7rem' : '0.8rem',
        letterSpacing: '0.06em',
        padding: compact ? '12px 8px' : '16px 12px',
        minHeight: compact ? 60 : 70,
        border: `2px solid ${disabled ? C.dim : active ? color : color + '55'}`,
        background: active ? `${color}22` : disabled ? `${C.dim}11` : `${color}08`,
        color: disabled ? C.dim : color,
        borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        textTransform: 'uppercase',
        boxShadow: active ? `0 0 12px ${color}33` : 'none',
        transition: 'all 0.15s',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        position: 'relative'
      }}
    >
      <div style={{
        fontFamily: F.head,
        fontSize: compact ? '1.1rem' : '1.3rem',
        fontWeight: 700
      }}>
        {children}
      </div>
      {subtitle && (
        <div style={{
          fontFamily: F.mono,
          fontSize: compact ? '0.5rem' : '0.55rem',
          opacity: 0.7,
          letterSpacing: '0.08em'
        }}>
          {subtitle}
        </div>
      )}
    </button>
  );

  return (
    <div style={{ width: '100%' }}>
      <div style={{
        fontFamily: F.mono,
        fontSize: '0.6rem',
        color: C.text,
        letterSpacing: '0.1em',
        marginBottom: 8,
        opacity: 0.7
      }}>
        SELECT LANE{multiSelect ? 'S' : ''} {multiSelect && '(Multiple allowed)'}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: compact ? 'repeat(4, 1fr)' : 'repeat(4, 1fr)',
        gap: compact ? 8 : 10
      }}>
        {LANES.map(lane => {
          const available = isLaneAvailable(lane);
          const isSelected = multiSelect
            ? selectedLanes.includes(lane)
            : selectedLane === lane;
          const reason = !available ? getUnavailableReason(lane) : null;

          return (
            <Btn
              key={lane}
              color={C.green}
              active={isSelected}
              disabled={!available}
              onClick={() => onLaneSelect(lane)}
              subtitle={reason}
            >
              {lane}
            </Btn>
          );
        })}
      </div>

      {/* Helper text */}
      {multiSelect && selectedLanes.length > 0 && (
        <div style={{
          marginTop: compact ? 12 : 16,
          fontFamily: F.mono,
          fontSize: '0.55rem',
          color: C.green,
          opacity: 0.8,
          letterSpacing: '0.08em'
        }}>
          {selectedLanes.length === 1
            ? `Lane ${selectedLanes[0]} selected`
            : `Lanes ${selectedLanes.sort((a, b) => a - b).join(', ')} selected`}
        </div>
      )}
      {!multiSelect && selectedLane && (
        <div style={{
          marginTop: compact ? 12 : 16,
          fontFamily: F.mono,
          fontSize: '0.55rem',
          color: C.green,
          opacity: 0.8,
          letterSpacing: '0.08em'
        }}>
          Lane {selectedLane} selected
        </div>
      )}

      {!selectedDate && (
        <div style={{
          marginTop: compact ? 12 : 16,
          fontFamily: F.mono,
          fontSize: '0.55rem',
          color: C.dim,
          opacity: 0.8,
          letterSpacing: '0.08em'
        }}>
          Select date and time first
        </div>
      )}

      {selectedDate && !selectedTime && (
        <div style={{
          marginTop: compact ? 12 : 16,
          fontFamily: F.mono,
          fontSize: '0.55rem',
          color: C.dim,
          opacity: 0.8,
          letterSpacing: '0.08em'
        }}>
          Select time and duration to see lane availability
        </div>
      )}
    </div>
  );
}
