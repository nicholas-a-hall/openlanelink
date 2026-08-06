import { useState, useEffect } from 'react';
import { F, useCompact } from './shared';
import { useColors, useTheme } from './theme';
import ServiceCallDashboard from './components/mechanics/ServiceCallDashboard';
import ServiceLogView from './components/mechanics/ServiceLogView';
import ComponentInventory from './components/mechanics/ComponentInventory';
import MaintenanceTaskManager from './components/mechanics/MaintenanceTaskManager';
import LaneContextView from './components/mechanics/LaneContextView';

/**
 * MechanicsView - Main mechanics management interface
 * Sub-views: dashboard, service-log, components, maintenance, lane-context
 */
export default function MechanicsView({
  reservations,
  walkIns,
  maintenance,
  serviceCalls,
  dispatch,
  socket
}) {
  const compact = useCompact();
  const C = useColors();
  const { isDark, toggleTheme } = useTheme();
  const [subView, setSubView] = useState('dashboard');
  const [components, setComponents] = useState([]);
  const [maintenanceTasks, setMaintenanceTasks] = useState([]);
  const [serviceHistory, setServiceHistory] = useState([]);


  // Fetch mechanics data on mount
  useEffect(() => {
    if (socket) {
      // Request components
      dispatch('GET_COMPONENTS');

      // Request maintenance tasks
      dispatch('GET_MAINTENANCE_TASKS', {});

      // Listen for mechanics updates
      socket.on('components', (data) => {
        setComponents(data);
      });

      socket.on('maintenance-tasks', (data) => {
        setMaintenanceTasks(data);
      });

      socket.on('service-history', (data) => {
        setServiceHistory(data);
      });

      // Listen for broadcast updates
      const handleStateUpdate = (update) => {
        if (update.type === 'COMPONENT_UPDATED' || update.type === 'COMPONENT_ADDED') {
          dispatch('GET_COMPONENTS');
        }
        if (update.type === 'MAINTENANCE_TASK_CREATED' ||
            update.type === 'MAINTENANCE_TASK_UPDATED' ||
            update.type === 'MAINTENANCE_TASK_DELETED' ||
            update.type === 'MAINTENANCE_TASK_COMPLETED') {
          dispatch('GET_MAINTENANCE_TASKS', {});
        }
      };

      socket.on('update', handleStateUpdate);

      return () => {
        socket.off('components');
        socket.off('maintenance-tasks');
        socket.off('service-history');
        socket.off('update', handleStateUpdate);
      };
    }
  }, [socket, dispatch]);

  const Btn = ({ children, color, onClick, active }) => (
    <button
      onClick={onClick}
      style={{
        fontFamily: '"Orbitron", monospace',
        fontSize: compact ? '0.85rem' : '1rem',
        padding: compact ? '14px 20px' : '16px 24px',
        minHeight: compact ? '48px' : '56px',
        border: active ? `2px solid ${color}` : `2px solid ${C.mechBtnBorder}`,
        background: active
          ? C.mechBtnBgActive
          : C.mechBtnBg,
        color: active ? color : C.mechTextMuted,
        borderRadius: 8,
        cursor: 'pointer',
        textTransform: 'uppercase',
        letterSpacing: '2px',
        fontWeight: 'bold',
        transition: 'all 0.2s ease',
        boxShadow: 'none',
        textShadow: 'none'
      }}
    >
      {children}
    </button>
  );

  return (
    <div style={{
      padding: compact ? 12 : 20,
      fontFamily: '"Orbitron", "Courier New", monospace',
      color: C.mechText,
      minHeight: '100vh',
      position: 'relative',
      zIndex: 1
    }}>
      {/* Header */}
      <div style={{
        marginBottom: compact ? 12 : 16,
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }}>
        <span style={{ fontSize: compact ? '0.9rem' : '1rem' }}>🔧</span>
        <span style={{
          fontFamily: '"Orbitron", monospace',
          fontSize: compact ? '0.7rem' : '0.8rem',
          color: C.mechTextDim,
          textTransform: 'uppercase',
          letterSpacing: '2px'
        }}>
          Mechanics
        </span>
        <button onClick={toggleTheme} title={isDark ? 'Light mode' : 'Dark mode'}
          style={{ marginLeft:'auto', background:'none', border:`1px solid ${C.mechTextDim}44`, borderRadius:5,
            cursor:'pointer', color: C.mechTextDim, width:32, height:32, fontSize:'0.85rem',
            display:'flex', alignItems:'center', justifyContent:'center' }}>
          {isDark ? '\u2600' : '\u263E'}
        </button>
      </div>

      {/* Sub-view Navigation */}
      <div style={{
        display: 'flex',
        gap: 8,
        marginBottom: compact ? 16 : 24,
        flexWrap: 'wrap'
      }}>
        <Btn
          color={C.mechText}
          active={subView === 'dashboard'}
          onClick={() => setSubView('dashboard')}
        >
          Dashboard
        </Btn>
        <Btn
          color={C.mechTextMuted}
          active={subView === 'service-log'}
          onClick={() => setSubView('service-log')}
        >
          Service Log
        </Btn>
        <Btn
          color={C.mechTextMuted}
          active={subView === 'components'}
          onClick={() => setSubView('components')}
        >
          Components
        </Btn>
        <Btn
          color={C.mechTextMuted}
          active={subView === 'maintenance'}
          onClick={() => setSubView('maintenance')}
        >
          Maintenance
        </Btn>
        <Btn
          color={C.mechTextMuted}
          active={subView === 'lane-context'}
          onClick={() => setSubView('lane-context')}
        >
          Lane Context
        </Btn>
      </div>

      {/* Sub-view Content */}
      {subView === 'dashboard' && (
        <ServiceCallDashboard
          serviceCalls={serviceCalls}
          reservations={reservations}
          walkIns={walkIns}
          components={components}
          dispatch={dispatch}
        />
      )}

      {subView === 'service-log' && (
        <ServiceLogView />
      )}

      {subView === 'components' && (
        <ComponentInventory
          components={components}
          dispatch={dispatch}
        />
      )}

      {subView === 'maintenance' && (
        <MaintenanceTaskManager
          maintenanceTasks={maintenanceTasks}
          dispatch={dispatch}
        />
      )}

      {subView === 'lane-context' && (
        <LaneContextView
          reservations={reservations}
          walkIns={walkIns}
          maintenanceTasks={maintenanceTasks}
          dispatch={dispatch}
        />
      )}
    </div>
  );
}
