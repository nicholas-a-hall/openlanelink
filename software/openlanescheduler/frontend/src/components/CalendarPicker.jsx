import Calendar from 'react-calendar';
import { F, useCompact } from '../shared';
import { useColors } from '../theme';

export default function CalendarPicker({ selectedDate, onDateChange, reservationDates = [] }) {
  const compact = useCompact();
  const C = useColors();

  // Convert reservation dates to set for quick lookup
  const reservationDateSet = new Set(reservationDates);

  // Helper to convert Date to local YYYY-MM-DD string (no timezone conversion)
  const toLocalDateString = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  // Check if a date has reservations
  const hasReservations = (date) => {
    const dateStr = toLocalDateString(date);
    return reservationDateSet.has(dateStr);
  };

  return (
    <div style={{
      width: '100%',
      fontFamily: F.mono,
    }}>
      <style>{`
        .lunar-calendar {
          width: 100%;
          background: ${C.card};
          border: 1.5px solid ${C.blue}55;
          border-radius: 8px;
          padding: ${compact ? '8px' : '16px'};
          font-family: ${F.mono};
          color: ${C.text};
        }
        .lunar-calendar .react-calendar__navigation {
          display: flex;
          gap: ${compact ? '4px' : '8px'};
          margin-bottom: ${compact ? '10px' : '16px'};
        }
        .lunar-calendar .react-calendar__navigation button {
          font-family: ${F.mono};
          font-size: ${compact ? '0.65rem' : '0.8rem'};
          color: ${C.blue};
          background: ${C.blue}11;
          border: 1px solid ${C.blue}55;
          border-radius: 4px;
          padding: ${compact ? '6px 8px' : '10px 14px'};
          cursor: pointer;
          transition: all 0.15s;
          letter-spacing: 0.05em;
          text-transform: uppercase;
          min-height: ${compact ? '36px' : '44px'};
        }
        .lunar-calendar .react-calendar__navigation button:hover:not(:disabled) {
          background: ${C.blue}22;
          border-color: ${C.blue};
        }
        .lunar-calendar .react-calendar__navigation button:disabled {
          opacity: 0.3;
          cursor: default;
        }
        .lunar-calendar .react-calendar__navigation__label {
          flex-grow: 1;
          font-weight: 700;
        }
        .lunar-calendar .react-calendar__month-view__weekdays {
          font-size: ${compact ? '0.6rem' : '0.7rem'};
          color: ${C.text};
          opacity: 0.6;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          margin-bottom: ${compact ? '6px' : '10px'};
          display: grid !important;
          grid-template-columns: repeat(7, 1fr);
          gap: ${compact ? '4px' : '6px'};
        }
        .lunar-calendar .react-calendar__month-view__weekdays__weekday {
          padding: ${compact ? '6px 2px' : '10px 4px'};
          text-align: center;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .lunar-calendar .react-calendar__month-view__weekdays__weekday abbr {
          text-decoration: none;
        }
        .lunar-calendar .react-calendar__month-view__days {
          display: grid !important;
          grid-template-columns: repeat(7, 1fr);
          gap: ${compact ? '4px' : '6px'};
        }
        .lunar-calendar .react-calendar__tile {
          font-family: ${F.mono};
          font-size: ${compact ? '0.7rem' : '0.85rem'};
          color: ${C.text};
          background: ${C.bg};
          border: 1px solid ${C.dim}55;
          border-radius: 4px;
          padding: ${compact ? '6px 2px' : '12px 6px'};
          cursor: pointer;
          transition: all 0.15s;
          aspect-ratio: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
        }
        .lunar-calendar .react-calendar__tile:hover:not(:disabled) {
          background: ${C.blue}11;
          border-color: ${C.blue}55;
        }
        .lunar-calendar .react-calendar__tile--now {
          border-color: ${C.green}55;
          background: ${C.green}08;
        }
        .lunar-calendar .react-calendar__tile--active {
          background: ${C.blue} !important;
          border-color: ${C.blue} !important;
          color: ${C.bg} !important;
          font-weight: 900;
          box-shadow: 0 0 16px ${C.blue}66, inset 0 0 20px ${C.blue}33;
          transform: scale(1.05);
        }
        .lunar-calendar .react-calendar__tile--disabled {
          opacity: 0.3;
          cursor: default;
          background: ${C.bg};
        }
        .lunar-calendar .react-calendar__tile--neighboringMonth {
          opacity: 0.3;
        }
        .lunar-calendar .react-calendar__tile.has-reservations::after {
          content: '';
          position: absolute;
          bottom: ${compact ? '2px' : '4px'};
          left: 50%;
          transform: translateX(-50%);
          width: ${compact ? '3px' : '4px'};
          height: ${compact ? '3px' : '4px'};
          border-radius: 50%;
          background: ${C.purple};
        }
        .lunar-calendar abbr {
          text-decoration: none;
        }
      `}</style>

      <Calendar
        className="lunar-calendar"
        value={selectedDate ? new Date(selectedDate + 'T12:00:00') : null}
        onChange={(date) => {
          const dateStr = toLocalDateString(date);
          onDateChange(dateStr);
        }}
        minDate={(() => {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          return today;
        })()}
        tileClassName={({ date }) => {
          return hasReservations(date) ? 'has-reservations' : '';
        }}
        tileDisabled={({ date }) => {
          // Disable past dates (compare dates only, not time)
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const checkDate = new Date(date);
          checkDate.setHours(0, 0, 0, 0);
          return checkDate < today;
        }}
        showNeighboringMonth={true}
        formatShortWeekday={(_locale, date) => {
          return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][date.getDay()];
        }}
      />
    </div>
  );
}
