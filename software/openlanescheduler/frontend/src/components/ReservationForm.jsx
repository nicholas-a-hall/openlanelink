import React, { useState } from 'react';
import { F, useCompact } from '../shared';
import { useColors } from '../theme';
import CalendarPicker from './CalendarPicker';
import TimeSelector from './TimeSelector';
import LaneSelector from './LaneSelector';

export default function ReservationForm({
  onSubmit,
  onCancel,
  reservations = [],
  maintenance = {},
  walkIns = [],
  serviceCalls = {}
}) {
  const compact = useCompact();
  const C = useColors();

  // Form state
  const [selectedDate, setSelectedDate] = useState('');
  const [selectedTime, setSelectedTime] = useState('');
  const [selectedDuration, setSelectedDuration] = useState(2); // Default 2 hours
  const [selectedLanes, setSelectedLanes] = useState([]); // Changed to array for multi-lane
  const [partyName, setPartyName] = useState('');
  const [contact, setContact] = useState('');
  const [guests, setGuests] = useState(10);

  // UI state
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState([]);

  // Button component
  const Btn = ({ children, color, onClick, active, w: minW, disabled }) => (
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
        minWidth: minW || (compact ? 40 : 48),
        border: `1.5px solid ${disabled ? C.dim : active ? color : color + '55'}`,
        background: active ? `${color}22` : disabled ? `${C.dim}11` : `${color}08`,
        color: disabled ? C.dim : color,
        borderRadius: 5,
        cursor: disabled ? 'default' : 'pointer',
        textTransform: 'uppercase',
        boxShadow: active ? `0 0 8px ${color}22` : 'none',
        transition: 'all 0.15s',
        whiteSpace: compact ? 'normal' : 'nowrap',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        overflowWrap: compact ? 'break-word' : 'normal',
      }}
    >
      {children}
    </button>
  );

  // Stepper component
  const Stepper = ({ value, onChange, min = 1, max = 20, color, label }) => (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'nowrap',
      flexShrink: 0
    }}>
      <span style={{
        fontFamily: F.mono,
        fontSize: '0.6rem',
        color: C.text,
        letterSpacing: '0.1em',
        minWidth: compact ? 45 : 55,
        whiteSpace: 'nowrap'
      }}>
        {label}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onChange(Math.max(min, value - 1));
        }}
        style={{
          width: compact ? 36 : 44,
          height: compact ? 36 : 44,
          border: `1px solid ${color}55`,
          background: `${color}11`,
          color,
          borderRadius: 4,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'monospace',
          fontSize: 18,
          padding: 0,
          flexShrink: 0
        }}
      >
        −
      </button>
      <span style={{
        fontFamily: F.head,
        fontSize: '1rem',
        fontWeight: 700,
        color,
        textShadow: `0 0 6px ${color}66`,
        minWidth: 24,
        textAlign: 'center',
        flexShrink: 0
      }}>
        {value}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onChange(Math.min(max, value + 1));
        }}
        style={{
          width: compact ? 36 : 44,
          height: compact ? 36 : 44,
          border: `1px solid ${color}55`,
          background: `${color}11`,
          color,
          borderRadius: 4,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'monospace',
          fontSize: 18,
          padding: 0,
          flexShrink: 0
        }}
      >
        +
      </button>
    </div>
  );

  // Input component
  const Input = ({ value, onChange, placeholder, type: inputType = 'text' }) => (
    <input
      type={inputType}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        fontFamily: F.mono,
        fontSize: compact ? '0.7rem' : '0.8rem',
        padding: compact ? '10px 12px' : '12px 14px',
        background: C.bg,
        border: `1.5px solid ${C.blue}55`,
        borderRadius: 5,
        color: C.text,
        width: '100%',
        outline: 'none',
        transition: 'all 0.15s',
      }}
      onFocus={(e) => {
        e.target.style.borderColor = C.blue;
        e.target.style.boxShadow = `0 0 8px ${C.blue}22`;
      }}
      onBlur={(e) => {
        e.target.style.borderColor = `${C.blue}55`;
        e.target.style.boxShadow = 'none';
      }}
    />
  );

  // Get unique dates with reservations for calendar highlighting
  const reservationDates = [...new Set(
    reservations
      .map(r => r.date || new Date().toISOString().split('T')[0])
      .filter(Boolean)
  )];

  // Validate form
  const validate = () => {
    const newErrors = [];

    if (!selectedDate) newErrors.push('Please select a date');
    if (!selectedTime) newErrors.push('Please select a start time');
    if (!selectedDuration) newErrors.push('Please select a duration');
    if (!selectedLanes || selectedLanes.length === 0) {
      newErrors.push('Please select at least one lane');
    }
    if (!partyName || partyName.trim().length < 2) {
      newErrors.push('Party name must be at least 2 characters');
    }
    if (!contact || contact.trim().length < 3) {
      newErrors.push('Contact information is required');
    }

    setErrors(newErrors);
    return newErrors.length === 0;
  };

  // Handle submit
  const handleSubmit = () => {
    if (!validate()) return;

    setLoading(true);
    setErrors([]);

    // Submit reservations for each selected lane
    onSubmit({
      date: selectedDate,
      startTime: selectedTime,
      duration: selectedDuration,
      lanes: selectedLanes, // Send array of lanes
      party: partyName.trim(),
      contact: contact.trim(),
      guests,
      reservationType: 'reservation', // Reservations are their own category
    });
  };

  return (
    <div style={{
      width: '100%',
      maxWidth: 600,
      margin: '0 auto',
      padding: compact ? 16 : 24
    }}>
      {/* Single column layout */}
      <div>
        {/* Date Selection */}
        <div style={{ marginBottom: compact ? 24 : 28 }}>
          <div style={{
            fontFamily: F.head,
            fontSize: compact ? '0.95rem' : '1.2rem',
            fontWeight: 700,
            color: C.blue,
            marginBottom: compact ? 12 : 16,
            textTransform: 'uppercase',
            letterSpacing: '0.05em'
          }}>
            1. Select Date & Duration
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <CalendarPicker
              selectedDate={selectedDate}
              onDateChange={setSelectedDate}
              reservationDates={reservationDates}
            />
          </div>

          {/* Duration Selection */}
          {selectedDate && (
            <div style={{ marginTop: 16 }}>
              <div style={{
                fontFamily: F.mono,
                fontSize: '0.65rem',
                color: C.text,
                letterSpacing: '0.1em',
                marginBottom: 12,
                textTransform: 'uppercase'
              }}>
                Duration
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 10
              }}>
                {[2, 3, 4].map(hours => (
                  <Btn
                    key={hours}
                    color={C.purple}
                    active={selectedDuration === hours}
                    onClick={() => setSelectedDuration(hours)}
                  >
                    {hours} Hour{hours > 1 ? 's' : ''}
                  </Btn>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Time Selection */}
        {selectedDate && selectedDuration && (
          <div style={{ marginBottom: compact ? 24 : 28 }}>
            <div style={{
              fontFamily: F.head,
              fontSize: compact ? '0.95rem' : '1.2rem',
              fontWeight: 700,
              color: C.blue,
              marginBottom: compact ? 12 : 16,
              textTransform: 'uppercase',
              letterSpacing: '0.05em'
            }}>
              2. Select Time
            </div>
            <TimeSelector
              selectedDate={selectedDate}
              selectedLane={selectedLanes[0] || null}
              selectedTime={selectedTime}
              selectedDuration={selectedDuration}
              onTimeSelect={setSelectedTime}
              onDurationChange={setSelectedDuration}
              reservations={reservations}
              maintenance={maintenance}
              walkIns={walkIns}
            />
          </div>
        )}

        {/* Lane Selection */}
        {selectedDate && selectedDuration && selectedTime && (
          <div style={{ marginBottom: compact ? 24 : 28 }}>
            <div style={{
              fontFamily: F.head,
              fontSize: compact ? '0.95rem' : '1.2rem',
              fontWeight: 700,
              color: C.blue,
              marginBottom: compact ? 12 : 16,
              textTransform: 'uppercase',
              letterSpacing: '0.05em'
            }}>
              3. Select Lane(s)
            </div>
            <LaneSelector
              selectedDate={selectedDate}
              selectedTime={selectedTime}
              selectedDuration={selectedDuration}
              selectedLanes={selectedLanes}
              onLaneSelect={(lane) => {
                // Toggle lane selection
                if (selectedLanes.includes(lane)) {
                  setSelectedLanes(selectedLanes.filter(l => l !== lane));
                } else {
                  setSelectedLanes([...selectedLanes, lane]);
                }
              }}
              multiSelect={true}
              reservations={reservations}
              maintenance={maintenance}
              walkIns={walkIns}
              serviceCalls={serviceCalls}
            />
          </div>
        )}

        {/* Party Details */}
        {selectedDate && selectedDuration && selectedTime && selectedLanes.length > 0 && (
          <div style={{ marginBottom: compact ? 24 : 28 }}>
            <div style={{
              fontFamily: F.head,
              fontSize: compact ? '0.95rem' : '1.2rem',
              fontWeight: 700,
              color: C.blue,
              marginBottom: compact ? 12 : 16,
              textTransform: 'uppercase',
              letterSpacing: '0.05em'
            }}>
              4. Party Details
            </div>

            {/* Party Name */}
            <div style={{ marginBottom: 16 }}>
              <div style={{
                fontFamily: F.mono,
                fontSize: '0.6rem',
                color: C.text,
                letterSpacing: '0.08em',
                marginBottom: 8,
                textTransform: 'uppercase'
              }}>
                Party Name *
              </div>
              <Input
                value={partyName}
                onChange={setPartyName}
                placeholder="Enter party name"
              />
            </div>

            {/* Contact */}
            <div style={{ marginBottom: 16 }}>
              <div style={{
                fontFamily: F.mono,
                fontSize: '0.6rem',
                color: C.text,
                letterSpacing: '0.08em',
                marginBottom: 8,
                textTransform: 'uppercase'
              }}>
                Contact *
              </div>
              <Input
                value={contact}
                onChange={setContact}
                placeholder="555-1234 or email@example.com"
              />
            </div>

            {/* Guests */}
            <div style={{ marginBottom: 16 }}>
              <div style={{
                fontFamily: F.mono,
                fontSize: '0.6rem',
                color: C.text,
                letterSpacing: '0.08em',
                marginBottom: 8,
                textTransform: 'uppercase'
              }}>
                Number of Guests
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[10, 20, 30, 40, 50].map(count => (
                  <Btn
                    key={count}
                    color={C.pink}
                    onClick={() => setGuests(count)}
                    active={guests === count}
                  >
                    {count}
                  </Btn>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Errors */}
      {errors.length > 0 && (
        <div style={{
          background: `${C.red}15`,
          border: `2px solid ${C.red}55`,
          borderRadius: 8,
          padding: 16,
          marginBottom: 24
        }}>
          {errors.map((error, i) => (
            <div
              key={i}
              style={{
                fontFamily: F.mono,
                fontSize: '0.7rem',
                color: C.red,
                marginBottom: i < errors.length - 1 ? 8 : 0,
                letterSpacing: '0.05em'
              }}
            >
              {'\u2022'} {error}
            </div>
          ))}
        </div>
      )}

      {/* Actions - Full width at bottom */}
      <div style={{
        display: 'flex',
        gap: 16,
        justifyContent: 'flex-end',
        paddingTop: 24,
        borderTop: `2px solid ${C.blue}22`,
      }}>
        <Btn
          color={C.dim}
          onClick={onCancel}
          disabled={loading}
          w={compact ? undefined : 200}
        >
          Cancel
        </Btn>
        <Btn
          color={C.green}
          onClick={handleSubmit}
          disabled={loading || selectedLanes.length === 0}
          w={compact ? undefined : 200}
        >
          {loading ? 'Creating...' : 'Create Reservation'}
        </Btn>
      </div>
    </div>
  );
}
