import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Wrench, Trash2, ArrowRightLeft, Wifi, WifiOff, Plus, ChevronLeft } from 'lucide-react';
import { F, LANES, useSocket, useCompact, getWeekStart, formatDateYYYYMMDD, isToday, addDays, formatDateDisplay } from './shared';
import { useColors, useTheme, raised, inset } from './theme';
import ReservationForm from './components/ReservationForm';

// ── Anim ────────────────────────────────────────────────
function AnimExpand({ open, children }) {
  const contentRef = useRef(null);
  const [height, setHeight] = useState(0);
  const prevOpen = useRef(open);
  const animRef = useRef(false);
  const timerRef = useRef(null);
  const [, bump] = useState(0);

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const ro = new ResizeObserver(() => {
      setHeight(contentRef.current.scrollHeight);
    });
    ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, []);

  if (prevOpen.current !== open) {
    prevOpen.current = open;
    animRef.current = true;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { animRef.current = false; bump(n => n + 1); }, 300);
  }

  const animating = animRef.current;

  return (
    <div style={{
      maxHeight: animating ? (open ? height + 28 : 0) : (open ? 'none' : 0),
      opacity: open ? 1 : 0, overflow: animating ? 'hidden' : (open ? 'visible' : 'hidden'),
      transition: animating
        ? 'max-height 0.3s cubic-bezier(0.4,0,0.2,1), opacity 0.25s ease'
        : 'none',
    }}>
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

// ── Main ────────────────────────────────────────────────
export default function OpenLaneSchedulerDisplay() {
  const { connected, state: S, dispatch, lastError, lastReservation, clearError, clearReservation } = useSocket();
  const compact = useCompact();
  const C = useColors();
  const { isDark, toggleTheme } = useTheme();
  const [now, setNow] = useState(new Date());
  const [view, setView] = useState('lanes');
  const [editLane, setEditLane] = useState(null);
  const [openLane, setOpenLane] = useState(null);
  const [movingLane, setMovingLane] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [form, setForm] = useState({ bowlers:2, type:'per-game', games:1, hours:1, groupLanes:[] });
  const [reservationError, setReservationError] = useState(null);
  const [timelineViewMode, setTimelineViewMode] = useState('hour');
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedWeekStart, setSelectedWeekStart] = useState(getWeekStart(new Date()));
  const [selectedMonth, setSelectedMonth] = useState(new Date());
  const [selectedReservation, setSelectedReservation] = useState(null);

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 10000); return () => clearInterval(t); }, []);

  // Derive from server state
  const res = S?.reservations || [];
  const walks = S?.walkIns || [];
  const maint = S?.maintenance || {};
  const groups = S?.groups || {};
  const serviceCalls = S?.serviceCalls || {};

  // Keep selectedReservation in sync with latest data
  useEffect(() => {
    if (selectedReservation && res.length > 0) {
      const todayStr = new Date().toISOString().split('T')[0];
      const updated = res.find(r =>
        r.lane === selectedReservation.lane &&
        r.start === selectedReservation.start &&
        (r.date || todayStr) === (selectedReservation.date || todayStr)
      );
      if (updated && JSON.stringify(updated) !== JSON.stringify(selectedReservation)) {
        // Update the reference to keep data fresh
        setSelectedReservation(updated);
      }
    }
  }, [res]); // Only depend on res to avoid infinite loop

  // Helpers
  const tn = t => { const [h, m] = t.split(':').map(Number); return h + m / 60; };
  const nn = now.getHours() + now.getMinutes() / 60;
  const todayStr = now.toISOString().split('T')[0];
  const isToday = r => (r.date || todayStr) === todayStr;
  const curRes = l => res.find(r => r.lane === l && isToday(r) && nn >= tn(r.start) && nn < tn(r.end));
  const getWalk = l => walks.find(w => w.lane === l);
  const upcoming = l => res.filter(r => r.lane === l && isToday(r) && tn(r.start) > nn).sort((a, b) => tn(a.start) - tn(b.start))[0];
  const upcomingHour = l => res.filter(r => r.lane === l && isToday(r) && tn(r.start) > nn && (tn(r.start) - nn) <= 1).sort((a, b) => tn(a.start) - tn(b.start));
  const soonRes = l => { const u = upcoming(l); return u && (tn(u.start) - nn) <= 0.25 ? u : null; };
  const fmt = t => { const [h, m] = t.split(':'); const hr = parseInt(h); return `${hr > 12 ? hr - 12 : hr || 12}:${m}${hr >= 12 ? 'p' : 'a'}`; };
  const walkHM = ts => { const d = new Date(ts); return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`; };
  const elapsed = ts => { const mins = Math.floor((Date.now() - ts) / 60000); return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`; };
  const serviceCallMins = w => { let ms = w.serviceCallMs || 0; const bc = serviceCalls[w.lane]; if (bc) ms += Date.now() - bc.start; return ms / 60000; };
  const estClose = (openedAt, mins, bcMins) => { const hm = walkHM(openedAt); const [h, m] = hm.split(':').map(Number); const cm2 = h * 60 + m + Math.round(mins) + Math.round(bcMins || 0); const ch = Math.floor(cm2 / 60) % 24, cmm = cm2 % 60; return fmt(`${ch.toString().padStart(2, '0')}:${cmm.toString().padStart(2, '0')}`); };
  const walkMins = w => {
    const baseMins = w.type === 'hourly' ? (w.hours || 1) * 60 : ((w.bowlers || 1) * (w.games || 1) * 10 + 15);
    return baseMins + 5; // 5 minute grace period
  };
  const isLaneOpen = l => !maint[l] && !curRes(l) && !getWalk(l) && !soonRes(l);

  const getGroupForLane = l => { for (const [gid, g] of Object.entries(groups)) { if (g.lanes.includes(l)) return { gid, ...g }; } return null; };
  const getMovingGroup = () => {
    if (!movingLane) return null;
    const g = getGroupForLane(movingLane);
    return g ? g.lanes.sort((a, b) => a - b) : [movingLane];
  };
  const canMoveHere = (targetLane) => {
    const grpLanes = getMovingGroup();
    if (!grpLanes) return false;
    for (let i = 0; i < grpLanes.length; i++) {
      const l = targetLane + i;
      if (l > 8) return false;
      if (grpLanes.includes(l)) continue;
      if (!isLaneOpen(l) || maint[l]) return false;
    }
    return true;
  };

  const maintCount = LANES.filter(l => maint[l]).length;
  const availCount = LANES.filter(l => !maint[l] && !curRes(l) && !getWalk(l)).length;
  const activeCount = LANES.filter(l => !maint[l] && (curRes(l) || getWalk(l))).length;
  const unpaidCount = LANES.filter(l => { const r = curRes(l), w = getWalk(l); return (r && !r.paid) || (w && !w.paid); }).length;
  const serviceCallCount = LANES.filter(l => serviceCalls[l]).length;

  // ── Handlers ───────────────────────────────────────────
  const handleCreateReservation = (reservationData) => {
    setReservationError(null);
    clearError();
    dispatch('CREATE_RESERVATION', reservationData);
  };

  // Handle socket error events
  useEffect(() => {
    if (lastError) {
      // Format error message for display
      let errorMessage;
      if (lastError.message) {
        errorMessage = lastError.message;
      } else if (lastError.errors && Array.isArray(lastError.errors)) {
        errorMessage = lastError.errors.join(', ');
      } else {
        errorMessage = 'An error occurred while creating the reservation';
      }

      setReservationError({
        type: lastError.type || 'error',
        message: errorMessage
      });
      clearError();
    }
  }, [lastError, clearError]);

  // Handle reservation creation success
  useEffect(() => {
    if (lastReservation && lastReservation.success) {
      setView('lanes'); // Return to lanes view
      setReservationError(null);
      clearReservation();
    }
  }, [lastReservation, clearReservation]);

  // ── Components ────────────────────────────────────────
  const Btn = ({ children, color, onClick, active, w: minW, disabled }) => (
    <button onClick={e => { e.stopPropagation(); if (!disabled) onClick?.(); }} disabled={disabled} style={{
      fontFamily: F.mono, fontSize: compact ? '0.65rem' : '0.72rem', letterSpacing:'0.06em', padding: compact ? '8px 10px' : '10px 14px', minHeight: compact ? 40 : 48, minWidth: minW || (compact ? 40 : 48),
      ...(disabled
        ? { ...raised(C, { radius: 6, distance: 2 }), opacity: 0.5 }
        : active
          ? inset(C, { radius: 6, distance: 2, accent: color })
          : raised(C, { radius: 6, distance: 3 })),
      color: disabled ? C.dim : color, cursor: disabled ? 'default' : 'pointer', textTransform:'uppercase',
      transition:'box-shadow 0.15s, color 0.15s', whiteSpace: compact ? 'normal' : 'nowrap',
      display:'flex', alignItems:'center', justifyContent:'center', gap:5, overflowWrap: compact ? 'break-word' : 'normal',
    }}>{children}</button>
  );

  const Stepper = ({ value, onChange, min = 1, max = 20, color, label }) => (
    <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap: compact ? 'nowrap' : 'nowrap', flexShrink: 0 }}>
      <span style={{ fontFamily: F.mono, fontSize:'0.6rem', color: C.text, letterSpacing:'0.1em', minWidth: compact ? 45 : 55, whiteSpace:'nowrap' }}>{label}</span>
      <button onClick={e => { e.stopPropagation(); onChange(Math.max(min, value - 1)); }} style={{ ...raised(C, { radius: 6, distance: 3 }), width: compact ? 36 : 44, height: compact ? 36 : 44, color, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'monospace', fontSize:18, padding:0, flexShrink:0 }}>−</button>
      <span style={{ ...inset(C, { radius: 6, distance: 2 }), fontFamily: F.head, fontSize:'1rem', fontWeight:700, color, minWidth: compact ? 32 : 40, height: compact ? 36 : 44, display:'flex', alignItems:'center', justifyContent:'center', textAlign:'center', flexShrink:0 }}>{value}</span>
      <button onClick={e => { e.stopPropagation(); onChange(Math.min(max, value + 1)); }} style={{ ...raised(C, { radius: 6, distance: 3 }), width: compact ? 36 : 44, height: compact ? 36 : 44, color, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'monospace', fontSize:18, padding:0, flexShrink:0 }}>+</button>
    </div>
  );

  const Tag = ({ children, color }) => (<span style={{ fontFamily: F.mono, fontSize:'0.65rem', letterSpacing:'0.1em', color, padding:'4px 10px', borderRadius:4, background: `${color}15`, fontWeight:700, display:'inline-block', maxWidth: compact ? '200px' : '250px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={typeof children === 'string' ? children : String(children)}>{children}</span>);
  const Info = ({ label, value, color = C.text }) => (<div style={{ marginRight: compact ? 8 : 20, marginBottom: compact ? 4 : 0, maxWidth: compact ? '150px' : '200px', minWidth:0 }}><div style={{ fontFamily: F.mono, fontSize:'0.5rem', color: C.text, letterSpacing:'0.12em', marginBottom:2, opacity:0.7, whiteSpace:'nowrap' }}>{label}</div><div style={{ fontFamily: F.head, fontSize: compact ? '0.72rem' : '0.8rem', color, fontWeight:700, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', lineHeight: compact ? 1.3 : 1 }} title={typeof value === 'string' ? value : String(value)}>{value}</div></div>);
  const ConfirmInline = ({ text, onYes, onNo }) => (<div style={{ display:'flex', gap:6, alignItems:'center', flexWrap:'wrap', justifyContent:'flex-end' }}><span style={{ fontFamily: F.mono, fontSize:'0.65rem', color: C.pink, overflowWrap:'anywhere' }}>{text}</span><Btn color={C.pink} onClick={onYes}>Yes</Btn><Btn color={C.dim} onClick={onNo}>No</Btn></div>);

  // ── Lane Row ──────────────────────────────────────────
  const LaneRow = ({ num }) => {
    const im = maint[num];
    const r = !im ? curRes(num) : null;
    const w = !im ? getWalk(num) : null;
    const up = !im ? upcoming(num) : null;
    const soon = !im ? soonRes(num) : null;
    const upWithinHour = !im ? upcomingHour(num)[0] : null;
    const active = !!(r || w);
    const paid = w ? w.paid : r ? r.paid : true;
    const isEdit = editLane === num;
    const isOpen = openLane === num;
    const isConf = confirm?.lane === num;
    const grp = getGroupForLane(num);
    const hasBallCall = !!serviceCalls[num];
    const serviceCallAcked = hasBallCall && serviceCalls[num].acked;
    const movingGrp = getMovingGroup();
    const isPartOfMovingGroup = movingGrp && movingGrp.includes(num);
    const isMoveTarget = movingLane !== null && !isPartOfMovingGroup && canMoveHere(num);

    let accent = C.blue, status = 'OPEN';
    if (im) { accent = C.maint; status = 'MAINTENANCE'; }
    else if (active && paid) { accent = C.green; status = 'ACTIVE'; }
    else if (active && !paid) { accent = C.red; status = 'UNPAID'; }
    else if (r && !w && !r.arrived) { accent = C.yellow; status = 'PENDING ARRIVAL'; }

    // Override accent for service calls
    if (hasBallCall) {
      accent = serviceCallAcked ? C.serviceAck : C.amber;
    }

    return (
      <div className={hasBallCall && !serviceCallAcked ? 'service-call-pulse' : undefined} style={{
        ...(im
          ? inset(C, { radius: 8, distance: 3 })
          : raised(C, { radius: 8, distance: 5, accent: hasBallCall ? (serviceCallAcked ? C.serviceAck : C.amber) : (isEdit || isOpen) ? accent : isMoveTarget ? C.yellow : null })),
        padding: compact ? '10px 14px' : '14px 20px', opacity: im ? 0.6 : 1,
        transition:'box-shadow 0.2s, opacity 0.2s', position:'relative', overflowX:'auto', overflowY:'visible',
      }}>
        {hasBallCall && (<div style={{ position:'absolute', inset:0, pointerEvents:'none', zIndex:1,
          backgroundImage: serviceCallAcked
            ? 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(var(--ll-serviceAck-rgb),0.06) 2px, rgba(var(--ll-serviceAck-rgb),0.06) 4px)'
            : 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(var(--ll-amber-rgb),0.08) 2px, rgba(var(--ll-amber-rgb),0.08) 4px)',
          backgroundSize:'100% 4px',
        }} />)}
        {grp && (<div style={{ position:'absolute', left:0, top:0, bottom:0, width:4, borderRadius:'8px 0 0 8px', background: C.purple, zIndex:2 }} />)}

        <div style={{ display:'flex', flexDirection: compact ? 'column' : 'row', alignItems: compact ? 'stretch' : 'center', minHeight: compact ? undefined : 52 }}>
          {/* INFO */}
          <div style={{ display:'flex', alignItems: compact ? 'flex-start' : 'center', gap: compact ? 8 : 16, flex:'1 1 auto', minWidth:0, maxWidth: compact ? '100%' : '65%', paddingLeft: grp ? 8 : 0, flexWrap:'wrap', width: compact ? '100%' : 'auto' }}>
            <div style={{ display:'flex', alignItems:'center', gap: compact ? 6 : 8, flexShrink: 0, flexWrap:'wrap' }}>
              <span className={hasBallCall && !serviceCallAcked ? 'lane-number-pulse' : undefined} style={{ fontFamily: F.head, fontSize: compact ? '1.2rem' : '1.6rem', fontWeight:900, color: accent, textShadow: isDark ? `0 0 12px ${accent}55` : 'none', letterSpacing:'0.08em', minWidth: compact ? 28 : 40, flexShrink: 0 }}>{num}</span>
              {hasBallCall && (<Tag color={serviceCallAcked ? C.serviceAck : C.amber}>{serviceCallAcked ? 'SERVICE — ACK' : 'SERVICE'}</Tag>)}
              <Tag color={accent}>{status}</Tag>
              {w?.extended && !w.paid && (<Tag color={C.yellow}>⚡ EXTENDED — NEEDS PAYMENT</Tag>)}
              {grp && (<Tag color={C.purple}>GROUP {grp.lanes.sort((a, b) => a - b).join('+')}</Tag>)}
            </div>

            {w && (
              <div style={{ display:'flex', alignItems:'center', gap: compact ? 8 : 16, flexWrap:'wrap', minWidth:0, flex: compact ? '1 1 100%' : '1 1 auto', maxWidth:'100%' }}>
                <Info label="OPENED" value={fmt(walkHM(w.openedAt))} color={accent} />
                <Info label="EST. CLOSE" value={estClose(w.openedAt, walkMins(w), serviceCallMins(w))} color={C.yellow} />
                <Info label="ELAPSED" value={elapsed(w.openedAt)} color={accent} />
                <Info label="BOWLERS" value={w.bowlers} color={accent} />
                {w.type === 'hourly' ? (
                  <Info label="HOURS" value={w.hours || 1} color={accent} />
                ) : (
                  <Info label="GAMES" value={w.games || 1} color={accent} />
                )}
              </div>
            )}
            {r && !w && (
              <div style={{ display:'flex', alignItems:'center', gap: compact ? 8 : 16, flexWrap:'wrap', minWidth:0, flex: compact ? '1 1 100%' : '1 1 auto', maxWidth:'100%' }}>
                <Info label="PARTY" value={r.party} color={r.cancelled ? C.dim : accent} />
                {r.cancelled && <Tag color={C.red}>CANCELLED</Tag>}
                <Info label="GUESTS" value={r.guests} color={r.cancelled ? C.dim : accent} />
                <Info label="TIME" value={`${fmt(r.start)}–${fmt(r.end)}`} color={r.cancelled ? C.dim : accent} />
                <Info label="TYPE" value={r.type === 'hourly' ? `${r.hours}h` : r.type === 'per-game' ? `${r.games} games` : 'Reservation'} color={r.cancelled ? C.dim : accent} />
              </div>
            )}
            {!active && !im && !up && <span style={{ fontFamily: F.mono, fontSize:'0.75rem', color: C.text, opacity:0.5 }}>No upcoming reservations</span>}
            {im && <span style={{ fontFamily: F.mono, fontSize:'0.75rem', color: C.maint, opacity:0.6 }}>Lane offline</span>}
          </div>

          {/* BUTTONS */}
          <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap: compact ? 'wrap' : 'nowrap', flexShrink:0, ...(compact ? { borderTop: `1px solid ${accent}22`, marginTop:8, paddingTop:8, width:'100%', justifyContent: 'flex-end' } : { marginLeft:'auto', minWidth: 'fit-content' }) }}>
            {w && (<>
              <Btn color={C.blue} onClick={() => setEditLane(isEdit ? null : num)} active={isEdit}>{isEdit ? 'Done' : 'Edit'}</Btn>
              <Btn color={w.paid ? C.green : C.red} onClick={() => dispatch('TOGGLE_WALK_PAID', { lane: num })} active={w.paid}>
                {w.paid ? 'Mark Unpaid' : 'Mark Paid'}{grp ? ' All' : ''}
              </Btn>
              {movingLane === num ? (
                <Btn color={C.yellow} onClick={() => setMovingLane(null)} active>Cancel Move</Btn>
              ) : (
                <Btn color={C.yellow} onClick={() => setMovingLane(num)}><ArrowRightLeft size={14} /> Move</Btn>
              )}
              {!hasBallCall && <Btn color={C.amber} onClick={() => dispatch('TOGGLE_SERVICE_CALL', { lane: num })}>Service</Btn>}
              {hasBallCall && !serviceCallAcked && <Btn color={C.amber} onClick={() => dispatch('ACK_SERVICE_CALL', { lane: num })} active>Acknowledge</Btn>}
              {hasBallCall && <Btn color={C.green} onClick={() => dispatch('TOGGLE_SERVICE_CALL', { lane: num })}>Repaired</Btn>}
              {isConf && confirm.type === 'close' ? (
                <ConfirmInline text={grp ? `Close group ${grp.lanes.sort((a, b) => a - b).join('+')}?` : 'Close?'} onYes={() => { dispatch('CLOSE_WALKIN', { lane: num }); setConfirm(null); }} onNo={() => setConfirm(null)} />
              ) : (
                <Btn color={C.pink} onClick={() => setConfirm({ type:'close', lane: num })}>{grp ? 'Close Group' : 'Close'}</Btn>
              )}
            </>)}

            {r && !w && (<>
              {!r.arrived ? (
                <>
                  <Btn color={C.blue} onClick={() => dispatch('MARK_ARRIVED', { lane: num, start: r.start })}>✓ Arrived</Btn>
                  <Btn color={r.paid ? C.green : C.red} onClick={() => dispatch('TOGGLE_RES_PAID', { lane: num, start: r.start })} active={r.paid}>
                    {r.paid ? 'Mark Unpaid' : 'Mark Paid'}
                  </Btn>
                  {isConf && confirm.type === 'no-show' && confirm.start === r.start ? (
                    <ConfirmInline text="Mark no-show?" onYes={() => { dispatch('MARK_NO_SHOW', { lane: num, start: r.start }); setConfirm(null); }} onNo={() => setConfirm(null)} />
                  ) : (
                    <Btn color={C.red} onClick={() => setConfirm({ type:'no-show', lane: num, start: r.start })}>No-Show</Btn>
                  )}
                </>
              ) : (
                <>
                  <Btn color={r.paid ? C.green : C.red} onClick={() => dispatch('TOGGLE_RES_PAID', { lane: num, start: r.start })} active={r.paid}>
                    {r.paid ? 'Mark Unpaid' : 'Mark Paid'}
                  </Btn>
                  {!hasBallCall && <Btn color={C.amber} onClick={() => dispatch('TOGGLE_SERVICE_CALL', { lane: num })}>Service</Btn>}
                  {hasBallCall && !serviceCallAcked && <Btn color={C.amber} onClick={() => dispatch('ACK_SERVICE_CALL', { lane: num })} active>Acknowledge</Btn>}
                  {hasBallCall && <Btn color={C.green} onClick={() => dispatch('TOGGLE_SERVICE_CALL', { lane: num })}>Repaired</Btn>}
                  {isConf && confirm.type === 'cancel' && confirm.start === r.start ? (
                    <ConfirmInline text="Cancel?" onYes={() => { dispatch('CANCEL_RESERVATION', { lane: num, start: r.start }); setConfirm(null); }} onNo={() => setConfirm(null)} />
                  ) : !r.cancelled && (
                    <Btn color={C.orange} onClick={() => setConfirm({ type:'cancel', lane: num, start: r.start })}>Cancel</Btn>
                  )}
                  {isConf && confirm.type === 'delete' && confirm.start === r.start ? (
                    <ConfirmInline text="Delete?" onYes={() => { dispatch('DELETE_RESERVATION', { lane: num, start: r.start }); setConfirm(null); }} onNo={() => setConfirm(null)} />
                  ) : (
                    <Btn color={C.pink} onClick={() => setConfirm({ type:'delete', lane: num, start: r.start })}><Trash2 size={14} /> Delete</Btn>
                  )}
                </>
              )}
            </>)}

            {!w && !im && !soon && !isOpen && (
              <Btn color={C.blue} onClick={() => { setOpenLane(num); setEditLane(null); }}>+ Open</Btn>
            )}

            {!active && hasBallCall && !serviceCallAcked && (
              <Btn color={C.amber} onClick={() => dispatch('ACK_SERVICE_CALL', { lane: num })} active>Acknowledge</Btn>
            )}
            {!active && hasBallCall && (
              <Btn color={C.green} onClick={() => dispatch('TOGGLE_SERVICE_CALL', { lane: num })}>Repaired</Btn>
            )}
            {isMoveTarget && (
              <Btn color={C.yellow} onClick={() => { dispatch('MOVE_LANE', { fromLane: movingLane, toLane: num }); setMovingLane(null); }}>
                <ArrowRightLeft size={14} /> {movingGrp && movingGrp.length > 1 ? `Move Group → ${num}–${num + movingGrp.length - 1}` : 'Move Here'}
              </Btn>
            )}

            {!active && up && !im && (<>
              {isConf && confirm.type === 'cancel' && confirm.start === up.start ? (
                <ConfirmInline text="Cancel?" onYes={() => { dispatch('CANCEL_RESERVATION', { lane: num, start: up.start }); setConfirm(null); }} onNo={() => setConfirm(null)} />
              ) : !up.cancelled && (
                <Btn color={C.orange} onClick={() => setConfirm({ type:'cancel', lane: num, start: up.start })}>Cancel</Btn>
              )}
              {isConf && confirm.type === 'delete' && confirm.start === up.start ? (
                <ConfirmInline text="Delete?" onYes={() => { dispatch('DELETE_RESERVATION', { lane: num, start: up.start }); setConfirm(null); }} onNo={() => setConfirm(null)} />
              ) : (
                <Btn color={C.pink} onClick={() => setConfirm({ type:'delete', lane: num, start: up.start })}><Trash2 size={14} /> Delete</Btn>
              )}
            </>)}
            {!active && im && isConf && confirm.type === 'online' ? (
              <ConfirmInline text="Bring online?" onYes={() => { dispatch('TOGGLE_MAINTENANCE', { lane: num }); setConfirm(null); }} onNo={() => setConfirm(null)} />
            ) : !active && (
              <button onClick={e => { e.stopPropagation(); im ? setConfirm({ type:'online', lane: num }) : dispatch('TOGGLE_MAINTENANCE', { lane: num }); }} title={im ? 'Bring online' : 'Take offline'} style={{
                ...(im ? inset(C, { radius: 6, distance: 3, accent: C.maint }) : raised(C, { radius: 6, distance: 3 })),
                width: compact ? 40 : 48, height: compact ? 40 : 48, cursor:'pointer',
                color: im ? C.maint : C.text, display:'flex', alignItems:'center', justifyContent:'center', transition:'box-shadow 0.15s, color 0.15s', flexShrink:0,
              }}><Wrench size={16} /></button>
            )}
          </div>
        </div>

        {/* Next upcoming reservation notification */}
        {up && !im && (
          <div style={{
            display:'flex',
            alignItems:'center',
            gap: compact ? 6 : 10,
            marginTop:8,
            padding: compact ? '6px 10px' : '8px 14px',
            borderRadius:6,
            background: `${C.pink}10`,
            border: `1px solid ${C.pink}33`,
            flexWrap:'wrap'
          }}>
            <span style={{ fontFamily: F.mono, fontSize: compact ? '0.55rem' : '0.6rem', letterSpacing:'0.1em', color: C.pink, fontWeight:700, whiteSpace:'nowrap' }}>
              UPCOMING
            </span>
            <span style={{ fontFamily: F.mono, fontSize: compact ? '0.6rem' : '0.65rem', color: C.pink, fontWeight:600 }}>
              {up.party}
            </span>
            <span style={{ fontFamily: F.mono, fontSize: compact ? '0.55rem' : '0.6rem', color: C.pink, opacity:0.8 }}>
              {fmt(up.start)} • {up.guests} guests
            </span>
            {up.cancelled && <Tag color={C.red}>CANCELLED</Tag>}
          </div>
        )}

        {/* Additional upcoming reservations within the hour */}
        {upcomingHour(num).filter(u => u !== r && u !== up).map(u => (
          <div key={u.start} style={{ display:'flex', alignItems:'center', gap:12, marginTop:8, padding:'8px 12px', borderRadius:6, background: `${C.pink}10`, border: `1px solid ${C.pink}22`, flexWrap:'wrap' }}>
            <span style={{ fontFamily: F.mono, fontSize:'0.6rem', letterSpacing:'0.1em', color: C.pink, fontWeight:700, whiteSpace:'nowrap' }}>UPCOMING</span>
            <Info label="PARTY" value={u.party} color={C.pink} />
            <Info label="TIME" value={`${fmt(u.start)}–${fmt(u.end)}`} color={C.pink} />
            <Info label="GUESTS" value={u.guests} color={C.pink} />
          </div>
        ))}

        {/* Edit tray */}
        <AnimExpand open={isEdit && w != null}>
          <div style={{ borderTop: `1px solid ${accent}22`, marginTop:12, paddingTop:14 }} onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', alignItems:'center', gap: compact ? 12 : 20, flexWrap:'wrap' }}>
              <Stepper label="BOWLERS" value={w?.bowlers || 1} onChange={v => dispatch('UPDATE_WALKIN', { lane: num, updates: { bowlers: v } })} color={accent} />
              {w?.type === 'per-game' && (<Stepper label="GAMES" value={w?.games || 1} onChange={v => dispatch('UPDATE_WALKIN', { lane: num, updates: { games: v } })} color={accent} />)}
              {w?.type === 'hourly' && (<Stepper label="HOURS" value={w?.hours || 1} onChange={v => dispatch('UPDATE_WALKIN', { lane: num, updates: { hours: v } })} color={accent} />)}
              <div style={{ marginLeft: compact ? 0 : 'auto', width: compact ? '100%' : 'auto' }}><Btn color={C.dim} onClick={() => setEditLane(null)}>Done</Btn></div>
            </div>
            {/* Group lane selector */}
            <div style={{ display:'flex', alignItems:'center', gap: compact ? 4 : 8, marginTop:14, paddingTop:14, borderTop: `1px solid ${C.purple}22`, flexWrap:'wrap' }}>
              <span style={{ fontFamily: F.mono, fontSize:'0.6rem', color: C.text, letterSpacing:'0.1em', minWidth: compact ? 45 : 55 }}>GROUP</span>
              {LANES.map(l => {
                const inGroup = grp ? grp.lanes.includes(l) : false;
                const isSelf = l === num;
                const laneActive = !!(getWalk(l) || curRes(l));
                const canToggle = !isSelf && laneActive && !maint[l];
                const selected = isSelf || inGroup;
                return (
                  <button key={l} disabled={!canToggle && !isSelf} onClick={e => {
                    e.stopPropagation();
                    if (!canToggle) return;
                    const currentLanes = grp ? [...grp.lanes] : [num];
                    const newLanes = inGroup ? currentLanes.filter(x => x !== l) : [...currentLanes, l];
                    dispatch('SET_GROUP', { lanes: newLanes });
                  }} style={{
                    width: compact ? 34 : 40, height: compact ? 34 : 40, borderRadius:5, cursor: canToggle ? 'pointer' : 'default',
                    fontFamily: F.head, fontSize:'0.85rem', fontWeight:700,
                    border: `1.5px solid ${selected ? C.purple : canToggle ? C.purple + '55' : C.dim + '44'}`,
                    background: selected ? `${C.purple}22` : 'transparent',
                    color: selected ? C.purple : canToggle ? C.purple + '88' : C.dim,
                    transition:'all 0.15s', display:'flex', alignItems:'center', justifyContent:'center', padding:0,
                    boxShadow: selected && !isSelf ? `0 0 6px ${C.purple}33` : 'none',
                  }}>{l}</button>
                );
              })}
            </div>
          </div>
        </AnimExpand>

        {/* Open form */}
        <AnimExpand open={isOpen}>
          <div style={{ borderTop: `1px solid ${C.blue}22`, marginTop:12, paddingTop:14 }} onClick={e => e.stopPropagation()}>
            <div style={{ display:'flex', alignItems:'center', gap: compact ? 10 : 16, flexWrap:'wrap' }}>
              <div style={{ display:'flex', gap:6 }}>
                <Btn color={C.purple} onClick={() => setForm(f => ({ ...f, type:'per-game' }))} active={form.type === 'per-game'}>Per Game</Btn>
                <Btn color={C.yellow} onClick={() => setForm(f => ({ ...f, type:'hourly' }))} active={form.type === 'hourly'}>Hourly</Btn>
              </div>
              <Stepper label="BOWLERS" value={form.bowlers} onChange={v => setForm(f => ({ ...f, bowlers: v }))} color={C.blue} />
              {form.type === 'per-game' && (<Stepper label="GAMES" value={form.games} onChange={v => setForm(f => ({ ...f, games: v }))} color={C.blue} />)}
              {form.type === 'hourly' && (<Stepper label="HOURS" value={form.hours} onChange={v => setForm(f => ({ ...f, hours: v }))} color={C.blue} />)}
              <div style={{ display:'flex', gap:6, marginLeft: compact ? 0 : 'auto', width: compact ? '100%' : 'auto', flexWrap:'wrap' }}>
                <Btn color={C.blue} onClick={() => {
                  dispatch('OPEN_WALKIN', { lane: num, bowlers: form.bowlers, walkType: form.type, games: form.games, hours: form.hours });
                  if (form.groupLanes.length > 0) setTimeout(() => dispatch('SET_GROUP', { lanes: [num, ...form.groupLanes] }), 100);
                  setOpenLane(null); setForm({ bowlers:2, type:'per-game', games:1, hours:1, groupLanes:[] });
                }}>⚡ Open</Btn>
                <Btn color={C.text} onClick={() => { setOpenLane(null); setForm(f => ({ ...f, groupLanes:[] })); }}>Cancel</Btn>
              </div>
            </div>
            {/* Group lane selector */}
            <div style={{ display:'flex', alignItems:'center', gap: compact ? 4 : 8, marginTop:14, paddingTop:14, borderTop: `1px solid ${C.purple}22`, flexWrap:'wrap' }}>
              <span style={{ fontFamily: F.mono, fontSize:'0.6rem', color: C.text, letterSpacing:'0.1em', minWidth: compact ? 45 : 55 }}>GROUP</span>
              {LANES.map(l => {
                const isSelf = l === num;
                const laneActive = !!(getWalk(l) || curRes(l));
                const canToggle = !isSelf && laneActive && !maint[l];
                const selected = isSelf || form.groupLanes.includes(l);
                return (
                  <button key={l} disabled={!canToggle && !isSelf} onClick={e => {
                    e.stopPropagation();
                    if (!canToggle) return;
                    setForm(f => ({ ...f, groupLanes: f.groupLanes.includes(l) ? f.groupLanes.filter(x => x !== l) : [...f.groupLanes, l] }));
                  }} style={{
                    width: compact ? 34 : 40, height: compact ? 34 : 40, borderRadius:5, cursor: canToggle ? 'pointer' : 'default',
                    fontFamily: F.head, fontSize:'0.85rem', fontWeight:700,
                    border: `1.5px solid ${selected ? C.purple : canToggle ? C.purple + '55' : C.dim + '44'}`,
                    background: selected ? `${C.purple}22` : 'transparent',
                    color: selected ? C.purple : canToggle ? C.purple + '88' : C.dim,
                    transition:'all 0.15s', display:'flex', alignItems:'center', justifyContent:'center', padding:0,
                    boxShadow: selected && !isSelf ? `0 0 6px ${C.purple}33` : 'none',
                  }}>{l}</button>
                );
              })}
            </div>
          </div>
        </AnimExpand>
      </div>
    );
  };

  // ── Timeline ──────────────────────────────────────────
  const Timeline = () => {
    const tlRef = useRef(null);
    const [tlWidth, setTlWidth] = useState(0);
    useLayoutEffect(() => {
      if (!tlRef.current) return;
      setTlWidth(tlRef.current.clientWidth);
      const ro = new ResizeObserver(() => setTlWidth(tlRef.current.clientWidth));
      ro.observe(tlRef.current);
      return () => ro.disconnect();
    }, []);

    const renderHourView = () => {
      const nowHr = now.getHours() + now.getMinutes() / 60;
      const startHr = Math.max(0, Math.min(23, nowHr - 1));
      const endHr = Math.min(24, Math.max(startHr + 2, nowHr + 4));
      const windowHrs = endHr - startHr;
      const labelMargin = compact ? 44 : 70;
      const trackW = Math.max(1, tlWidth - labelMargin);
      const pxPerHr = trackW / windowHrs;
      const totalW = trackW;
      const nowPx = (nowHr - startHr) * pxPerHr;
      const hourMarks = [];
      for (let h = Math.ceil(startHr); h < endHr; h++) hourMarks.push(h);
      const fmtHr = h => { const hr = h % 24; return hr === 0 ? '12a' : hr < 12 ? `${hr}a` : hr === 12 ? '12p' : `${hr - 12}p`; };
      const getBlocks = laneNum => {
        const blocks = [];
        const today = new Date().toISOString().split('T')[0];
        res.filter(r => r.lane === laneNum && (r.date || today) === today).forEach(r => {
          const s = tn(r.start), e = tn(r.end), act = nn >= s && nn < e;
          const left = Math.max(0, (s - startHr) * pxPerHr);
          const right = Math.min(totalW, (e - startHr) * pxPerHr);
          if (right > 0 && left < totalW) blocks.push({ left, width: Math.max(10, right - left), label: r.party, sub: `${fmt(r.start)}–${fmt(r.end)}`, color: act ? (r.paid ? C.green : C.red) : C.pink, reservation: r });
        });
        const w = getWalk(laneNum);
        if (w) { const wHM = walkHM(w.openedAt); const bcH = serviceCallMins(w) / 60; const s = tn(wHM), e = s + walkMins(w) / 60 + bcH;
          const left = Math.max(0, (s - startHr) * pxPerHr);
          const right = Math.min(totalW, (Math.max(e, nn + 0.1) - startHr) * pxPerHr);
          const detail = w.type === 'hourly' ? `${w.hours || 1}hr` : `${w.games || 1}g`;
          if (right > 0 && left < totalW) blocks.push({ left, width: Math.max(10, right - left), label: `Walk-in · ${w.bowlers} · ${detail}`, sub: `${fmt(wHM)}–~${estClose(w.openedAt, walkMins(w), serviceCallMins(w))}`, color: w.paid ? C.green : C.red });
        }
        if (maint[laneNum]) blocks.push({ left:0, width: totalW, label:'MAINTENANCE', sub:'', color: C.maint });
        return blocks;
      };
      return (
        <div style={{ position:'relative' }}>
          <div style={{ display:'flex', marginLeft: labelMargin, marginBottom:6 }}>
            {hourMarks.map(h => (<div key={h} style={{ position:'absolute', left: labelMargin + (h - startHr) * pxPerHr, fontFamily: F.mono, fontSize:'0.6rem', color: C.text, opacity:0.5 }}>{fmtHr(h)}</div>))}
          </div>
          <div style={{ marginTop: 16 }}>
          {LANES.map(laneNum => {
            const blocks = getBlocks(laneNum); const im = maint[laneNum];
            let la = C.blue; const w2 = getWalk(laneNum), r2 = curRes(laneNum);
            if (im) la = C.maint; else if (w2) la = w2.paid ? C.green : C.red; else if (r2) la = r2.paid ? C.green : C.red;
            const grpL = getGroupForLane(laneNum);
            return (
              <div key={laneNum} style={{ display:'flex', alignItems:'center', marginBottom:4, position:'relative' }}>
                {grpL && (<div style={{ position:'absolute', left:2, top:0, bottom:0, width:4, background: C.purple, borderRadius:2 }} />)}
                <div style={{ width: compact ? 36 : 62, fontFamily: F.head, fontSize:'0.85rem', fontWeight:700, color: la, textShadow: `0 0 8px ${la}33`, textAlign:'center', flexShrink:0 }}>{laneNum}</div>
                <div style={{ position:'relative', height: compact ? 36 : 48, flex:1, background: `${C.dim}22`, borderRadius:4, overflow:'visible' }}>
                  {hourMarks.map(h => (<div key={h} style={{ position:'absolute', left: (h - startHr) * pxPerHr, top:0, bottom:0, borderLeft: `1px solid ${C.dim}44` }} />))}
                  {blocks.map((b, i) => (
                    <div key={i} onClick={() => b.reservation && setSelectedReservation(b.reservation)} style={{ position:'absolute', top:4, bottom:4, left: b.left, width: b.width, background: `${b.color}25`, border: `1.5px solid ${b.color}66`, borderRadius:4, display:'flex', alignItems:'center', padding:'0 8px', overflow:'visible', cursor: b.reservation ? 'pointer' : 'default' }}>
                      <span style={{ fontFamily: F.mono, fontSize:'0.55rem', color: b.color, whiteSpace:'nowrap' }}>{b.label}{b.sub ? ` · ${b.sub}` : ''}</span>
                    </div>
                  ))}
                  {nowPx > 0 && nowPx < totalW && (<div style={{ position:'absolute', top:0, bottom:0, left: nowPx, width:2, background: C.yellow, boxShadow: `0 0 8px ${C.yellow}88`, zIndex:5 }} />)}
                </div>
              </div>
            );
          })}
          </div>
          <div style={{ display:'flex', gap: compact ? 10 : 16, marginTop:12, marginLeft: labelMargin, flexWrap:'wrap' }}>
            {[{ l:'Active/Paid', c: C.green }, { l:'Unpaid', c: C.red }, { l:'Reserved', c: C.pink }, { l:'Maintenance', c: C.maint }, { l:'Grouped', c: C.purple }, { l:'Now', c: C.yellow }].map(x => (
              <div key={x.l} style={{ display:'flex', alignItems:'center', gap:5 }}>
                <div style={{ width:12, height:12, borderRadius:2, background: `${x.c}33`, border: `1.5px solid ${x.c}` }} />
                <span style={{ fontFamily: F.mono, fontSize:'0.55rem', color: C.text, opacity:0.7 }}>{x.l}</span>
              </div>
            ))}
          </div>
        </div>
      );
    };

    const renderDayView = () => {
      const startHr = 9;
      const endHr = 20;
      const windowHrs = endHr - startHr;
      const labelMargin = compact ? 44 : 70;
      const trackW = Math.max(1, tlWidth - labelMargin);
      const pxPerHr = trackW / windowHrs;
      const totalW = trackW;
      const dayDateStr = formatDateYYYYMMDD(selectedDate);
      const today = new Date().toISOString().split('T')[0];
      const isSelectedToday = dayDateStr === today;
      const dayRes = res.filter(r => (r.date || today) === dayDateStr);
      const dayWalks = isSelectedToday ? walks : [];
      const nowHr = now.getHours() + now.getMinutes() / 60;
      const nowPx = isSelectedToday ? (nowHr - startHr) * pxPerHr : -1;
      const hourMarks = [];
      for (let h = startHr; h < endHr; h++) hourMarks.push(h);
      const fmtHr = h => { const hr = h % 24; return hr === 0 ? '12a' : hr < 12 ? `${hr}a` : hr === 12 ? '12p' : `${hr - 12}p`; };
      const getBlocks = laneNum => {
        const blocks = [];
        dayRes.filter(r => r.lane === laneNum).forEach(r => {
          const s = tn(r.start), e = tn(r.end);
          const left = Math.max(0, (s - startHr) * pxPerHr);
          const right = Math.min(totalW, (e - startHr) * pxPerHr);
          if (right > 0 && left < totalW) blocks.push({ left, width: Math.max(10, right - left), label: r.party, sub: `${fmt(r.start)}–${fmt(r.end)}`, color: r.cancelled ? C.dim : C.pink, reservation: r });
        });
        const w = dayWalks.find(w => w.lane === laneNum);
        if (w) { const wHM = walkHM(w.openedAt); const bcH = serviceCallMins(w) / 60; const s = tn(wHM), e = s + walkMins(w) / 60 + bcH;
          const left = Math.max(0, (s - startHr) * pxPerHr);
          const right = Math.min(totalW, (Math.max(e, nowHr + 0.1) - startHr) * pxPerHr);
          const detail = w.type === 'hourly' ? `${w.hours || 1}hr` : `${w.games || 1}g`;
          if (right > 0 && left < totalW) blocks.push({ left, width: Math.max(10, right - left), label: `Walk-in · ${w.bowlers} · ${detail}`, sub: `${fmt(wHM)}–~${estClose(w.openedAt, walkMins(w), serviceCallMins(w))}`, color: w.paid ? C.green : C.red });
        }
        if (maint[laneNum]) blocks.push({ left:0, width: totalW, label:'MAINTENANCE', sub:'', color: C.maint });
        return blocks;
      };
      return (
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12, flexWrap:'wrap' }}>
            <Btn color={C.blue} onClick={() => setSelectedDate(addDays(selectedDate, -1))}>◀ Prev</Btn>
            <Btn color={C.blue} onClick={() => setSelectedDate(new Date())} active={isToday(selectedDate)}>Today</Btn>
            <div style={{ fontFamily: F.mono, fontSize: compact ? '0.7rem' : '0.8rem', color: C.text }}>
              {formatDateDisplay(selectedDate)}
            </div>
            <Btn color={C.blue} onClick={() => setSelectedDate(addDays(selectedDate, 1))}>Next ▶</Btn>
          </div>
          <div style={{ position:'relative' }}>
            <div style={{ display:'flex', marginLeft: labelMargin, marginBottom:6 }}>
              {hourMarks.map(h => (<div key={h} style={{ position:'absolute', left: labelMargin + (h - startHr) * pxPerHr, fontFamily: F.mono, fontSize:'0.6rem', color: C.text, opacity:0.5 }}>{fmtHr(h)}</div>))}
            </div>
            <div style={{ marginTop: 16 }}>
            {LANES.map(laneNum => {
              const blocks = getBlocks(laneNum); const im = maint[laneNum];
              let la = C.blue;
              if (im) la = C.maint;
              const grpL = getGroupForLane(laneNum);
              return (
                <div key={laneNum} style={{ display:'flex', alignItems:'center', marginBottom:4, position:'relative' }}>
                  {grpL && (<div style={{ position:'absolute', left:2, top:0, bottom:0, width:4, background: C.purple, borderRadius:2 }} />)}
                  <div style={{ width: compact ? 36 : 62, fontFamily: F.head, fontSize:'0.85rem', fontWeight:700, color: la, textShadow: `0 0 8px ${la}33`, textAlign:'center', flexShrink:0 }}>{laneNum}</div>
                  <div style={{ position:'relative', height: compact ? 36 : 48, flex:1, background: `${C.dim}22`, borderRadius:4, overflow:'visible' }}>
                    {hourMarks.map(h => (<div key={h} style={{ position:'absolute', left: (h - startHr) * pxPerHr, top:0, bottom:0, borderLeft: `1px solid ${C.dim}44` }} />))}
                    {blocks.map((b, i) => (
                      <div key={i} onClick={() => b.reservation && setSelectedReservation(b.reservation)} style={{ position:'absolute', top:4, bottom:4, left: b.left, width: b.width, background: `${b.color}25`, border: `1.5px solid ${b.color}66`, borderRadius:4, display:'flex', alignItems:'center', padding:'0 8px', overflow:'visible', cursor: b.reservation ? 'pointer' : 'default' }}>
                        <span style={{ fontFamily: F.mono, fontSize:'0.55rem', color: b.color, whiteSpace:'nowrap' }}>{b.label}{b.sub ? ` · ${b.sub}` : ''}</span>
                      </div>
                    ))}
                    {nowPx > 0 && nowPx < totalW && (<div style={{ position:'absolute', top:0, bottom:0, left: nowPx, width:2, background: C.yellow, boxShadow: `0 0 8px ${C.yellow}88`, zIndex:5 }} />)}
                  </div>
                </div>
              );
            })}
            </div>
            <div style={{ display:'flex', gap: compact ? 10 : 16, marginTop:12, marginLeft: labelMargin, flexWrap:'wrap' }}>
              {[{ l:'Reserved', c: C.pink }, { l:'Walk-in/Paid', c: C.green }, { l:'Unpaid', c: C.red }, { l:'Maintenance', c: C.maint }, { l:'Grouped', c: C.purple }, { l:'Now', c: C.yellow }].map(x => (
                <div key={x.l} style={{ display:'flex', alignItems:'center', gap:5 }}>
                  <div style={{ width:12, height:12, borderRadius:2, background: `${x.c}33`, border: `1.5px solid ${x.c}` }} />
                  <span style={{ fontFamily: F.mono, fontSize:'0.55rem', color: C.text, opacity:0.7 }}>{x.l}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    };

    const renderWeekView = () => {
      const weekStart = selectedWeekStart;
      const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
      const weekStartStr = formatDateYYYYMMDD(weekStart);
      const weekEndStr = formatDateYYYYMMDD(addDays(weekStart, 6));
      const today = new Date().toISOString().split('T')[0];
      const weekRes = res.filter(r => {
        const rDate = r.date || today;
        return rDate >= weekStartStr && rDate <= weekEndStr;
      });
      const countByDayLane = new Map();
      for (const r of weekRes) {
        const key = `${r.date || today}-${r.lane}`;
        countByDayLane.set(key, (countByDayLane.get(key) || 0) + 1);
      }
      const getCellColor = (count) => {
        if (count === 0) return 'transparent';
        const intensity = Math.min(count / 6, 1);
        return `rgba(0, 180, 255, ${0.15 + intensity * 0.5})`;
      };
      return (
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12, flexWrap:'wrap' }}>
            <Btn color={C.blue} onClick={() => setSelectedWeekStart(addDays(selectedWeekStart, -7))}>◀ Prev</Btn>
            <Btn color={C.blue} onClick={() => setSelectedWeekStart(getWeekStart(new Date()))}>This Week</Btn>
            <div style={{ fontFamily: F.mono, fontSize: compact ? '0.7rem' : '0.8rem', color: C.text }}>
              {formatDateDisplay(weekStart)} - {formatDateDisplay(addDays(weekStart, 6))}
            </div>
            <Btn color={C.blue} onClick={() => setSelectedWeekStart(addDays(selectedWeekStart, 7))}>Next ▶</Btn>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '50px repeat(7, 1fr)' : '70px repeat(7, 1fr)',
            gap: compact ? 4 : 6,
          }}>
            <div style={{ fontFamily: F.mono, fontSize:'0.6rem', color: C.text, opacity:0.6 }}></div>
            {weekDays.map((day, i) => (
              <div key={i} style={{ fontFamily: F.mono, fontSize: compact ? '0.55rem' : '0.65rem', color: C.text, textAlign:'center', padding:8 }}>
                {day.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' })}
              </div>
            ))}
            {LANES.map(lane => (
              <React.Fragment key={lane}>
                <div style={{ fontFamily: F.head, fontSize:'0.85rem', fontWeight:700, color: C.blue, textAlign:'center', padding:8 }}>
                  {lane}
                </div>
                {weekDays.map((day, i) => {
                  const dateStr = formatDateYYYYMMDD(day);
                  const count = countByDayLane.get(`${dateStr}-${lane}`) || 0;
                  const isInMaint = maint[lane];
                  return (
                    <button
                      key={i}
                      onClick={() => {
                        setSelectedDate(day);
                        setTimelineViewMode('day');
                      }}
                      style={{
                        fontFamily: F.mono,
                        fontSize: compact ? '0.75rem' : '0.9rem',
                        fontWeight: 700,
                        padding: compact ? 12 : 16,
                        border: `1.5px solid ${isInMaint ? C.maint : C.blue}55`,
                        borderRadius: 6,
                        background: isInMaint ? `${C.maint}22` : getCellColor(count),
                        color: isInMaint ? C.maint : count > 0 ? C.blue : C.dim,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                      }}
                    >
                      {isInMaint ? 'MAINT' : count > 0 ? count : '—'}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
          <div style={{ marginTop:16, display:'flex', gap:16, flexWrap:'wrap', fontSize:'0.55rem', color: C.text, opacity:0.7 }}>
            <span>Click a cell to view detailed day timeline for that lane and date</span>
          </div>
        </div>
      );
    };

    const renderMonthView = () => {
      const monthStart = new Date(selectedMonth);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);
      const monthStartStr = formatDateYYYYMMDD(monthStart);
      const monthEndStr = formatDateYYYYMMDD(monthEnd);
      const today = new Date().toISOString().split('T')[0];
      const monthRes = res.filter(r => {
        const rDate = r.date || today;
        return rDate >= monthStartStr && rDate <= monthEndStr;
      });
      const countByDay = new Map();
      for (const r of monthRes) {
        const date = r.date || today;
        countByDay.set(date, (countByDay.get(date) || 0) + 1);
      }
      const firstDayOfWeek = monthStart.getDay();
      const daysInMonth = monthEnd.getDate();
      const calendarDays = [];
      for (let i = 0; i < firstDayOfWeek; i++) {
        const day = new Date(monthStart);
        day.setDate(day.getDate() - (firstDayOfWeek - i));
        calendarDays.push({ date: day, isCurrentMonth: false });
      }
      for (let i = 1; i <= daysInMonth; i++) {
        const day = new Date(monthStart);
        day.setDate(i);
        calendarDays.push({ date: day, isCurrentMonth: true });
      }
      const remainingCells = 7 - (calendarDays.length % 7);
      if (remainingCells < 7) {
        for (let i = 1; i <= remainingCells; i++) {
          const day = new Date(monthEnd);
          day.setDate(monthEnd.getDate() + i);
          calendarDays.push({ date: day, isCurrentMonth: false });
        }
      }
      return (
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:12, flexWrap:'wrap' }}>
            <Btn color={C.blue} onClick={() => {
              const prev = new Date(selectedMonth);
              prev.setMonth(prev.getMonth() - 1);
              setSelectedMonth(prev);
            }}>◀ Prev</Btn>
            <Btn color={C.blue} onClick={() => setSelectedMonth(new Date())}>This Month</Btn>
            <div style={{ fontFamily: F.mono, fontSize: compact ? '0.8rem' : '0.9rem', fontWeight:700, color: C.text }}>
              {selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </div>
            <Btn color={C.blue} onClick={() => {
              const next = new Date(selectedMonth);
              next.setMonth(next.getMonth() + 1);
              setSelectedMonth(next);
            }}>Next ▶</Btn>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            gap: compact ? 4 : 6,
          }}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
              <div key={day} style={{
                fontFamily: F.mono,
                fontSize: '0.6rem',
                color: C.text,
                opacity: 0.6,
                textAlign: 'center',
                padding: compact ? 6 : 8,
              }}>
                {day}
              </div>
            ))}
            {calendarDays.map((item, i) => {
              const dateStr = formatDateYYYYMMDD(item.date);
              const count = countByDay.get(dateStr) || 0;
              const isTodayDate = isToday(item.date);
              return (
                <button
                  key={i}
                  onClick={() => {
                    setSelectedDate(item.date);
                    setTimelineViewMode('day');
                  }}
                  style={{
                    fontFamily: F.mono,
                    fontSize: compact ? '0.65rem' : '0.75rem',
                    padding: compact ? 10 : 14,
                    border: `2px solid ${isTodayDate ? C.green : count > 0 ? C.blue + '55' : C.dim + '33'}`,
                    borderRadius: 6,
                    background: isTodayDate ? `${C.green}11` : count > 0 ? `${C.blue}${Math.min(15 + count * 3, 50).toString(16).padStart(2, '0')}` : 'transparent',
                    color: item.isCurrentMonth ? (count > 0 ? C.blue : C.text) : C.dim,
                    opacity: item.isCurrentMonth ? 1 : 0.4,
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    aspectRatio: '1',
                  }}
                >
                  <div style={{ fontSize: compact ? '0.75rem' : '0.9rem', fontWeight: 700 }}>
                    {item.date.getDate()}
                  </div>
                  {count > 0 && (
                    <div style={{ fontSize: compact ? '0.5rem' : '0.55rem', opacity: 0.8 }}>
                      {count}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          <div style={{ marginTop:16, display:'flex', gap:16, flexWrap:'wrap', fontSize:'0.55rem', color: C.text, opacity:0.7 }}>
            <span>Number shows total reservations across all lanes</span>
            <span>Click a day to view detailed timeline</span>
          </div>
        </div>
      );
    };

    return (
      <div ref={tlRef} style={{ paddingBottom:12 }}>
        {compact ? (
          <select
            value={timelineViewMode}
            onChange={e => setTimelineViewMode(e.target.value)}
            style={{
              fontFamily: F.mono,
              fontSize: '0.75rem',
              padding: '8px 12px',
              border: `1.5px solid ${C.blue}55`,
              borderRadius: 6,
              background: C.card,
              color: C.text,
              width: '100%',
              marginBottom: 12,
            }}
          >
            <option value="hour">Hour View</option>
            <option value="day">Day View</option>
            <option value="week">Week View</option>
            <option value="month">Month View</option>
          </select>
        ) : (
          <div style={{ display:'flex', gap: 8, marginBottom:12, flexWrap:'wrap' }}>
            <Btn color={C.blue} active={timelineViewMode === 'hour'} onClick={() => setTimelineViewMode('hour')}>Hour</Btn>
            <Btn color={C.blue} active={timelineViewMode === 'day'} onClick={() => setTimelineViewMode('day')}>Day</Btn>
            <Btn color={C.blue} active={timelineViewMode === 'week'} onClick={() => setTimelineViewMode('week')}>Week</Btn>
            <Btn color={C.blue} active={timelineViewMode === 'month'} onClick={() => setTimelineViewMode('month')}>Month</Btn>
          </div>
        )}
        {timelineViewMode === 'hour' && renderHourView()}
        {timelineViewMode === 'day' && renderDayView()}
        {timelineViewMode === 'week' && renderWeekView()}
        {timelineViewMode === 'month' && renderMonthView()}
      </div>
    );
  };

  const ReservationModal = ({ reservation, onClose }) => {
    if (!reservation) return null;
    const [localConfirm, setLocalConfirm] = useState(null);
    const [changingLane, setChangingLane] = useState(false);
    const [selectedNewLane, setSelectedNewLane] = useState(null);

    // Calculate available lanes for the reservation time
    const getAvailableLanes = () => {
      if (!reservation) return [];
      const resDate = reservation.date || todayStr;
      const resStart = tn(reservation.start);
      const resEnd = tn(reservation.end);

      return LANES.filter(lane => {
        // Skip current lane
        if (lane === reservation.lane) return false;

        // Check maintenance
        if (maint[lane]) return false;

        // Check walk-ins on same date
        if (resDate === todayStr && getWalk(lane)) return false;

        // Check reservation conflicts
        const hasConflict = res.some(r => {
          if (r.lane !== lane) return false;
          if ((r.date || todayStr) !== resDate) return false;
          if (r.cancelled) return false;

          const rStart = tn(r.start);
          const rEnd = tn(r.end);
          return (resStart < rEnd && resEnd > rStart);
        });

        return !hasConflict;
      });
    };

    const availableLanes = changingLane ? getAvailableLanes() : [];

    return (
      <div onClick={onClose} style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: compact ? 12 : 24,
      }}>
        <div onClick={e => e.stopPropagation()} style={{
          background: C.cardGradient !== 'none' ? C.cardGradient : C.card,
          border: `2px solid ${C.blue}`,
          borderRadius: 12,
          padding: compact ? 16 : 24,
          maxWidth: 600,
          width: '100%',
          maxHeight: '90vh',
          overflow: 'auto',
          boxShadow: isDark ? `0 0 40px ${C.blue}44` : C.cardShadowHover,
        }}>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: `1px solid ${C.blue}33` }}>
            <h2 style={{ fontFamily: F.head, fontSize: compact ? '1.1rem' : '1.3rem', fontWeight: 700, color: C.blue, margin: 0 }}>
              Reservation Details
            </h2>
            <button onClick={onClose} style={{
              background: 'transparent',
              border: 'none',
              color: C.text,
              fontSize: '1.5rem',
              cursor: 'pointer',
              padding: 0,
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>×</button>
          </div>

          {/* Details */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '1fr 1fr', gap: 16 }}>
              <Info label="LANE" value={reservation.lane} color={C.blue} />
              <Info label="PARTY" value={reservation.party} color={C.blue} />
              <Info label="DATE" value={reservation.date ? formatDateDisplay(reservation.date) : 'Today'} color={C.blue} />
              <Info label="TIME" value={`${fmt(reservation.start)} - ${fmt(reservation.end)}`} color={C.blue} />
              <Info label="GUESTS" value={reservation.guests} color={C.blue} />
              <Info label="TYPE" value={reservation.type === 'hourly' ? `${reservation.hours}h Hourly` : reservation.type === 'per-game' ? `${reservation.games} Games` : 'Reservation'} color={C.blue} />
              {reservation.contact && <Info label="CONTACT" value={reservation.contact} color={C.blue} />}
            </div>

            {/* Status tags */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 8, borderTop: `1px solid ${C.blue}22` }}>
              {reservation.paid && <Tag color={C.green}>PAID</Tag>}
              {!reservation.paid && <Tag color={C.red}>UNPAID</Tag>}
              {reservation.arrived && <Tag color={C.green}>ARRIVED</Tag>}
              {!reservation.arrived && <Tag color={C.yellow}>PENDING ARRIVAL</Tag>}
              {reservation.cancelled && <Tag color={C.red}>CANCELLED</Tag>}
              {reservation.source === 'gcal' && <Tag color={C.purple}>FROM GOOGLE CALENDAR</Tag>}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', paddingTop: 16, borderTop: `1px solid ${C.blue}33` }}>
            {!reservation.arrived && !reservation.cancelled && (
              <Btn color={C.green} onClick={() => {
                dispatch('MARK_ARRIVED', { lane: reservation.lane, start: reservation.start });
                onClose();
              }}>✓ Mark Arrived</Btn>
            )}

            {!reservation.cancelled && (
              <Btn color={reservation.paid ? C.red : C.green} onClick={() => {
                dispatch('TOGGLE_RES_PAID', { lane: reservation.lane, start: reservation.start });
                onClose();
              }}>
                {reservation.paid ? 'Mark Unpaid' : 'Mark Paid'}
              </Btn>
            )}

            {!reservation.cancelled && (
              localConfirm === 'cancel' ? (
                <>
                  <span style={{ fontFamily: F.mono, fontSize: '0.65rem', color: C.pink, display: 'flex', alignItems: 'center' }}>Cancel this reservation?</span>
                  <Btn color={C.pink} onClick={() => {
                    dispatch('CANCEL_RESERVATION', { lane: reservation.lane, start: reservation.start });
                    setLocalConfirm(null);
                    onClose();
                  }}>Yes</Btn>
                  <Btn color={C.dim} onClick={() => setLocalConfirm(null)}>No</Btn>
                </>
              ) : (
                <Btn color={C.orange} onClick={() => setLocalConfirm('cancel')}>Cancel Reservation</Btn>
              )
            )}

            {!reservation.arrived && !reservation.cancelled && (
              localConfirm === 'noshow' ? (
                <>
                  <span style={{ fontFamily: F.mono, fontSize: '0.65rem', color: C.red, display: 'flex', alignItems: 'center' }}>Mark as no-show?</span>
                  <Btn color={C.red} onClick={() => {
                    dispatch('MARK_NO_SHOW', { lane: reservation.lane, start: reservation.start });
                    setLocalConfirm(null);
                    onClose();
                  }}>Yes</Btn>
                  <Btn color={C.dim} onClick={() => setLocalConfirm(null)}>No</Btn>
                </>
              ) : (
                <Btn color={C.red} onClick={() => setLocalConfirm('noshow')}>Mark No Show</Btn>
              )
            )}

            {localConfirm === 'delete' ? (
              <>
                <span style={{ fontFamily: F.mono, fontSize: '0.65rem', color: C.pink, display: 'flex', alignItems: 'center' }}>Delete this reservation?</span>
                <Btn color={C.pink} onClick={() => {
                  dispatch('DELETE_RESERVATION', { lane: reservation.lane, start: reservation.start });
                  setLocalConfirm(null);
                  onClose();
                }}>Yes</Btn>
                <Btn color={C.dim} onClick={() => setLocalConfirm(null)}>No</Btn>
              </>
            ) : (
              <Btn color={C.pink} onClick={() => setLocalConfirm('delete')}>
                <Trash2 size={14} /> Delete
              </Btn>
            )}

            <div style={{ marginLeft: 'auto' }}>
              <Btn color={C.dim} onClick={onClose}>Close</Btn>
            </div>
          </div>

          {/* Lane Change Section */}
          {changingLane && (
            <div style={{
              marginTop: 16,
              paddingTop: 16,
              borderTop: `1px solid ${C.blue}33`,
            }}>
              <div style={{
                fontFamily: F.mono,
                fontSize: '0.7rem',
                color: C.text,
                marginBottom: 12,
                letterSpacing: '0.1em'
              }}>
                SELECT NEW LANE
              </div>

              {availableLanes.length === 0 ? (
                <div style={{
                  fontFamily: F.mono,
                  fontSize: '0.65rem',
                  color: C.red,
                  padding: '12px 16px',
                  background: `${C.red}11`,
                  border: `1px solid ${C.red}44`,
                  borderRadius: 6,
                  marginBottom: 12,
                }}>
                  No available lanes for this time slot
                </div>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 8,
                  marginBottom: 12,
                }}>
                  {availableLanes.map(lane => (
                    <button
                      key={lane}
                      onClick={() => setSelectedNewLane(lane === selectedNewLane ? null : lane)}
                      style={{
                        fontFamily: F.head,
                        fontSize: '0.9rem',
                        fontWeight: 700,
                        padding: compact ? 12 : 16,
                        border: `2px solid ${selectedNewLane === lane ? C.blue : C.blue + '55'}`,
                        background: selectedNewLane === lane ? `${C.blue}22` : 'transparent',
                        color: selectedNewLane === lane ? C.blue : C.text,
                        borderRadius: 6,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        boxShadow: selectedNewLane === lane ? `0 0 12px ${C.blue}33` : 'none',
                      }}
                    >
                      Lane {lane}
                    </button>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                {selectedNewLane && (
                  localConfirm === 'changelane' ? (
                    <>
                      <span style={{ fontFamily: F.mono, fontSize: '0.65rem', color: C.blue, display: 'flex', alignItems: 'center' }}>
                        Move to Lane {selectedNewLane}?
                      </span>
                      <Btn color={C.blue} onClick={() => {
                        dispatch('CHANGE_RESERVATION_LANE', {
                          oldLane: reservation.lane,
                          newLane: selectedNewLane,
                          start: reservation.start,
                          date: reservation.date,
                        });
                        setLocalConfirm(null);
                        setChangingLane(false);
                        setSelectedNewLane(null);
                        onClose();
                      }}>Confirm</Btn>
                      <Btn color={C.dim} onClick={() => setLocalConfirm(null)}>Cancel</Btn>
                    </>
                  ) : (
                    <Btn color={C.blue} onClick={() => setLocalConfirm('changelane')}>
                      Confirm Lane Change
                    </Btn>
                  )
                )}
                <Btn color={C.dim} onClick={() => {
                  setChangingLane(false);
                  setSelectedNewLane(null);
                  setLocalConfirm(null);
                }}>
                  Cancel Lane Change
                </Btn>
              </div>
            </div>
          )}

          {/* Change Lane Button */}
          {!changingLane && !reservation.cancelled && (
            <div style={{
              marginTop: 16,
              paddingTop: 16,
              borderTop: `1px solid ${C.blue}33`,
              display: 'flex',
              justifyContent: 'flex-end',
            }}>
              <Btn color={C.purple} onClick={() => setChangingLane(true)}>
                <ArrowRightLeft size={14} /> Change Lane
              </Btn>
            </div>
          )}
        </div>
      </div>
    );
  };

  const ModeBanner = () => null;

  // ── Loading state ─────────────────────────────────────
  if (!S) {
    return (
      <div style={{ minHeight:'100vh', backgroundColor: C.bg, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:16 }}>
        <div style={{ fontFamily: F.head, fontSize:'1.5rem', fontWeight:700, background: `linear-gradient(135deg, ${C.blue}, ${C.pink})`, backgroundClip:'text', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', color:'transparent' }}>OPENLANE SCHEDULER</div>
        <div style={{ fontFamily: F.mono, fontSize:'0.8rem', color: C.text }}>
          {connected ? 'Loading state...' : 'Connecting to server...'}
        </div>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');`}</style>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────
  return (
    <div style={{ minHeight:'100vh', padding: compact ? 12 : 24, backgroundColor: C.bg }}>
      <div style={{ maxWidth:1400, margin:'0 auto' }}>
        {/* Header */}
        <div style={{ display:'flex', flexDirection: compact ? 'column' : 'row', justifyContent:'space-between', alignItems: compact ? 'stretch' : 'center', gap: compact ? 10 : 0, marginBottom:22, paddingBottom:18 }}>
          <div>
            <h1 key={isDark ? 'd' : 'l'} style={{ fontFamily: F.head, fontSize: compact ? '1.1rem' : '1.5rem', fontWeight:700, letterSpacing:'0.2em', margin:0, background: `linear-gradient(135deg, ${C.blue}, ${C.pink})`, backgroundClip:'text', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', color:'transparent' }}>OPENLANE SCHEDULER</h1>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
            {/* Connection indicator */}
            <div style={{ display:'flex', alignItems:'center', gap:5, fontFamily: F.mono, fontSize:'0.6rem', color: connected ? C.green : C.red }}>
              {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
              {connected ? 'LIVE' : 'OFFLINE'}
            </div>
            {/* View toggle */}
            <div style={{ ...inset(C, { radius: 8, distance: 3 }), display:'flex', gap:6, padding:4 }}>
              {['lanes', 'timeline'].map(v => (
                <button key={v} onClick={() => setView(v)} style={{
                  ...(view === v ? raised(C, { radius: 6, distance: 2 }) : { background:'transparent', border:'none', borderRadius:6 }),
                  fontFamily: F.mono, fontSize:'0.65rem', letterSpacing:'0.08em', padding: compact ? '8px 12px' : '10px 18px', minHeight: compact ? 38 : 44,
                  color: view === v ? C.blue : C.text, cursor:'pointer', textTransform:'uppercase', transition:'all 0.15s' }}>
                  {v === 'lanes' ? 'Lanes' : 'Timeline'}</button>
              ))}
            </div>
            {/* New Reservation / Back to Lanes button */}
            {view === 'new-reservation' ? (
              <Btn color={C.blue} onClick={() => setView('lanes')}>
                <ChevronLeft size={12} /> Back to Lanes
              </Btn>
            ) : (
              <Btn color={C.blue} onClick={() => setView('new-reservation')}>
                <Plus size={12} /> New Reservation
              </Btn>
            )}
            {/* Clear state */}
            {confirmClear ? (
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <span style={{ fontFamily: F.mono, fontSize:'0.65rem', color: C.pink }}>Reset all lanes?</span>
                <Btn color={C.pink} onClick={() => { dispatch('CLEAR_STATE'); setConfirmClear(false); }}>Yes</Btn>
                <Btn color={C.dim} onClick={() => setConfirmClear(false)}>No</Btn>
              </div>
            ) : (
              <Btn color={C.red} onClick={() => setConfirmClear(true)}><Trash2 size={12} /> Clear</Btn>
            )}
            {/* Theme toggle */}
            <button onClick={toggleTheme} title={isDark ? 'Light mode' : 'Dark mode'}
              style={{ ...raised(C, { radius: 19, distance: 3 }),
                cursor:'pointer', color: C.yellow, width:38, height:38, fontSize:'0.95rem',
                display:'flex', alignItems:'center', justifyContent:'center' }}>
              {isDark ? '\u2600' : '\u263E'}
            </button>
            {/* Clock */}
            <div style={{ fontFamily: F.head, color: C.yellow, fontSize: compact ? '1rem' : '1.3rem', fontWeight:700, textShadow: `0 0 10px ${C.yellow}55`, marginLeft: 'auto' }}>
              {now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true })}
            </div>
          </div>
        </div>

        {/* Stats */}
        <div style={{ display:'flex', gap: compact ? 12 : 18, marginBottom:22, padding:'4px', flexWrap:'wrap' }}>
          {[
            { label:'OPEN', val: availCount, color: C.blue },
            { label:'ACTIVE', val: activeCount, color: C.green },
            { label:'UNPAID', val: unpaidCount, color: unpaidCount > 0 ? C.red : C.dim },
            { label:'BOOKED', val: res.length, color: C.pink },
            ...(serviceCallCount > 0 ? [{ label:'CALLS', val: serviceCallCount, color: C.amber }] : []),
            ...(maintCount > 0 ? [{ label:'MAINT', val: maintCount, color: C.maint }] : []),
            ...(Object.keys(groups).length > 0 ? [{ label:'GROUPS', val: Object.keys(groups).length, color: C.purple }] : []),
          ].map(s => (
            <div key={s.label} style={{ ...raised(C, { radius: 8, distance: 3 }), textAlign:'center', padding: compact ? '8px 14px' : '10px 22px', minWidth: compact ? 58 : 76 }}>
              <div style={{ fontFamily: F.head, fontSize: compact ? '1.1rem' : '1.4rem', fontWeight:700, color: s.color, lineHeight:1 }}>{s.val}</div>
              <div style={{ fontFamily: F.mono, fontSize:'0.5rem', color: s.color, letterSpacing:'0.15em', marginTop:4, opacity:0.75 }}>{s.label}</div>
            </div>
          ))}
        </div>

        <ModeBanner />

        {view === 'lanes' ? (
          <div style={{ display:'flex', flexDirection:'column', gap: compact ? 16 : 20 }}>
            {LANES.map(n => <LaneRow key={n} num={n} />)}
          </div>
        ) : view === 'timeline' ? (
          <Timeline />
        ) : view === 'new-reservation' ? (
          <div style={{
            ...raised(C, { radius: 10, distance: 5 }),
            maxWidth: compact ? '100%' : 900,
            margin: '0 auto',
          }}>
            {reservationError && (
              <div style={{
                fontFamily: F.mono,
                fontSize: compact ? '0.7rem' : '0.8rem',
                color: C.red,
                letterSpacing: '0.05em',
                padding: '12px 16px',
                margin: compact ? 16 : 20,
                marginBottom: 0,
                background: `${C.red}11`,
                border: `2px solid ${C.red}`,
                borderRadius: 8,
                boxShadow: isDark ? `0 0 20px ${C.red}22` : C.cardShadow,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontWeight: 700,
                    marginBottom: 4,
                    letterSpacing: '0.1em',
                    fontSize: compact ? '0.65rem' : '0.75rem'
                  }}>
                    SCHEDULING CONFLICT
                  </div>
                  <div>{reservationError.message}</div>
                  <div style={{
                    marginTop: 8,
                    fontSize: compact ? '0.6rem' : '0.65rem',
                    opacity: 0.8
                  }}>
                    Please select a different time or lane and try again.
                  </div>
                </div>
                <button
                  onClick={() => setReservationError(null)}
                  style={{
                    background: 'transparent',
                    border: `1.5px solid ${C.red}`,
                    color: C.red,
                    borderRadius: 4,
                    padding: '6px 12px',
                    cursor: 'pointer',
                    fontFamily: F.mono,
                    fontSize: '0.65rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    flexShrink: 0,
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => e.target.style.background = `${C.red}22`}
                  onMouseLeave={e => e.target.style.background = 'transparent'}
                >
                  Dismiss
                </button>
              </div>
            )}
            <ReservationForm
              onSubmit={handleCreateReservation}
              onCancel={() => {
                setView('lanes');
                setReservationError(null);
              }}
              reservations={res}
              maintenance={maint}
              walkIns={walks}
              serviceCalls={serviceCalls}
            />
          </div>
        ) : null}

        {/* Reservation Modal */}
        <ReservationModal reservation={selectedReservation} onClose={() => setSelectedReservation(null)} />
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');
        @keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
        @keyframes serviceCallPulse {
          0%, 100% { box-shadow: 0 0 8px rgba(var(--ll-amber-rgb),0.15); background-color: var(--ll-card); }
          50% { box-shadow: 0 0 28px rgba(var(--ll-amber-rgb),0.35); background-color: rgba(var(--ll-amber-rgb),0.06); }
        }
        @keyframes laneNumberPulse {
          0%, 100% {
            transform: scale(1);
            text-shadow: 0 0 12px rgba(var(--ll-amber-rgb),0.4), 0 0 24px rgba(var(--ll-amber-rgb),0.2);
          }
          50% {
            transform: scale(1.15);
            text-shadow: 0 0 20px rgba(var(--ll-amber-rgb),0.8), 0 0 40px rgba(var(--ll-amber-rgb),0.4), 0 0 60px rgba(var(--ll-amber-rgb),0.2);
          }
        }
        .service-call-pulse { animation: serviceCallPulse 2.5s ease-in-out infinite; }
        .lane-number-pulse { animation: laneNumberPulse 1.5s ease-in-out infinite; }
      `}</style>
    </div>
  );
}
