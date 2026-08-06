import { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';

export const BACKEND_URL = window.__LUNAR_BACKEND_URL__ || import.meta.env.VITE_BACKEND_URL || `http://${window.location.hostname}:3001`;

export const C = {
  bg:'#0a0e27', card:'rgba(10,14,39,0.95)',
  green:'#39ff14', pink:'#ff006e', blue:'#00b4ff',
  red:'#ff2a2a', maint:'#6b7ea6', orange:'#ff8c00', purple:'#a855f7',
  yellow:'#ffbe0b', amber:'#ff9500', dim:'#2a3060', text:'#8892b8',
  serviceAck:'#e0f0ff',
  mechText:'#e5e7eb', mechTextMuted:'#9ca3af', mechTextDim:'#6b7280',
  mechBtnBg:'rgba(255,255,255,0.05)', mechBtnBgMed:'rgba(255,255,255,0.08)',
  mechBtnBgActive:'rgba(255,255,255,0.15)', mechBtnBgDisabled:'rgba(255,255,255,0.03)',
  mechBtnBorder:'rgba(255,255,255,0.2)', mechBtnBorderBright:'rgba(255,255,255,0.3)',
  mechBtnBorderDim:'rgba(255,255,255,0.1)',
  overlayBg:'rgba(0,0,0,0.85)',
  cardShadow:'none', cardShadowHover:'none',
  cardGradient:'none', headerGradient:'none',
};
export const F = { head:'"Orbitron","Courier New",monospace', mono:'"Share Tech Mono","Courier New",monospace' };
export const LANES = [1,2,3,4,5,6,7,8];
export const HOURS = ['9a','10a','11a','12p','1p','2p','3p','4p','5p','6p','7p','8p','9p','10p','11p'];

export const EMBEDDED = window.self !== window.top;

const compactQuery = typeof window !== 'undefined' ? window.matchMedia('(max-width: 639px)') : null;
let compactSnapshot = compactQuery ? compactQuery.matches : false;
if (compactQuery) compactQuery.addEventListener('change', e => { compactSnapshot = e.matches; });
export function useCompact() {
  return useSyncExternalStore(
    cb => { if (!compactQuery) return () => {}; compactQuery.addEventListener('change', cb); return () => compactQuery.removeEventListener('change', cb); },
    () => compactSnapshot,
  );
}

const desktopQuery = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null;
let desktopSnapshot = desktopQuery ? desktopQuery.matches : false;
if (desktopQuery) desktopQuery.addEventListener('change', e => { desktopSnapshot = e.matches; });
export function useDesktop() {
  return useSyncExternalStore(
    cb => { if (!desktopQuery) return () => {}; desktopQuery.addEventListener('change', cb); return () => desktopQuery.removeEventListener('change', cb); },
    () => desktopSnapshot,
  );
}

// Date utility functions
export const getWeekStart = (date) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = -day; // Sunday = 0, so no change; Monday = 1, go back 1 day, etc.
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
};

export const formatDateYYYYMMDD = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const isToday = (date) => {
  const today = new Date();
  const d = new Date(date);
  return d.toDateString() === today.toDateString();
};

export const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

export const formatDateDisplay = (date) => {
  // If date is a string in YYYY-MM-DD format, parse as local date
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [year, month, day] = date.split('-').map(Number);
    const localDate = new Date(year, month - 1, day);
    return localDate.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }
  // Otherwise use the date as-is
  return new Date(date).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};

