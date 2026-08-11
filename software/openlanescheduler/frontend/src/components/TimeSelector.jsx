import React, { useMemo } from 'react';
import { F, useCompact } from '../shared';
import { useColors } from '../theme';

export default function TimeSelector({
  selectedDate,
  selectedLane,
  selectedTime,
  selectedDuration = 1,
  onTimeSelect,
  onDurationChange,
  reservations = [],
  maintenance = {},
  walkIns = []
}) {
  const compact = useCompact();
  const C = useColors();

  // Generate time slots (9:00 AM to 8:00 PM in 30-minute increments)
  const timeSlots = useMemo(() => {
    const slots = [];
    for (let hour = 9; hour <= 20; hour++) {
      slots.push(`${hour.toString().padStart(2, '0')}:00`);
      if (hour < 20) {
        slots.push(`${hour.toString().padStart(2, '0')}:30`);
      }
    }
    return slots;
  }, []);

  // Convert time string to number (hours + fraction)
  const timeToNum = (timeStr) => {
    const [h, m] = timeStr.split(':').map(Number);
    return h + m / 60;
  };

  // Format time for display (e.g., "14:00" -> "2:00p")
  const formatTime = (timeStr) => {
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h);
    const ampm = hour >= 12 ? 'p' : 'a';
    const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    return `${displayHour}${m === '00' ? '' : ':' + m}${ampm}`;
  };

  // Check if a time slot is available
  const isTimeSlotAvailable = (timeStr, duration) => {
    if (!selectedDate || !selectedLane) return true;

    const startNum = timeToNum(timeStr);
    const endNum = startNum + duration;

    // Check if lane is in maintenance
    if (maintenance[selectedLane]) return false;

    // Check for walk-in conflicts (only if same date as today)
    const today = new Date().toISOString().split('T')[0];
    if (selectedDate === today) {
      const walkIn = walkIns.find(w => w.lane === selectedLane);
      if (walkIn) return false;
    }

    // Check for reservation conflicts
    for (const res of reservations) {
      if (res.lane !== selectedLane) continue;

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

  const Btn = ({ children, color, onClick, active, disabled }) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick?.();
      }}
      disabled={disabled}
      style={{
        fontFamily: F.mono,
        fontSize: compact ? '0.65rem' : '0.72rem',
        letterSpacing: '0.06em',
        padding: compact ? '8px 10px' : '10px 14px',
        minHeight: compact ? 40 : 48,
        border: `1.5px solid ${disabled ? C.dim : active ? color : color + '55'}`,
        background: active ? `${color}22` : disabled ? `${C.dim}11` : `${color}08`,
        color: disabled ? C.dim : color,
        borderRadius: 5,
        cursor: disabled ? 'default' : 'pointer',
        textTransform: 'uppercase',
        boxShadow: active ? `0 0 8px ${color}22` : 'none',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={{ width: '100%' }}>
      {/* Start Time Selection */}
      <div style={{ marginBottom: compact ? 16 : 20 }}>
        <div style={{
          fontFamily: F.mono,
          fontSize: '0.6rem',
          color: C.text,
          letterSpacing: '0.1em',
          marginBottom: 8,
          opacity: 0.7
        }}>
          START TIME
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? 'repeat(3, 1fr)' : 'repeat(4, 1fr)',
          gap: compact ? 6 : 8
        }}>
          {timeSlots.map(time => {
            const available = isTimeSlotAvailable(time, selectedDuration);
            const isSelected = selectedTime === time;

            return (
              <Btn
                key={time}
                color={C.blue}
                active={isSelected}
                disabled={!available}
                onClick={() => onTimeSelect(time)}
              >
                {formatTime(time)}
              </Btn>
            );
          })}
        </div>
      </div>


      {/* Helper text */}
      {selectedTime && (
        <div style={{
          marginTop: compact ? 12 : 16,
          fontFamily: F.mono,
          fontSize: '0.55rem',
          color: C.text,
          opacity: 0.6,
          letterSpacing: '0.08em'
        }}>
          {formatTime(selectedTime)} selected
        </div>
      )}
    </div>
  );
}
