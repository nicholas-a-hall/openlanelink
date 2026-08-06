import { useState, useEffect } from 'react';
import { F, useCompact } from '../../shared';
import { useColors } from '../../theme';

export default function ServiceLogView() {
  const C = useColors();
  const compact = useCompact();
  const [serviceHistory, setServiceHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [filters, setFilters] = useState({
    dateRange: 'today',
    lane: 'all',
    category: 'all'
  });
  const [customDateStart, setCustomDateStart] = useState('');
  const [customDateEnd, setCustomDateEnd] = useState('');
  const [page, setPage] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [categories, setCategories] = useState([]);
  const pageSize = 20;

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        setCategories((data.serviceCategories || []).map(label => ({
          id: label.toLowerCase().replace(/\s+/g, '-'),
          label
        })));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchServiceHistory();
  }, [filters, page]);

  const fetchServiceHistory = async () => {
    const now = Date.now();
    let startTime, endTime;

    switch (filters.dateRange) {
      case 'today':
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        startTime = todayStart.getTime();
        endTime = now;
        break;
      case 'week':
        startTime = now - (7 * 24 * 60 * 60 * 1000);
        endTime = now;
        break;
      case 'month':
        startTime = now - (30 * 24 * 60 * 60 * 1000);
        endTime = now;
        break;
      case 'custom':
        if (customDateStart) {
          startTime = new Date(customDateStart).getTime();
        }
        if (customDateEnd) {
          endTime = new Date(customDateEnd).getTime();
        }
        break;
      default:
        startTime = 0;
        endTime = now;
    }

    const params = new URLSearchParams({
      limit: pageSize,
      offset: page * pageSize
    });

    if (startTime) params.append('startTime', startTime);
    if (endTime) params.append('endTime', endTime);
    if (filters.lane !== 'all') params.append('lane', filters.lane);
    if (filters.category !== 'all') params.append('category', filters.category);

    setLoading(true);
    try {
      const response = await fetch(`/api/service-history?${params}`);
      const data = await response.json();
      setServiceHistory(data.history || []);
      setTotalCount(data.count || 0);
    } catch (error) {
      console.error('[ServiceLog] Error fetching service history:', error);
      setServiceHistory([]);
    } finally {
      setLoading(false);
    }
  };

  const clearServiceHistory = async () => {
    try {
      await fetch('/api/service-history', { method: 'DELETE' });
      setServiceHistory([]);
      setTotalCount(0);
      setPage(0);
      setConfirmClear(false);
    } catch (error) {
      console.error('[ServiceLog] Error clearing service history:', error);
    }
  };

  const formatDuration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  };

  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const getCategoryColor = () => C.mechTextMuted;

  const getSeverityColor = (severity) => {
    switch (severity) {
      case 'low': return C.green;
      case 'medium': return C.yellow;
      case 'high': return C.red;
      default: return C.text;
    }
  };

  const Btn = ({ children, color, onClick, active, disabled }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: F.mono,
        fontSize: compact ? '0.85rem' : '1rem',
        padding: compact ? '14px 18px' : '16px 20px',
        minHeight: compact ? '48px' : '56px',
        border: active ? `2px solid ${color}` : `2px solid ${disabled ? C.mechBtnBorderDim : C.mechBtnBorder}`,
        background: active ? C.mechBtnBgActive : disabled ? C.mechBtnBgDisabled : C.mechBtnBg,
        color: disabled ? C.mechTextDim : active ? color : C.mechTextMuted,
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
      {/* Filters */}
      <div style={{
        padding: compact ? 12 : 16,
        border: `1px solid ${C.dim}`,
        borderRadius: 8,
        background: C.card, boxShadow: C.cardShadow,
        marginBottom: 16
      }}>
        <h3 style={{
          fontFamily: F.head,
          fontSize: compact ? '1rem' : '1.2rem',
          color: C.blue,
          margin: '0 0 12px 0'
        }}>
          Filters
        </h3>

        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12
        }}>
          {/* Date Range */}
          <div>
            <label style={{
              display: 'block',
              fontSize: '0.7rem',
              color: C.text,
              marginBottom: 6
            }}>
              Date Range
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {['today', 'week', 'month', 'custom'].map(range => (
                <Btn
                  key={range}
                  color={C.blue}
                  active={filters.dateRange === range}
                  onClick={() => setFilters({ ...filters, dateRange: range })}
                >
                  {range.charAt(0).toUpperCase() + range.slice(1)}
                </Btn>
              ))}
            </div>
          </div>

          {/* Lane Filter */}
          <div>
            <label style={{
              display: 'block',
              fontSize: '0.7rem',
              color: C.text,
              marginBottom: 6
            }}>
              Lane
            </label>
            <select
              value={filters.lane}
              onChange={(e) => setFilters({ ...filters, lane: e.target.value })}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontFamily: F.mono,
                fontSize: '0.75rem',
                background: C.card,
                border: `1px solid ${C.dim}`,
                borderRadius: 5,
                color: C.text,
                cursor: 'pointer'
              }}
            >
              <option value="all">All Lanes</option>
              {[1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                <option key={n} value={n}>Lane {n}</option>
              ))}
            </select>
          </div>

          {/* Category Filter */}
          <div>
            <label style={{
              display: 'block',
              fontSize: '0.7rem',
              color: C.text,
              marginBottom: 6
            }}>
              Category
            </label>
            <select
              value={filters.category}
              onChange={(e) => setFilters({ ...filters, category: e.target.value })}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontFamily: F.mono,
                fontSize: '0.75rem',
                background: C.card,
                border: `1px solid ${C.dim}`,
                borderRadius: 5,
                color: C.text,
                cursor: 'pointer'
              }}
            >
              <option value="all">All Categories</option>
              {categories.map(cat => (
                <option key={cat.id} value={cat.id}>{cat.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Custom Date Range */}
        {filters.dateRange === 'custom' && (
          <div style={{
            marginTop: 12,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap'
          }}>
            <div>
              <label style={{ fontSize: '0.7rem', color: C.text, marginRight: 6 }}>
                Start:
              </label>
              <input
                type="date"
                value={customDateStart}
                onChange={(e) => setCustomDateStart(e.target.value)}
                style={{
                  padding: '6px 10px',
                  fontFamily: F.mono,
                  fontSize: '0.75rem',
                  background: C.card,
                  border: `1px solid ${C.dim}`,
                  borderRadius: 5,
                  color: C.text
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: '0.7rem', color: C.text, marginRight: 6 }}>
                End:
              </label>
              <input
                type="date"
                value={customDateEnd}
                onChange={(e) => setCustomDateEnd(e.target.value)}
                style={{
                  padding: '6px 10px',
                  fontFamily: F.mono,
                  fontSize: '0.75rem',
                  background: C.card,
                  border: `1px solid ${C.dim}`,
                  borderRadius: 5,
                  color: C.text
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Service History List */}
      <div>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12
        }}>
          <h3 style={{
            fontFamily: F.head,
            fontSize: compact ? '1rem' : '1.2rem',
            color: C.mechText,
            margin: 0
          }}>
            Service History ({serviceHistory.length} of {totalCount})
          </h3>
          <div style={{ display: 'flex', gap: 8 }}>
            {confirmClear ? (
              <>
                <span style={{
                  fontFamily: F.mono,
                  fontSize: '0.75rem',
                  color: C.mechTextMuted,
                  display: 'flex',
                  alignItems: 'center'
                }}>
                  Clear all logs?
                </span>
                <Btn color={C.mechText} onClick={clearServiceHistory}>
                  Yes
                </Btn>
                <Btn color={C.mechTextDim} onClick={() => setConfirmClear(false)}>
                  No
                </Btn>
              </>
            ) : (
              <Btn
                color={C.mechTextDim}
                onClick={() => setConfirmClear(true)}
                disabled={loading || totalCount === 0}
              >
                Clear
              </Btn>
            )}
            <Btn
              color={C.mechText}
              onClick={fetchServiceHistory}
              disabled={loading}
            >
              {loading ? 'Loading...' : '↻ Refresh'}
            </Btn>
          </div>
        </div>

        {loading ? (
          <div style={{
            padding: compact ? 16 : 24,
            border: `1px solid ${C.mechBtnBorder}`,
            borderRadius: 8,
            background: C.mechBtnBg,
            textAlign: 'center',
            color: C.mechTextMuted,
            fontSize: '0.85rem'
          }}>
            Loading service history...
          </div>
        ) : serviceHistory.length === 0 ? (
          <div style={{
            padding: compact ? 16 : 24,
            border: `1px solid ${C.dim}`,
            borderRadius: 8,
            background: C.card, boxShadow: C.cardShadow,
            textAlign: 'center',
            color: C.text,
            fontSize: '0.85rem'
          }}>
            No service history found for selected filters
          </div>
        ) : (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fill, minmax(350px, 1fr))',
              gap: 12
            }}>
              {serviceHistory.map((entry, idx) => (
                <div key={entry.id || idx} style={{
                  padding: compact ? 12 : 14,
                  border: `1px solid ${getCategoryColor(entry.issue?.category)}55`,
                  borderRadius: 8,
                  background: `${getCategoryColor(entry.issue?.category)}08`
                }}>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginBottom: 8
                  }}>
                    <div style={{
                      fontFamily: F.head,
                      fontSize: '0.9rem',
                      color: getCategoryColor(entry.issue?.category),
                      fontWeight: 700
                    }}>
                      Lane {entry.lane}
                    </div>
                    <div style={{
                      fontSize: '0.7rem',
                      color: C.text
                    }}>
                      {formatTimestamp(entry.startTime)}
                    </div>
                  </div>

                  <div style={{
                    display: 'flex',
                    gap: 6,
                    marginBottom: 8,
                    flexWrap: 'wrap'
                  }}>
                    <span style={{
                      fontSize: '0.65rem',
                      padding: '2px 6px',
                      background: `${getCategoryColor(entry.issue?.category)}22`,
                      color: getCategoryColor(entry.issue?.category),
                      borderRadius: 3,
                      fontFamily: F.mono,
                      textTransform: 'uppercase'
                    }}>
                      {entry.issue?.category || 'unknown'}
                    </span>
                    <span style={{
                      fontSize: '0.65rem',
                      padding: '2px 6px',
                      background: `${getSeverityColor(entry.issue?.severity)}22`,
                      color: getSeverityColor(entry.issue?.severity),
                      borderRadius: 3,
                      fontFamily: F.mono,
                      textTransform: 'uppercase'
                    }}>
                      {entry.issue?.severity || 'medium'}
                    </span>
                    <span style={{
                      fontSize: '0.65rem',
                      padding: '2px 6px',
                      background: `${C.text}22`,
                      color: C.text,
                      borderRadius: 3,
                      fontFamily: F.mono
                    }}>
                      {formatDuration(entry.duration)}
                    </span>
                  </div>

                  {entry.issue?.description && (
                    <div style={{
                      fontSize: '0.75rem',
                      color: C.text,
                      marginBottom: 6,
                      fontStyle: 'italic'
                    }}>
                      {entry.issue.description}
                    </div>
                  )}

                  <div style={{
                    fontSize: '0.7rem',
                    color: C.dim,
                    marginBottom: 4
                  }}>
                    Resolved by: {entry.issue?.resolvedBy || 'Unknown'}
                  </div>

                  {entry.componentsUsed && entry.componentsUsed.length > 0 && (
                    <div style={{
                      fontSize: '0.7rem',
                      color: C.purple,
                      marginTop: 6,
                      paddingTop: 6,
                      borderTop: `1px solid ${C.dim}`
                    }}>
                      Parts: {entry.componentsUsed.map(c => `${c.component} (${c.quantity})`).join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Pagination */}
            <div style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 10,
              marginTop: 16
            }}>
              <Btn
                color={C.blue}
                onClick={() => setPage(Math.max(0, page - 1))}
                disabled={page === 0}
              >
                Previous
              </Btn>
              <div style={{
                fontFamily: F.mono,
                fontSize: '0.75rem',
                color: C.text,
                padding: '8px 12px',
                display: 'flex',
                alignItems: 'center'
              }}>
                Page {page + 1}
              </div>
              <Btn
                color={C.blue}
                onClick={() => setPage(page + 1)}
                disabled={serviceHistory.length < pageSize}
              >
                Next
              </Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