// State reducer for delta updates
function stateReducer(state, update) {
  // Initialize empty state if null
  if (!state) {
    state = {
      reservations: [],
      walkIns: [],
      maintenance: {},
      groups: {},
      serviceCalls: {},
      excludedEvents: [],
      nextGroupId: 1
    };
  }

  switch (update.type) {
    case 'WALK_IN_OPENED':
      return {
        ...state,
        walkIns: [...state.walkIns.filter(w => w.lane !== update.data.lane), update.data.walkIn]
      };

    case 'WALK_IN_CLOSED':
      return {
        ...state,
        walkIns: state.walkIns.filter(w => w.lane !== update.data.lane)
      };

    case 'WALK_IN_UPDATED':
      return {
        ...state,
        walkIns: state.walkIns.map(w => w.lane === update.data.lane ? update.data.walkIn : w)
      };

    case 'MAINTENANCE_TOGGLED':
      return {
        ...state,
        maintenance: { ...state.maintenance, [update.data.lane]: update.data.enabled }
      };

    case 'SERVICE_CALL_CREATED':
      return {
        ...state,
        serviceCalls: {
          ...state.serviceCalls,
          [update.data.lane]: { start: Date.now(), acked: false, origin: update.data.origin || 'kiosk' }
        }
      };

    case 'SERVICE_CALL_ACKED':
      return {
        ...state,
        serviceCalls: {
          ...state.serviceCalls,
          [update.data.lane]: { ...state.serviceCalls[update.data.lane], acked: true }
        }
      };

    case 'SERVICE_CALL_RESOLVED':
      const { [update.data.lane]: removed, ...remaining } = state.serviceCalls;
      return { ...state, serviceCalls: remaining };

    case 'RESERVATIONS_CREATED':
      return {
        ...state,
        reservations: [...state.reservations, ...update.data.reservations]
      };

    case 'RESERVATION_DELETED':
      return {
        ...state,
        reservations: state.reservations.filter(r =>
          !(r.lane === update.data.lane && r.start === update.data.start && r.date === update.data.date)
        )
      };

    case 'RESERVATION_CANCELLED':
      return {
        ...state,
        reservations: state.reservations.map(r =>
          (r.lane === update.data.lane && r.start === update.data.start && r.date === update.data.date)
            ? { ...r, cancelled: true }
            : r
        )
      };

    case 'RESERVATION_UPDATED':
      return {
        ...state,
        reservations: state.reservations.map(r =>
          (r.lane === update.data.lane && r.start === update.data.start && r.date === update.data.date)
            ? { ...r, ...update.data }
            : r
        )
      };

    case 'GROUP_CREATED':
      return {
        ...state,
        groups: { ...state.groups, [update.data.groupId]: { lanes: update.data.lanes } }
      };

    case 'GROUP_REMOVED':
      const { [update.data.groupId]: removedGroup, ...remainingGroups } = state.groups;
      return { ...state, groups: remainingGroups };

    case 'EVENT_EXCLUDED':
      return {
        ...state,
        excludedEvents: [...state.excludedEvents, update.data.eventId]
      };

    default:
      return state;
  }
}

export function useSocket() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [serverState, setServerState] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [lastReservation, setLastReservation] = useState(null);

  useEffect(() => {
    if (EMBEDDED) {
      let alive = true;
      async function poll() {
        while (alive) {
          try {
            const res = await fetch(`${BACKEND_URL}/api/state`);
            if (res.ok) { setServerState(await res.json()); setConnected(true); }
            else { setConnected(false); }
          } catch { setConnected(false); }
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      poll();
      return () => { alive = false; };
    }

    const socket = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('state', (s) => setServerState(s));

    // Handle delta updates for better performance
    socket.on('stateUpdate', (update) => {
      setServerState(prev => stateReducer(prev, update));
    });

    socket.on('error', (error) => setLastError(error));
    socket.on('reservationCreated', (data) => setLastReservation(data));

    return () => { socket.disconnect(); };
  }, []);

  const dispatch = useCallback((type, payload = {}) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('action', { type, ...payload });
    }
  }, []);

  const clearError = useCallback(() => setLastError(null), []);
  const clearReservation = useCallback(() => setLastReservation(null), []);

  return {
    connected,
    state: serverState,
    dispatch,
    lastError,
    lastReservation,
    clearError,
    clearReservation
  };
}
