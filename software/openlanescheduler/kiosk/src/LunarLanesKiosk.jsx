import React, { useState, useEffect } from 'react';
import { useSocket, KIOSK_LANES, F } from './shared';
import { useColors } from './theme';
import BootScreen from './components/BootScreen';
import KioskHeader from './components/KioskHeader';
import LaneColumn from './components/LaneColumn';
import ConfirmModal from './components/ConfirmModal';
import NotificationStack from './components/NotificationStack';

const GRACE_MS = 5 * 60 * 1000; // 5 minute grace period

const LunarLanesKiosk = () => {
  const C = useColors();
  const { connected, state, dispatch } = useSocket();
  const [activePanel, setActivePanel] = useState({ panel: 'home', lane: null });
  const [bootComplete, setBootComplete] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [pinsetterCycling, setPinsetterCycling] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(null);
  const [now, setNow] = useState(Date.now());

  // Get configured lanes for this kiosk
  const myLanes = KIOSK_LANES;

  // Update time every second for countdown
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Boot sequence
  useEffect(() => {
    const timer = setTimeout(() => setBootComplete(true), 2000);
    return () => clearTimeout(timer);
  }, []);

  // Helper to get walk-in for a lane
  const getWalkIn = (laneNum) => {
    const walkIns = state?.walkIns || [];
    return walkIns.find(w => w.lane === laneNum);
  };

  // Compute the session end time (ms) for an hourly walk-in, or null if not hourly.
  const getSessionEnd = (laneNum) => {
    const walkIn = getWalkIn(laneNum);
    if (!walkIn || walkIn.type !== 'hourly') return null;

    const hours = walkIn.hours || 1;
    let totalServiceCallMs = walkIn.serviceCallMs || 0;
    const activeServiceCall = state?.serviceCalls?.[laneNum];
    if (activeServiceCall) {
      totalServiceCallMs += (now - activeServiceCall.start);
    }
    return walkIn.openedAt + (hours * 60 * 60 * 1000) + totalServiceCallMs + GRACE_MS;
  };

  // Helper to check if time has expired
  const isTimeExpired = (laneNum) => {
    const endTime = getSessionEnd(laneNum);
    return endTime !== null && endTime - now <= 0;
  };

  // Helper to calculate remaining time for hourly walk-ins
  const getRemainingTime = (laneNum) => {
    const endTime = getSessionEnd(laneNum);
    if (endTime === null) return '∞';

    const remaining = endTime - now;
    if (remaining <= 0) return '0:00';

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const hrs = Math.floor(mins / 60);
    const displayMins = mins % 60;

    if (hrs > 0) {
      return `${hrs}:${displayMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${displayMins}:${secs.toString().padStart(2, '0')}`;
  };

  // Helper to determine if a lane is open/active
  const getLaneStatus = (laneNum) => {
    if (!state) return 'idle';

    const walkIns = state.walkIns || [];
    const reservations = state.reservations || [];
    const maintenance = state.maintenance || {};
    const serviceCalls = state.serviceCalls || {};

    // Check if in maintenance
    if (maintenance[laneNum]) return 'maintenance';

    // Check if lane has active service call
    if (serviceCalls[laneNum]) {
      return serviceCalls[laneNum].acked ? 'service_call_acked' : 'service_call';
    }

    // Check if has walk-in
    const hasWalkIn = walkIns.some(w => w.lane === laneNum);
    if (hasWalkIn) return 'active';

    // Check if has current reservation
    const nowMs = Date.now();
    const currentRes = reservations.find(r =>
      r.lane === laneNum &&
      r.start <= nowMs &&
      r.end > nowMs
    );
    if (currentRes) return 'active';

    return 'idle';
  };

  const addNotification = (message, type = 'success') => {
    const id = Date.now();
    setNotifications(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  };

  const handleServiceCall = (laneNum) => {
    const serviceCalls = state?.serviceCalls || {};
    const laneDisplay = String(laneNum).padStart(2, '0');
    if (serviceCalls[laneNum]) {
      addNotification(`Lane ${laneDisplay}: Service call already active!`, 'info');
    } else {
      dispatch('TOGGLE_SERVICE_CALL', { lane: laneNum, origin: 'kiosk' });
      addNotification(`Lane ${laneDisplay}: Service call sent!`, 'success');
    }
  };

  const handleExtendSession = (laneNum) => {
    const walkIn = getWalkIn(laneNum);
    if (!walkIn) return;

    dispatch('EXTEND_SESSION', { lane: laneNum });

    const laneDisplay = String(laneNum).padStart(2, '0');
    if (walkIn.type === 'hourly') {
      addNotification(`Lane ${laneDisplay}: Added 1 hour to session`, 'success');
    } else {
      addNotification(`Lane ${laneDisplay}: Added 1 game to session`, 'success');
    }
  };

  const handlePinsetterCycle = (laneNum) => {
    setPinsetterCycling(laneNum);
    const laneDisplay = String(laneNum).padStart(2, '0');
    addNotification(`Lane ${laneDisplay}: Pinsetter cycling...`, 'info');
    setTimeout(() => {
      setPinsetterCycling(false);
      addNotification(`Lane ${laneDisplay}: Pinsetter ready`, 'success');
    }, 3000);
  };

  // Boot screen
  if (!bootComplete) {
    return <BootScreen lanes={myLanes} />;
  }

  return (
    <div style={{
      height: '100vh',
      background: C.surface,
      fontFamily: F.head,
      color: C.kioskCyan,
      position: 'relative',
      overflow: 'hidden',
      padding: 20,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <KioskHeader lanes={myLanes} />

      {activePanel.panel === 'home' && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gridTemplateRows: '1fr',
          maxWidth: 1200,
          width: '100%',
          margin: '0 auto',
          position: 'relative',
          flex: 1,
          minHeight: 0,
        }}>
          {/* Center divider rail */}
          <div style={{
            position: 'absolute',
            left: '50%',
            top: '4%',
            bottom: '4%',
            width: 4,
            borderRadius: 4,
            background: C.surface,
            boxShadow: `inset 2px 2px 4px ${C.shadowDark}, inset -2px -2px 4px ${C.shadowLight}`,
            transform: 'translateX(-50%)',
          }} />

          {myLanes.map(laneNum => {
            const status = getLaneStatus(laneNum);
            const serviceCall = state?.serviceCalls?.[laneNum] || null;

            return (
              <LaneColumn
                key={laneNum}
                lane={laneNum}
                status={status}
                serviceCall={serviceCall}
                walkIn={getWalkIn(laneNum) || null}
                remaining={getRemainingTime(laneNum)}
                timeExpired={isTimeExpired(laneNum)}
                cycling={pinsetterCycling === laneNum}
                onPinsetter={() => handlePinsetterCycle(laneNum)}
                onServiceCall={() => handleServiceCall(laneNum)}
                onExtend={() => handleExtendSession(laneNum)}
              />
            );
          })}
        </div>
      )}

      {showConfirmation && (
        <ConfirmModal
          title={showConfirmation.title}
          message={showConfirmation.message}
          onConfirm={showConfirmation.onConfirm}
          onCancel={() => setShowConfirmation(null)}
        />
      )}

      <NotificationStack notifications={notifications} />
    </div>
  );
};

export default LunarLanesKiosk;
