import { useState, useEffect } from 'react';
import { F, useCompact } from '../../shared';
import { useColors } from '../../theme';
import QuickIssueLogger from './QuickIssueLogger';

export default function ServiceCallDashboard({
  serviceCalls,
  reservations,
  walkIns,
  components,
  dispatch
}) {
  const compact = useCompact();
  const C = useColors();
  const [now, setNow] = useState(Date.now());
  const [resolvingLane, setResolvingLane] = useState(null);

  // Update current time every second for elapsed time display
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const formatElapsed = (startTime) => {
    const elapsed = now - startTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  };

  const formatDuration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) {
      return `${minutes}min`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  const timeToNum = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h + m / 60;
  };

  const nowNum = () => {
    const n = new Date();
    return n.getHours() + n.getMinutes() / 60;
  };

  // Get upcoming reservations (next 2-4 hours)
  const getUpcomingReservations = () => {
    const nn = nowNum();
    const today = new Date().toISOString().split('T')[0];
    const upcoming = reservations
      .filter(r => {
        const resDate = r.date || today;
        if (resDate !== today) return false;
        const startNum = timeToNum(r.start);
        return startNum > nn && startNum <= nn + 4;
      })
      .sort((a, b) => timeToNum(a.start) - timeToNum(b.start))
      .slice(0, 5);
    return upcoming;
  };

  // Get occupied lanes (walk-ins or current reservations)
  const getOccupiedLanes = () => {
    const nn = nowNum();
    const today = new Date().toISOString().split('T')[0];
    const occupied = [];

    // Walk-ins
    walkIns.forEach(w => {
      let estimatedClose = 'Unknown';
      if (w.type === 'hourly' && w.hours) {
        const openedAt = new Date(w.openedAt);
        const closeTime = new Date(openedAt.getTime() + w.hours * 60 * 60 * 1000);
        const hours = closeTime.getHours();
        const mins = closeTime.getMinutes();
        estimatedClose = `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
      } else if (w.type === 'per-game' && w.games) {
        estimatedClose = `~${w.games * 10}min`;
      }

      occupied.push({
        lane: w.lane,
        type: 'Walk-In',
        party: `${w.bowlers} bowlers`,
        estimatedClose,
        color: C.yellow
      });
    });

    // Current reservations
    reservations.forEach(r => {
      const resDate = r.date || today;
      if (resDate === today) {
        const startNum = timeToNum(r.start);
        const endNum = timeToNum(r.end);
        if (nn >= startNum && nn < endNum) {
          occupied.push({
            lane: r.lane,
            type: 'Reservation',
            party: r.party,
            estimatedClose: r.end,
            color: C.blue
          });
        }
      }
    });

    return occupied.sort((a, b) => a.lane - b.lane);
  };

  // Get low stock alerts
  const getLowStockAlerts = () => {
    return components.filter(comp => comp.quantity <= comp.minStock);
  };

  const activeServiceCalls = Object.entries(serviceCalls);
  const upcomingRes = getUpcomingReservations();
  const occupied = getOccupiedLanes();
  const lowStockAlerts = getLowStockAlerts();

  const Btn = ({ children, color, onClick, disabled }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: F.mono,
        fontSize: compact ? '0.85rem' : '1rem',
        padding: compact ? '14px 18px' : '16px 20px',
        minHeight: compact ? '48px' : '56px',
        border: `2px solid ${disabled ? C.mechBtnBorderDim : C.mechBtnBorderBright}`,
        background: disabled ? C.mechBtnBgDisabled : C.mechBtnBgMed,
        color: disabled ? C.mechTextDim : C.mechText,
        borderRadius: 8,
        cursor: disabled ? 'default' : 'pointer',
        textTransform: 'uppercase',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  );

  return (
    <div>
      {/* Active Service Calls */}
      <div style={{ marginBottom: compact ? 20 : 24 }}>
        <h2 style={{
          fontFamily: F.head,
          fontSize: compact ? '1.2rem' : '1.5rem',
          color: C.mechText,
          margin: '0 0 12px 0'
        }}>
          Active Service Calls ({activeServiceCalls.length})
        </h2>

        {activeServiceCalls.length === 0 ? (
          <div style={{
            padding: compact ? 16 : 20,
            border: `1px solid ${C.dim}`,
            borderRadius: 8,
            background: C.card, boxShadow: C.cardShadow,
            textAlign: 'center',
            color: C.text,
            fontSize: '0.85rem'
          }}>
            No active service calls
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 12
          }}>
            {activeServiceCalls.map(([lane, call]) => (
              <div key={lane} style={{
                padding: compact ? 16 : 20,
                border: `2px solid ${call.acked ? C.mechBtnBorder : C.mechBtnBorderBright}`,
                borderRadius: 8,
                background: call.acked ? C.mechBtnBg : C.mechBtnBgMed,
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: 12
                }}>
                  <div style={{
                    fontFamily: F.head,
                    fontSize: compact ? '1.2rem' : '1.5rem',
                    color: call.acked ? C.mechTextMuted : C.mechText,
                    fontWeight: 700
                  }}>
                    LANE {lane}
                  </div>
                  <div style={{
                    fontFamily: F.mono,
                    fontSize: compact ? '1rem' : '1.2rem',
                    color: call.acked ? C.mechTextMuted : C.mechText,
                    fontWeight: 700
                  }}>
                    {formatElapsed(call.start)}
                  </div>
                </div>

                <div style={{
                  fontSize: '0.9rem',
                  color: C.mechTextMuted,
                  marginBottom: 12
                }}>
                  Origin: {call.origin || 'unknown'}
                  {call.acked && ' \u2022 Acknowledged'}
                </div>

                <div style={{
                  display: 'flex',
                  gap: 8,
                  flexWrap: 'wrap'
                }}>
                  {!call.acked && (
                    <Btn
                      color={C.yellow}
                      onClick={() => dispatch('ACKNOWLEDGE_SERVICE_CALL', { lane: parseInt(lane) })}
                    >
                      Acknowledge
                    </Btn>
                  )}
                  <Btn
                    color={C.green}
                    onClick={() => setResolvingLane(parseInt(lane))}
                  >
                    Resolve
                  </Btn>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Stats Row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 12,
        marginBottom: compact ? 20 : 24
      }}>
        {/* Low Stock Alerts */}
        <div style={{
          padding: compact ? 12 : 16,
          border: `1px solid ${lowStockAlerts.length > 0 ? C.orange : C.dim}`,
          borderRadius: 8,
          background: lowStockAlerts.length > 0 ? `${C.orange}11` : C.card,
          boxShadow: C.cardShadow
        }}>
          <div style={{
            fontFamily: F.mono,
            fontSize: '0.7rem',
            color: C.text,
            marginBottom: 4
          }}>
            LOW STOCK ALERTS
          </div>
          <div style={{
            fontFamily: F.head,
            fontSize: compact ? '1.5rem' : '2rem',
            color: lowStockAlerts.length > 0 ? C.orange : C.green,
            fontWeight: 700
          }}>
            {lowStockAlerts.length}
          </div>
          {lowStockAlerts.length > 0 && (
            <div style={{ fontSize: '0.65rem', color: C.text, marginTop: 4 }}>
              {lowStockAlerts.slice(0, 2).map(item => (
                <div key={item._id}>{item.name}</div>
              ))}
            </div>
          )}
        </div>

        {/* Occupied Lanes */}
        <div style={{
          padding: compact ? 12 : 16,
          border: `1px solid ${C.dim}`,
          borderRadius: 8,
          background: C.card,
          boxShadow: C.cardShadow
        }}>
          <div style={{
            fontFamily: F.mono,
            fontSize: '0.7rem',
            color: C.text,
            marginBottom: 4
          }}>
            OCCUPIED LANES
          </div>
          <div style={{
            fontFamily: F.head,
            fontSize: compact ? '1.5rem' : '2rem',
            color: C.text,
            fontWeight: 700
          }}>
            {occupied.length}/8
          </div>
        </div>
      </div>

      {/* Upcoming Reservations */}
      <div style={{ marginBottom: compact ? 20 : 24 }}>
        <h2 style={{
          fontFamily: F.head,
          fontSize: compact ? '1.2rem' : '1.5rem',
          color: C.blue,
          margin: '0 0 12px 0'
        }}>
          Upcoming Reservations (Next 4 Hours)
        </h2>

        {upcomingRes.length === 0 ? (
          <div style={{
            padding: compact ? 16 : 20,
            border: `1px solid ${C.dim}`,
            borderRadius: 8,
            background: C.card, boxShadow: C.cardShadow,
            textAlign: 'center',
            color: C.text,
            fontSize: '0.85rem'
          }}>
            No upcoming reservations in the next 4 hours
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fill, minmax(250px, 1fr))',
            gap: 12
          }}>
            {upcomingRes.map((r, idx) => (
              <div key={idx} style={{
                padding: compact ? 12 : 14,
                border: `1px solid ${C.blue}55`,
                borderRadius: 8,
                background: `${C.blue}08`
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 6
                }}>
                  <div style={{
                    fontFamily: F.head,
                    fontSize: '0.9rem',
                    color: C.blue,
                    fontWeight: 700
                  }}>
                    Lane {r.lane}
                  </div>
                  <div style={{
                    fontFamily: F.mono,
                    fontSize: '0.75rem',
                    color: C.text
                  }}>
                    {r.start}
                  </div>
                </div>
                <div style={{
                  fontSize: '0.75rem',
                  color: C.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }} title={r.party}>
                  {r.party}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Occupied Lanes Detail */}
      {occupied.length > 0 && (
        <div>
          <h2 style={{
            fontFamily: F.head,
            fontSize: compact ? '1.2rem' : '1.5rem',
            color: C.text,
            margin: '0 0 12px 0'
          }}>
            Currently Occupied
          </h2>

          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fill, minmax(250px, 1fr))',
            gap: 12
          }}>
            {occupied.map((occ, idx) => (
              <div key={idx} style={{
                padding: compact ? 12 : 14,
                border: `1px solid ${occ.color}55`,
                borderRadius: 8,
                background: `${occ.color}08`
              }}>
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginBottom: 6
                }}>
                  <div style={{
                    fontFamily: F.head,
                    fontSize: '0.9rem',
                    color: occ.color,
                    fontWeight: 700
                  }}>
                    Lane {occ.lane}
                  </div>
                  <div style={{
                    fontFamily: F.mono,
                    fontSize: '0.7rem',
                    color: C.text,
                    background: `${occ.color}22`,
                    padding: '2px 6px',
                    borderRadius: 3
                  }}>
                    {occ.type}
                  </div>
                </div>
                <div style={{
                  fontSize: '0.75rem',
                  color: C.text,
                  marginBottom: 4
                }}>
                  {occ.party}
                </div>
                <div style={{
                  fontSize: '0.7rem',
                  color: C.dim
                }}>
                  Est. Close: {occ.estimatedClose}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick Issue Logger Modal */}
      {resolvingLane !== null && (
        <QuickIssueLogger
          lane={resolvingLane}
          components={components}
          onClose={() => setResolvingLane(null)}
          onSubmit={(data) => {
            dispatch('RESOLVE_SERVICE_CALL', {
              lane: resolvingLane,
              ...data
            });
            setResolvingLane(null);
          }}
        />
      )}
    </div>
  );
}
