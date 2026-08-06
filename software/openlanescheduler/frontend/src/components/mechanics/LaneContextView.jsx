import { useState } from 'react';
import { F, useCompact, formatDateYYYYMMDD } from '../../shared';
import { useColors } from '../../theme';

export default function LaneContextView({ reservations, walkIns, maintenanceTasks, dispatch }) {
  const C = useColors();
  const compact = useCompact();
  const [selectedLane, setSelectedLane] = useState(1);

  const timeToNum = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h + m / 60;
  };

  const nowNum = () => {
    const n = new Date();
    return n.getHours() + n.getMinutes() / 60;
  };

  const formatTime = (t) => {
    const [h, m] = t.split(':');
    const hr = parseInt(h);
    return `${hr > 12 ? hr - 12 : hr || 12}:${m}${hr >= 12 ? 'p' : 'a'}`;
  };

  const formatDate = (dateStr) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${dayNames[date.getDay()]}, ${monthNames[date.getMonth()]} ${date.getDate()}`;
  };

  // Get today's schedule for selected lane
  const getTodaySchedule = () => {
    const today = new Date().toISOString().split('T')[0];
    const nn = nowNum();

    const schedule = [];

    // Current walk-in
    const walkIn = walkIns.find(w => w.lane === selectedLane);
    if (walkIn) {
      const openedAt = new Date(walkIn.openedAt);
      const startTime = `${openedAt.getHours().toString().padStart(2, '0')}:${openedAt.getMinutes().toString().padStart(2, '0')}`;

      let estimatedClose = 'Unknown';
      let estimatedMins = 0;
      if (walkIn.type === 'hourly' && walkIn.hours) {
        estimatedMins = walkIn.hours * 60;
      } else if (walkIn.type === 'per-game' && walkIn.games) {
        estimatedMins = walkIn.games * 10 * (walkIn.bowlers || 1) + 15;
      }

      if (estimatedMins > 0) {
        const closeTime = new Date(openedAt.getTime() + estimatedMins * 60000);
        estimatedClose = `${closeTime.getHours().toString().padStart(2, '0')}:${closeTime.getMinutes().toString().padStart(2, '0')}`;
      }

      schedule.push({
        type: 'walk-in',
        title: `Walk-In (${walkIn.bowlers} bowlers)`,
        start: startTime,
        end: estimatedClose,
        current: true,
        color: C.yellow
      });
    }

    // Today's reservations
    reservations.forEach(r => {
      const resDate = r.date || today;
      if (resDate === today && r.lane === selectedLane) {
        const startNum = timeToNum(r.start);
        const endNum = timeToNum(r.end);
        const isCurrent = nn >= startNum && nn < endNum;
        const isPast = nn >= endNum;

        schedule.push({
          type: 'reservation',
          title: r.party,
          start: r.start,
          end: r.end,
          current: isCurrent,
          past: isPast,
          color: C.blue,
          data: r
        });
      }
    });

    // Today's maintenance tasks
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    maintenanceTasks.forEach(task => {
      if ((task.lane === selectedLane || task.lane === null) &&
          task.scheduledFor &&
          task.scheduledFor >= todayStart.getTime() &&
          task.scheduledFor <= todayEnd.getTime()) {
        const taskDate = new Date(task.scheduledFor);
        const startTime = `${taskDate.getHours().toString().padStart(2, '0')}:${taskDate.getMinutes().toString().padStart(2, '0')}`;
        const estimatedEnd = new Date(taskDate.getTime() + (task.estimatedDuration || 0));
        const endTime = `${estimatedEnd.getHours().toString().padStart(2, '0')}:${estimatedEnd.getMinutes().toString().padStart(2, '0')}`;

        schedule.push({
          type: 'maintenance',
          title: task.title,
          start: startTime,
          end: endTime,
          current: false,
          color: C.green,
          data: task
        });
      }
    });

    return schedule.sort((a, b) => timeToNum(a.start) - timeToNum(b.start));
  };

  // Get next 7 days preview
  const getUpcomingWeek = () => {
    const today = new Date();
    const week = [];

    for (let i = 1; i <= 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      const dateStr = formatDateYYYYMMDD(date);

      const dayReservations = reservations.filter(r => {
        const resDate = r.date || formatDateYYYYMMDD(new Date());
        return resDate === dateStr && r.lane === selectedLane;
      });

      const dayTasks = maintenanceTasks.filter(task => {
        if (task.lane !== selectedLane && task.lane !== null) return false;
        if (!task.scheduledFor) return false;
        const taskDate = new Date(task.scheduledFor);
        return formatDateYYYYMMDD(taskDate) === dateStr;
      });

      week.push({
        date: dateStr,
        reservations: dayReservations.length,
        tasks: dayTasks.length
      });
    }

    return week;
  };

  // Identify open windows
  const getOpenWindows = () => {
    const schedule = getTodaySchedule();
    const windows = [];
    const hours = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];

    let currentWindowStart = null;

    hours.forEach(hour => {
      const isOccupied = schedule.some(item => {
        const startNum = timeToNum(item.start);
        const endNum = timeToNum(item.end === 'Unknown' ? '23:59' : item.end);
        return hour >= startNum && hour < endNum;
      });

      if (!isOccupied) {
        if (currentWindowStart === null) {
          currentWindowStart = hour;
        }
      } else {
        if (currentWindowStart !== null) {
          windows.push({
            start: `${currentWindowStart.toString().padStart(2, '0')}:00`,
            end: `${hour.toString().padStart(2, '0')}:00`
          });
          currentWindowStart = null;
        }
      }
    });

    if (currentWindowStart !== null) {
      windows.push({
        start: `${currentWindowStart.toString().padStart(2, '0')}:00`,
        end: '23:59'
      });
    }

    return windows;
  };

  const todaySchedule = getTodaySchedule();
  const upcomingWeek = getUpcomingWeek();
  const openWindows = getOpenWindows();

  const Btn = ({ children, color, onClick, active }) => (
    <button
      onClick={onClick}
      style={{
        fontFamily: F.mono,
        fontSize: compact ? '0.85rem' : '1rem',
        padding: compact ? '14px 18px' : '16px 20px',
        minHeight: compact ? '48px' : '56px',
        border: active ? `2px solid ${color}` : `2px solid ${C.mechBtnBorder}`,
        background: active ? C.mechBtnBgActive : C.mechBtnBg,
        color: active ? color : C.mechTextMuted,
        borderRadius: 8,
        cursor: 'pointer',
        textTransform: 'uppercase',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  );

  return (
    <div>
      {/* Lane Selector */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{
          fontFamily: F.head,
          fontSize: compact ? '1.2rem' : '1.5rem',
          color: C.pink,
          margin: '0 0 12px 0'
        }}>
          Lane Context
        </h2>
        <div style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap'
        }}>
          {[1, 2, 3, 4, 5, 6, 7, 8].map(lane => (
            <Btn
              key={lane}
              color={C.pink}
              active={selectedLane === lane}
              onClick={() => setSelectedLane(lane)}
            >
              Lane {lane}
            </Btn>
          ))}
        </div>
      </div>

      {/* Today's Schedule */}
      <div style={{ marginBottom: 20 }}>
        <h3 style={{
          fontFamily: F.head,
          fontSize: compact ? '1rem' : '1.2rem',
          color: C.text,
          margin: '0 0 12px 0'
        }}>
          Today's Schedule - Lane {selectedLane}
        </h3>

        {todaySchedule.length === 0 ? (
          <div style={{
            padding: compact ? 16 : 20,
            border: `1px solid ${C.dim}`,
            borderRadius: 8,
            background: C.card, boxShadow: C.cardShadow,
            textAlign: 'center',
            color: C.text,
            fontSize: '0.85rem'
          }}>
            No scheduled activities for Lane {selectedLane} today
          </div>
        ) : (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}>
            {todaySchedule.map((item, idx) => (
              <div key={idx} style={{
                padding: compact ? 12 : 14,
                border: `2px solid ${item.current ? item.color : item.color + '55'}`,
                borderRadius: 8,
                background: item.current ? `${item.color}22` : item.past ? `${C.dim}11` : `${item.color}08`,
                opacity: item.past ? 0.5 : 1
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 6
                }}>
                  <div style={{
                    fontFamily: F.head,
                    fontSize: '0.9rem',
                    color: item.color,
                    fontWeight: 700
                  }}>
                    {item.title}
                  </div>
                  {item.current && (
                    <span style={{
                      fontSize: '0.65rem',
                      padding: '2px 8px',
                      background: item.color,
                      color: C.bg,
                      borderRadius: 3,
                      fontFamily: F.mono,
                      fontWeight: 'bold',
                      textTransform: 'uppercase'
                    }}>
                      Current
                    </span>
                  )}
                </div>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '0.75rem',
                  color: C.text
                }}>
                  <div>
                    <span style={{
                      fontSize: '0.65rem',
                      padding: '2px 6px',
                      background: `${item.color}22`,
                      color: item.color,
                      borderRadius: 3,
                      fontFamily: F.mono,
                      textTransform: 'uppercase',
                      marginRight: 8
                    }}>
                      {item.type}
                    </span>
                    {formatTime(item.start)} - {item.end !== 'Unknown' ? formatTime(item.end) : 'Unknown'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Open Windows */}
      {openWindows.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{
            fontFamily: F.head,
            fontSize: compact ? '1rem' : '1.2rem',
            color: C.green,
            margin: '0 0 12px 0'
          }}>
            Open Maintenance Windows
          </h3>

          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fill, minmax(200px, 1fr))',
            gap: 12
          }}>
            {openWindows.map((window, idx) => (
              <div key={idx} style={{
                padding: compact ? 12 : 14,
                border: `2px solid ${C.green}55`,
                borderRadius: 8,
                background: `${C.green}08`
              }}>
                <div style={{
                  fontFamily: F.mono,
                  fontSize: '0.85rem',
                  color: C.green,
                  fontWeight: 700,
                  marginBottom: 4
                }}>
                  {formatTime(window.start)} - {formatTime(window.end)}
                </div>
                <div style={{
                  fontSize: '0.7rem',
                  color: C.text
                }}>
                  Available for maintenance
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Next 7 Days Preview */}
      <div>
        <h3 style={{
          fontFamily: F.head,
          fontSize: compact ? '1rem' : '1.2rem',
          color: C.text,
          margin: '0 0 12px 0'
        }}>
          Next 7 Days
        </h3>

        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 12
        }}>
          {upcomingWeek.map((day, idx) => (
            <div key={idx} style={{
              padding: compact ? 10 : 12,
              border: `1px solid ${C.dim}`,
              borderRadius: 8,
              background: C.card,
              boxShadow: C.cardShadow
            }}>
              <div style={{
                fontFamily: F.head,
                fontSize: '0.75rem',
                color: C.text,
                fontWeight: 700,
                marginBottom: 6
              }}>
                {formatDate(day.date)}
              </div>
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                fontSize: '0.7rem'
              }}>
                <div style={{ color: C.blue }}>
                  {day.reservations} reservation{day.reservations !== 1 ? 's' : ''}
                </div>
                <div style={{ color: C.green }}>
                  {day.tasks} task{day.tasks !== 1 ? 's' : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Schedule Maintenance Button */}
      <div style={{
        marginTop: 20,
        padding: compact ? 16 : 20,
        border: `2px dashed ${C.green}`,
        borderRadius: 8,
        background: `${C.green}05`,
        textAlign: 'center'
      }}>
        <p style={{
          fontFamily: F.mono,
          fontSize: '0.75rem',
          color: C.text,
          marginBottom: 12
        }}>
          Ready to schedule maintenance for Lane {selectedLane}?
        </p>
        <Btn color={C.green} onClick={() => alert('Maintenance scheduling coming soon!')}>
          Schedule Maintenance
        </Btn>
      </div>
    </div>
  );
}
