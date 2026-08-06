import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Wifi, WifiOff, Volume2, VolumeX } from 'lucide-react';
import { F, LANES, EMBEDDED, useSocket, useCompact, useDesktop } from './shared';
import { useColors, useTheme, raised, inset } from './theme';

export default function Display() {
  const { connected, state: S } = useSocket();
  const compact = useCompact();
  const desktop = useDesktop();
  const C = useColors();
  const { isDark } = useTheme();
  const [now, setNow] = useState(new Date());
  const [muted, setMuted] = useState(true);
  const [showTimeline, setShowTimeline] = useState(false);
  const audioCtxRef = useRef(null);

  useEffect(() => { const t = setInterval(() => setNow(new Date()), 10000); return () => clearInterval(t); }, []);

  const res = S?.reservations || [];
  const walks = S?.walkIns || [];
  const maint = S?.maintenance || {};
  const serviceCalls = S?.serviceCalls || {};

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

  const expanded = desktop && !showTimeline;
  const Tag = ({ children, color }) => (<span style={{ fontFamily: F.mono, fontSize: expanded ? '1rem' : '0.65rem', letterSpacing:'0.1em', color, padding: expanded ? '6px 14px' : '4px 10px', borderRadius:4, background: `${color}15`, fontWeight:700 }}>{children}</span>);
  const Info = ({ label, value, color = C.text }) => (<div style={{ marginRight: compact ? 10 : expanded ? 28 : 20 }}><div style={{ fontFamily: F.mono, fontSize: expanded ? '0.7rem' : '0.5rem', color: C.text, letterSpacing:'0.12em', marginBottom: expanded ? 4 : 2, opacity:0.7 }}>{label}</div><div style={{ fontFamily: F.head, fontSize: expanded ? '1.3rem' : compact ? '0.72rem' : '0.8rem', color, fontWeight:700 }}>{value}</div></div>);

  const availCount = LANES.filter(l => !maint[l] && !curRes(l) && !getWalk(l) && !soonRes(l)).length;
  const activeCount = LANES.filter(l => !maint[l] && (curRes(l) || getWalk(l))).length;
  const serviceCallCount = LANES.filter(l => serviceCalls[l]).length;
  const unackedCount = LANES.filter(l => serviceCalls[l] && !serviceCalls[l].acked).length;
  const prevBallCallCount = useRef(0);
  const prevActiveCount = useRef(activeCount);
  const walkLaneKey = walks.map(w => w.lane).sort().join(',');
  const prevWalkLaneKey = useRef(walkLaneKey);

  function getCtx() {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
    return audioCtxRef.current;
  }

  function playBallCallTone() {
    const ctx = getCtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.8);
    gain.connect(ctx.destination);
    [466, 415, 349].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.22);
    });
  }

  function playBallCallClearedTone() {
    const ctx = getCtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.04, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.04, ctx.currentTime + 0.55);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.75);
    gain.connect(ctx.destination);
    [523, 659, 784, 1047].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.09);
      osc.stop(ctx.currentTime + i * 0.09 + 0.12);
    });
    const last = ctx.createOscillator();
    last.type = 'square';
    last.frequency.value = 1319;
    last.connect(gain);
    last.start(ctx.currentTime + 0.42);
    last.stop(ctx.currentTime + 0.7);
  }

  function playActiveTone() {
    const ctx = getCtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.07, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
    gain.connect(ctx.destination);
    [523, 659, 784].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.18);
    });
  }

  function playCloseTone() {
    const ctx = getCtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.06, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
    gain.connect(ctx.destination);
    [523, 440].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.25);
    });
  }

  function playMoveTone() {
    const ctx = getCtx();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.07, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
    gain.connect(ctx.destination);
    [392, 523].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + i * 0.1);
      osc.stop(ctx.currentTime + i * 0.1 + 0.15);
    });
  }

  useEffect(() => {
    if (!muted && serviceCallCount > prevBallCallCount.current) playBallCallTone();
    if (!muted && serviceCallCount < prevBallCallCount.current) playBallCallClearedTone();
    prevBallCallCount.current = serviceCallCount;
  }, [serviceCallCount]);

  useEffect(() => {
    if (!muted && activeCount > prevActiveCount.current) playActiveTone();
    if (!muted && activeCount < prevActiveCount.current) playCloseTone();
    prevActiveCount.current = activeCount;
  }, [activeCount]);

  useEffect(() => {
    if (!muted && prevWalkLaneKey.current && walkLaneKey !== prevWalkLaneKey.current && walks.length === prevWalkLaneKey.current.split(',').filter(Boolean).length) playMoveTone();
    prevWalkLaneKey.current = walkLaneKey;
  }, [walkLaneKey]);

  useEffect(() => {
    if (muted || !unackedCount) return;
    const t = setInterval(playBallCallTone, 5000);
    return () => clearInterval(t);
  }, [muted, unackedCount]);

  // ── Lane Row (read-only, no payment/grouping) ──────────
  const LaneRow = ({ num }) => {
    const im = maint[num];
    const r = !im ? curRes(num) : null;
    const w = !im ? getWalk(num) : null;
    const up = !im ? upcoming(num) : null;
    const soon = !im ? soonRes(num) : null;
    const active = !!(r || w);
    const hasBallCall = !!serviceCalls[num];
    const serviceCallAcked = hasBallCall && serviceCalls[num].acked;

    let accent = C.blue, status = 'OPEN';
    if (im) { accent = C.maint; status = 'MAINTENANCE'; }
    else if (active) { accent = C.green; status = 'ACTIVE'; }
    else if (r && !w && !r.arrived) { accent = C.yellow; status = 'PENDING ARRIVAL'; }

    // Override accent for ball calls
    if (hasBallCall) {
      accent = serviceCallAcked ? C.serviceAck : C.amber;
    }

    return (
      <div className={hasBallCall && !serviceCallAcked ? 'ball-call-pulse' : undefined} style={{
        ...(im
          ? inset(C, { radius: 8, distance: 3 })
          : raised(C, { radius: 8, distance: 4, accent: hasBallCall ? (serviceCallAcked ? C.serviceAck : C.amber) : null })),
        padding: expanded ? '16px 24px' : compact ? '10px 14px' : '8px 16px', position:'relative', overflow:'hidden', opacity: im ? 0.6 : 1, transition:'opacity 0.2s',
        display:'flex', flexDirection:'column', justifyContent:'center',
      }}>
        {hasBallCall && (<div style={{ position:'absolute', inset:0, pointerEvents:'none', zIndex:1,
          backgroundImage: serviceCallAcked
            ? 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(var(--ll-serviceAck-rgb),0.06) 2px, rgba(var(--ll-serviceAck-rgb),0.06) 4px)'
            : 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(var(--ll-amber-rgb),0.08) 2px, rgba(var(--ll-amber-rgb),0.08) 4px)',
          backgroundSize:'100% 4px',
        }} />)}
        <div style={{ display:'flex', alignItems:'center' }}>
          <div style={{ display:'flex', alignItems:'center', gap: expanded ? 24 : compact ? 10 : 16, flex:1, minWidth:0, flexWrap: compact ? 'wrap' : undefined }}>
            <span className={hasBallCall && !serviceCallAcked ? 'lane-number-pulse' : undefined} style={{ fontFamily: F.head, fontSize: expanded ? '2.4rem' : '1.6rem', fontWeight:900, color: accent, textShadow: isDark ? `0 0 ${expanded ? '16px' : '12px'} ${accent}55` : 'none', letterSpacing:'0.08em', minWidth: expanded ? 56 : 40 }}>{num}</span>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap: expanded ? 6 : 4 }}>
              {hasBallCall && (<Tag color={serviceCallAcked ? C.serviceAck : C.amber}>{serviceCallAcked ? 'SERVICE CALL — ACK' : 'SERVICE CALL'}</Tag>)}
              <Tag color={accent}>{status}</Tag>
            </div>

            {w && (
              <div style={{ display:'flex', alignItems:'center', gap: expanded ? 24 : compact ? 10 : 16, flexWrap:'wrap' }}>
                <Info label="OPENED" value={fmt(walkHM(w.openedAt))} color={accent} />
                <Info label="EST. CLOSE" value={estClose(w.openedAt, walkMins(w), serviceCallMins(w))} color={C.yellow} />
                <Info label="ELAPSED" value={elapsed(w.openedAt)} color={accent} />
                <Info label="BOWLERS" value={w.bowlers} color={accent} />
              </div>
            )}
            {r && !w && (
              <div style={{ display:'flex', alignItems:'center', gap: expanded ? 24 : compact ? 10 : 16, flexWrap:'wrap' }}>
                <Info label="PARTY" value={r.party} color={accent} />
                <Info label="GUESTS" value={r.guests} color={accent} />
                <Info label="TIME" value={`${fmt(r.start)}–${fmt(r.end)}`} color={accent} />
              </div>
            )}
            {!active && !im && !up && <span style={{ fontFamily: F.mono, fontSize: expanded ? '0.9rem' : '0.65rem', color: C.text, opacity:0.4 }}>No upcoming reservations</span>}
            {im && <span style={{ fontFamily: F.mono, fontSize: expanded ? '1.1rem' : '0.75rem', color: C.maint, opacity:0.6 }}>Lane offline</span>}
          </div>
        </div>
        {/* Next upcoming reservation notification */}
        {up && !im && (
          <div style={{
            display:'flex',
            alignItems:'center',
            gap: expanded ? 12 : compact ? 6 : 8,
            marginTop: expanded ? 12 : 8,
            padding: expanded ? '10px 16px' : compact ? '6px 10px' : '8px 12px',
            borderRadius:6,
            background: `${C.pink}10`,
            border: `1px solid ${C.pink}33`,
            flexWrap:'wrap'
          }}>
            <span style={{ fontFamily: F.mono, fontSize: expanded ? '0.75rem' : compact ? '0.5rem' : '0.6rem', letterSpacing:'0.1em', color: C.pink, fontWeight:700, whiteSpace:'nowrap' }}>
              UPCOMING
            </span>
            <span style={{ fontFamily: F.mono, fontSize: expanded ? '0.85rem' : compact ? '0.6rem' : '0.7rem', color: C.pink, fontWeight:600 }}>
              {up.party}
            </span>
            <span style={{ fontFamily: F.mono, fontSize: expanded ? '0.75rem' : compact ? '0.55rem' : '0.6rem', color: C.pink, opacity:0.8 }}>
              {fmt(up.start)} • {up.guests} guests
            </span>
            {up.cancelled && <Tag color={C.red}>CANCELLED</Tag>}
          </div>
        )}
        {/* Additional upcoming reservations within the hour */}
        {upcomingHour(num).filter(u => u !== r && u !== up).map(u => (
          <div key={u.start} style={{ display:'flex', alignItems:'center', gap: expanded ? 20 : 12, marginTop:8, padding: expanded ? '10px 16px' : '8px 12px', borderRadius:6, background: `${C.pink}10`, border: `1px solid ${C.pink}22` }}>
            <span style={{ fontFamily: F.mono, fontSize: expanded ? '0.85rem' : '0.6rem', letterSpacing:'0.1em', color: C.pink, fontWeight:700 }}>UPCOMING</span>
            <Info label="PARTY" value={u.party} color={C.pink} />
            <Info label="TIME" value={`${fmt(u.start)}–${fmt(u.end)}`} color={C.pink} />
            <Info label="GUESTS" value={u.guests} color={C.pink} />
          </div>
        ))}
      </div>
    );
  };

  // ── Timeline (no payment/grouping) ─────────────────────
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
      res.filter(r => r.lane === laneNum && isToday(r)).forEach(r => {
        const s = tn(r.start), e = tn(r.end), act = nn >= s && nn < e;
        const left = Math.max(0, (s - startHr) * pxPerHr);
        const right = Math.min(totalW, (e - startHr) * pxPerHr);
        if (right > 0 && left < totalW) blocks.push({ left, width: Math.max(10, right - left), label: r.party, sub: `${fmt(r.start)}–${fmt(r.end)}`, color: act ? C.green : C.pink });
      });
      const w = getWalk(laneNum);
      if (w) { const wHM = walkHM(w.openedAt); const bcH = serviceCallMins(w) / 60; const s = tn(wHM), e = s + walkMins(w) / 60 + bcH;
        const left = Math.max(0, (s - startHr) * pxPerHr);
        const right = Math.min(totalW, (Math.max(e, nn + 0.1) - startHr) * pxPerHr);
        if (right > 0 && left < totalW) blocks.push({ left, width: Math.max(10, right - left), label: `Walk-in · ${w.bowlers}`, sub: `${fmt(wHM)}–~${estClose(w.openedAt, walkMins(w), serviceCallMins(w))}`, color: C.green });
      }
      if (maint[laneNum]) blocks.push({ left:0, width: totalW, label:'MAINTENANCE', sub:'', color: C.maint });
      return blocks;
    };
    return (
      <div ref={tlRef} style={{ ...raised(C, { radius: 10, distance: 4 }), paddingBottom:12, padding:16 }}>
        <div style={{ position:'relative' }}>
          <div style={{ display:'flex', marginLeft: labelMargin, marginBottom:6 }}>
            {hourMarks.map(h => (<div key={h} style={{ position:'absolute', left: labelMargin + (h - startHr) * pxPerHr, fontFamily: F.mono, fontSize:'0.6rem', color: C.text, opacity:0.5 }}>{fmtHr(h)}</div>))}
          </div>
          <div style={{ marginTop: 16 }}>
          {LANES.map(laneNum => {
            const blocks = getBlocks(laneNum); const im = maint[laneNum];
            let la = C.blue; const w2 = getWalk(laneNum), r2 = curRes(laneNum);
            if (im) la = C.maint; else if (w2 || r2) la = C.green;
            return (
              <div key={laneNum} style={{ display:'flex', alignItems:'center', marginBottom:4, position:'relative' }}>
                <div style={{ width: compact ? 36 : 62, fontFamily: F.head, fontSize:'0.85rem', fontWeight:700, color: la, textShadow: `0 0 8px ${la}33`, textAlign:'center', flexShrink:0 }}>{laneNum}</div>
                <div style={{ ...inset(C, { radius: 4, distance: 2 }), position:'relative', height: compact ? 36 : 48, flex:1, overflow:'hidden' }}>
                  {hourMarks.map(h => (<div key={h} style={{ position:'absolute', left: (h - startHr) * pxPerHr, top:0, bottom:0, borderLeft: `1px solid ${C.dim}44` }} />))}
                  {blocks.map((b, i) => (
                    <div key={i} style={{ position:'absolute', top:4, bottom:4, left: b.left, width: b.width, background: `${b.color}25`, border: `1.5px solid ${b.color}66`, borderRadius:4, display:'flex', alignItems:'center', padding:'0 8px', overflow:'hidden' }}>
                      <span style={{ fontFamily: F.mono, fontSize:'0.55rem', color: b.color, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{b.label}{b.sub ? ` · ${b.sub}` : ''}</span>
                    </div>
                  ))}
                  {nowPx > 0 && nowPx < totalW && (<div style={{ position:'absolute', top:0, bottom:0, left: nowPx, width:2, background: C.yellow, boxShadow: `0 0 8px ${C.yellow}88`, zIndex:5 }} />)}
                </div>
              </div>
            );
          })}
          </div>
          <div style={{ display:'flex', gap: compact ? 10 : 16, marginTop:12, marginLeft: labelMargin, flexWrap:'wrap' }}>
            {[{ l:'Active', c: C.green }, { l:'Reserved', c: C.pink }, { l:'Maintenance', c: C.maint }, { l:'Now', c: C.yellow }].map(x => (
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

  // ── Loading ────────────────────────────────────────────
  if (!S) {
    return (
      <div style={{ minHeight:'100vh', backgroundColor: C.bg, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:16 }}>
        <div style={{ fontFamily: F.head, fontSize:'1.5rem', fontWeight:700, background: `linear-gradient(135deg, ${C.blue}, ${C.pink})`, backgroundClip:'text', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', color:'transparent' }}>LUNAR LANES</div>
        <div style={{ fontFamily: F.mono, fontSize:'0.8rem', color: C.text }}>
          {connected ? 'Loading...' : 'Connecting...'}
        </div>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');`}</style>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────
  return (
    <div style={{ height: showTimeline ? undefined : '100vh', minHeight:'100vh', display:'flex', flexDirection:'column', padding: compact ? 12 : 16, backgroundColor: C.bg, overflow: showTimeline ? undefined : 'hidden', boxSizing:'border-box' }}>
      <div style={{ maxWidth:1400, margin:'0 auto', width:'100%', display:'flex', flexDirection:'column', flex:1, minHeight:0 }}>
        {/* Header */}
        <div style={{ display:'flex', flexDirection: compact ? 'column' : 'row', justifyContent:'space-between', alignItems: compact ? 'stretch' : 'center', gap: compact ? 10 : 0, marginBottom:12, paddingBottom:10, flexShrink:0 }}>
          <h1 key={isDark ? 'd' : 'l'} style={{ fontFamily: F.head, fontSize: compact ? '1.1rem' : '1.3rem', fontWeight:700, letterSpacing:'0.2em', margin:0, background: `linear-gradient(135deg, ${C.blue}, ${C.pink})`, backgroundClip:'text', WebkitBackgroundClip:'text', WebkitTextFillColor:'transparent', color:'transparent' }}>LUNAR LANES</h1>
          <div style={{ display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
            {!EMBEDDED && <button onClick={() => { if (muted) { const ctx = getCtx(); if (ctx.state === 'suspended') ctx.resume(); } setMuted(m => !m); }} title={muted ? 'Unmute ball call alerts' : 'Mute ball call alerts'} style={{
              ...(muted ? raised(C, { radius: 8, distance: 3 }) : inset(C, { radius: 8, distance: 2, accent: C.amber })), cursor:'pointer',
              color: muted ? C.dim : C.amber, display:'flex', alignItems:'center', justifyContent:'center',
              width:34, height:34, padding:0,
            }}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</button>}
            <div style={{ display:'flex', alignItems:'center', gap:5, fontFamily: F.mono, fontSize:'0.6rem', color: connected ? C.green : C.red }}>
              {connected ? <Wifi size={12} /> : <WifiOff size={12} />}
              {connected ? 'LIVE' : 'OFFLINE'}
            </div>
            <div style={{ fontFamily: F.head, color: C.yellow, fontSize: compact ? '1rem' : '1.3rem', fontWeight:700, textShadow: `0 0 10px ${C.yellow}55` }}>
              {now.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:true })}
            </div>
          </div>
        </div>

        {/* Stats */}
        <div style={{ display:'flex', gap: compact ? 12 : 16, marginBottom:14, padding:'4px', flexWrap:'wrap', flexShrink:0 }}>
          {[
            { label:'OPEN', val: availCount, color: C.blue },
            { label:'ACTIVE', val: activeCount, color: C.green },
            { label:'BOOKED', val: res.length, color: C.pink },
          ].map(s => (
            <div key={s.label} style={{ ...raised(C, { radius: 8, distance: 3 }), textAlign:'center', padding: compact ? '8px 14px' : '8px 20px', minWidth: compact ? 58 : 72 }}>
              <div style={{ fontFamily: F.head, fontSize: compact ? '1.1rem' : '1.4rem', fontWeight:700, color: s.color, lineHeight:1 }}>{s.val}</div>
              <div style={{ fontFamily: F.mono, fontSize:'0.5rem', color: s.color, letterSpacing:'0.15em', marginTop:3, opacity:0.75 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Lanes — fills remaining space */}
        <div style={{ display:'grid', gridTemplateColumns: desktop ? '1fr 1fr' : '1fr', gridTemplateRows: `repeat(${desktop ? 4 : 8}, 1fr)`, gap: desktop ? 14 : 10, flex:1, minHeight:0 }}>
          {LANES.map(n => <LaneRow key={n} num={n} />)}
        </div>

        {/* Timeline toggle + collapsible panel */}
        <button onClick={() => setShowTimeline(v => !v)} style={{
          ...(showTimeline ? inset(C, { radius: 6, distance: 2 }) : raised(C, { radius: 6, distance: 3 })),
          width:'100%', marginTop:12, padding:'8px 0',
          cursor:'pointer', fontFamily: F.mono, fontSize:'0.6rem', letterSpacing:'0.1em', color: C.text,
          display:'flex', alignItems:'center', justifyContent:'center', gap:6, flexShrink:0,
        }}>
          <span style={{ transform: showTimeline ? 'rotate(180deg)' : 'rotate(0deg)', transition:'transform 0.2s', display:'inline-block' }}>&#9650;</span>
          {showTimeline ? 'HIDE TIMELINE' : 'SHOW TIMELINE'}
        </button>
        {showTimeline && (
          <div style={{ marginTop:8, flexShrink:0 }}>
            <Timeline />
          </div>
        )}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');
        @keyframes serviceCallPulse {
          0%, 49% {
            box-shadow: 0 0 30px rgba(var(--ll-amber-rgb),0.6), 0 0 50px rgba(var(--ll-amber-rgb),0.3);
            background-color: rgba(var(--ll-amber-rgb),0.12);
            border-color: rgba(var(--ll-amber-rgb),1);
          }
          50%, 100% {
            box-shadow: 0 0 5px rgba(var(--ll-amber-rgb),0.2);
            background-color: var(--ll-card);
            border-color: rgba(var(--ll-amber-rgb),0.4);
          }
        }
        @keyframes laneNumberPulse {
          0%, 49% {
            transform: scale(1.15);
            text-shadow: 0 0 30px rgba(var(--ll-amber-rgb),1), 0 0 50px rgba(var(--ll-amber-rgb),0.6), 0 0 70px rgba(var(--ll-amber-rgb),0.3);
          }
          50%, 100% {
            transform: scale(1);
            text-shadow: 0 0 12px rgba(var(--ll-amber-rgb),0.4), 0 0 24px rgba(var(--ll-amber-rgb),0.2);
          }
        }
        .ball-call-pulse { animation: serviceCallPulse 0.5s steps(2, jump-none) infinite; }
        .lane-number-pulse { animation: laneNumberPulse 0.5s steps(2, jump-none) infinite; }
      `}</style>
    </div>
  );
}
