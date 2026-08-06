import { useState, useEffect } from 'react';
import { F, useCompact } from '../../shared';
import { useColors } from '../../theme';

export default function MaintenanceTaskManager({ maintenanceTasks, dispatch }) {
  const C = useColors();
  const compact = useCompact();
  const [filter, setFilter] = useState('pending');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [showPMSettings, setShowPMSettings] = useState(false);
  const [pmConfig, setPMConfig] = useState(null);
  const [newTask, setNewTask] = useState({
    type: 'preventative',
    title: '',
    description: '',
    lane: null,
    priority: 'medium',
    assignedTo: '',
    scheduledFor: '',
    estimatedDuration: 30,
    recurringPattern: null
  });

  // Fetch PM config on mount
  useEffect(() => {
    dispatch('GET_PM_CONFIG');

    // Listen for PM config updates
    const handlePMConfig = (config) => {
      setPMConfig(config);
    };

    // Note: In production, would set up socket listener here
    // For now, this is a placeholder
  }, [dispatch]);

  const priorities = {
    low: { label: 'Low', color: C.green },
    medium: { label: 'Medium', color: C.yellow },
    high: { label: 'High', color: C.red }
  };

  const types = {
    preventative: { label: 'Preventative', color: C.green },
    general: { label: 'General', color: C.blue },
    repair: { label: 'Repair', color: C.orange }
  };

  const recurringOptions = [
    { value: null, label: 'One-time' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' }
  ];

  const filteredTasks = maintenanceTasks.filter(t => {
    if (filter === 'all') return true;
    return t.status === filter;
  });

  const handleCreateTask = () => {
    if (!newTask.title || !newTask.type) {
      alert('Title and type are required');
      return;
    }

    const taskData = {
      ...newTask,
      scheduledFor: newTask.scheduledFor ? new Date(newTask.scheduledFor).getTime() : null,
      estimatedDuration: newTask.estimatedDuration * 60000, // Convert minutes to ms
      lane: newTask.lane === 'all' ? null : newTask.lane ? parseInt(newTask.lane) : null
    };

    dispatch('CREATE_MAINTENANCE_TASK', taskData);

    // Reset form
    setNewTask({
      type: 'preventative',
      title: '',
      description: '',
      lane: null,
      priority: 'medium',
      assignedTo: '',
      scheduledFor: '',
      estimatedDuration: 30,
      recurringPattern: null
    });
    setShowCreateForm(false);
  };

  const handleUpdateTask = (taskId, updates) => {
    dispatch('UPDATE_MAINTENANCE_TASK', { taskId, updates });
  };

  const handleDeleteTask = (taskId) => {
    if (confirm('Are you sure you want to delete this task?')) {
      dispatch('DELETE_MAINTENANCE_TASK', { taskId });
    }
  };

  const handleCompleteTask = (taskId) => {
    // For now, just mark as completed
    // Later can add component usage dialog
    dispatch('COMPLETE_MAINTENANCE_TASK', { taskId });
  };

  const formatDate = (timestamp) => {
    if (!timestamp) return 'Not scheduled';
    const date = new Date(timestamp);
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const formatDuration = (ms) => {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}min`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
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
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
        flexWrap: 'wrap',
        gap: 12
      }}>
        <h2 style={{
          fontFamily: F.head,
          fontSize: compact ? '1.2rem' : '1.5rem',
          color: C.green,
          margin: 0
        }}>
          Maintenance Tasks
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn color={C.purple} onClick={() => setShowPMSettings(!showPMSettings)}>
            {showPMSettings ? 'Hide' : 'PM Settings'}
          </Btn>
          <Btn color={C.green} onClick={() => setShowCreateForm(!showCreateForm)}>
            {showCreateForm ? 'Cancel' : '+ New Task'}
          </Btn>
        </div>
      </div>

      {/* PM Settings Panel */}
      {showPMSettings && (
        <div style={{
          padding: compact ? 12 : 16,
          border: `2px solid ${C.purple}`,
          borderRadius: 8,
          background: `${C.purple}08`,
          marginBottom: 16
        }}>
          <h3 style={{
            fontFamily: F.head,
            fontSize: compact ? '1rem' : '1.2rem',
            color: C.purple,
            margin: '0 0 12px 0'
          }}>
            Preventative Maintenance Module
          </h3>

          {pmConfig ? (
            <div>
              {/* PM Status */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 16,
                flexWrap: 'wrap'
              }}>
                <div style={{
                  fontSize: '0.75rem',
                  color: C.text
                }}>
                  Status:
                </div>
                <div style={{
                  fontSize: '0.85rem',
                  fontWeight: 'bold',
                  color: pmConfig.enabled ? C.green : C.red
                }}>
                  {pmConfig.enabled ? '✓ Enabled' : '✗ Disabled'}
                </div>
                {pmConfig.enabled && (
                  <>
                    <div style={{
                      fontSize: '0.75rem',
                      color: C.text,
                      marginLeft: 16
                    }}>
                      Equipment:
                    </div>
                    <div style={{
                      fontSize: '0.85rem',
                      fontWeight: 'bold',
                      color: C.purple
                    }}>
                      {pmConfig.equipmentType === 'brunswick-a2' ? 'Brunswick A2' : 'Generic'}
                    </div>
                  </>
                )}
              </div>

              {/* PM Controls */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: compact ? '1fr' : 'repeat(2, 1fr)',
                gap: 12,
                marginBottom: 12
              }}>
                <div>
                  <label style={{
                    display: 'block',
                    fontSize: '0.7rem',
                    color: C.text,
                    marginBottom: 6
                  }}>
                    Enable PM Module
                  </label>
                  <button
                    onClick={() => {
                      dispatch('UPDATE_PM_CONFIG', {
                        updates: { enabled: !pmConfig.enabled }
                      });
                      setPMConfig({ ...pmConfig, enabled: !pmConfig.enabled });
                    }}
                    style={{
                      width: '100%',
                      fontFamily: F.mono,
                      fontSize: '0.75rem',
                      padding: '10px',
                      background: pmConfig.enabled ? C.green : C.red,
                      border: 'none',
                      color: C.bg,
                      borderRadius: 5,
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                      fontWeight: 'bold'
                    }}
                  >
                    {pmConfig.enabled ? 'Disable PM Module' : 'Enable PM Module'}
                  </button>
                </div>

                <div>
                  <label style={{
                    display: 'block',
                    fontSize: '0.7rem',
                    color: C.text,
                    marginBottom: 6
                  }}>
                    Equipment Type
                  </label>
                  <select
                    value={pmConfig.equipmentType}
                    onChange={(e) => {
                      dispatch('UPDATE_PM_CONFIG', {
                        updates: { equipmentType: e.target.value }
                      });
                      setPMConfig({ ...pmConfig, equipmentType: e.target.value });
                    }}
                    disabled={!pmConfig.enabled}
                    style={{
                      width: '100%',
                      padding: '10px',
                      fontFamily: F.mono,
                      fontSize: '0.75rem',
                      background: C.card,
                      border: `1px solid ${C.dim}`,
                      borderRadius: 5,
                      color: pmConfig.enabled ? C.text : C.dim,
                      cursor: pmConfig.enabled ? 'pointer' : 'default'
                    }}
                  >
                    <option value="generic">Generic</option>
                    <option value="brunswick-a2">Brunswick A2</option>
                  </select>
                </div>
              </div>

              {/* Generate PM Tasks Button */}
              {pmConfig.enabled && (
                <div style={{
                  marginTop: 12,
                  padding: compact ? 12 : 14,
                  background: `${C.green}11`,
                  borderRadius: 5,
                  border: `1px dashed ${C.green}`
                }}>
                  <div style={{
                    fontSize: '0.75rem',
                    color: C.text,
                    marginBottom: 8
                  }}>
                    Generate today's PM tasks based on {pmConfig.equipmentType === 'brunswick-a2' ? 'Brunswick A2' : 'generic'} templates
                  </div>
                  <Btn
                    color={C.green}
                    onClick={() => {
                      dispatch('GENERATE_PM_TASKS');
                      alert('PM tasks generation initiated. Check the task list in a moment.');
                    }}
                  >
                    Generate Today's PM Tasks
                  </Btn>
                </div>
              )}

              {pmConfig.lastGenerated && (
                <div style={{
                  marginTop: 12,
                  fontSize: '0.7rem',
                  color: C.dim
                }}>
                  Last generated: {new Date(pmConfig.lastGenerated).toLocaleString()}
                </div>
              )}
            </div>
          ) : (
            <div style={{
              fontSize: '0.75rem',
              color: C.text
            }}>
              Loading PM configuration...
            </div>
          )}
        </div>
      )}

      {/* Create Task Form */}
      {showCreateForm && (
        <div style={{
          padding: compact ? 12 : 16,
          border: `2px solid ${C.green}`,
          borderRadius: 8,
          background: `${C.green}08`,
          marginBottom: 16
        }}>
          <h3 style={{
            fontFamily: F.head,
            fontSize: compact ? '1rem' : '1.2rem',
            color: C.green,
            margin: '0 0 12px 0'
          }}>
            Create Maintenance Task
          </h3>

          {/* Step 1: Type */}
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: 'block',
              fontSize: '0.75rem',
              color: C.text,
              marginBottom: 8
            }}>
              Type *
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {Object.entries(types).map(([key, type]) => (
                <Btn
                  key={key}
                  color={type.color}
                  active={newTask.type === key}
                  onClick={() => setNewTask({ ...newTask, type: key })}
                >
                  {type.label}
                </Btn>
              ))}
            </div>
          </div>

          {/* Step 2: Lane Selection */}
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: 'block',
              fontSize: '0.75rem',
              color: C.text,
              marginBottom: 8
            }}>
              Lane
            </label>
            <select
              value={newTask.lane === null ? 'all' : newTask.lane}
              onChange={(e) => setNewTask({ ...newTask, lane: e.target.value === 'all' ? null : parseInt(e.target.value) })}
              style={{
                width: '100%',
                padding: '10px',
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

          {/* Step 3: Details */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr' : 'repeat(2, 1fr)',
            gap: 12,
            marginBottom: 16
          }}>
            <div style={{ gridColumn: compact ? '1' : '1 / -1' }}>
              <label style={{
                display: 'block',
                fontSize: '0.75rem',
                color: C.text,
                marginBottom: 8
              }}>
                Title *
              </label>
              <input
                type="text"
                value={newTask.title}
                onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                placeholder="e.g., Weekly lane oil application"
                style={{
                  width: '100%',
                  padding: '10px',
                  fontFamily: F.mono,
                  fontSize: '0.75rem',
                  background: C.card,
                  border: `1px solid ${C.dim}`,
                  borderRadius: 5,
                  color: C.text
                }}
              />
            </div>

            <div style={{ gridColumn: compact ? '1' : '1 / -1' }}>
              <label style={{
                display: 'block',
                fontSize: '0.75rem',
                color: C.text,
                marginBottom: 8
              }}>
                Description
              </label>
              <textarea
                value={newTask.description}
                onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                placeholder="Detailed description..."
                style={{
                  width: '100%',
                  minHeight: 80,
                  padding: '10px',
                  fontFamily: F.mono,
                  fontSize: '0.75rem',
                  background: C.card,
                  border: `1px solid ${C.dim}`,
                  borderRadius: 5,
                  color: C.text,
                  resize: 'vertical'
                }}
              />
            </div>

            <div>
              <label style={{
                display: 'block',
                fontSize: '0.75rem',
                color: C.text,
                marginBottom: 8
              }}>
                Priority
              </label>
              <div style={{ display: 'flex', gap: 6 }}>
                {Object.entries(priorities).map(([key, priority]) => (
                  <Btn
                    key={key}
                    color={priority.color}
                    active={newTask.priority === key}
                    onClick={() => setNewTask({ ...newTask, priority: key })}
                  >
                    {priority.label}
                  </Btn>
                ))}
              </div>
            </div>

            <div>
              <label style={{
                display: 'block',
                fontSize: '0.75rem',
                color: C.text,
                marginBottom: 8
              }}>
                Estimated Duration (minutes)
              </label>
              <input
                type="number"
                value={newTask.estimatedDuration}
                onChange={(e) => setNewTask({ ...newTask, estimatedDuration: parseInt(e.target.value) || 0 })}
                style={{
                  width: '100%',
                  padding: '10px',
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

          {/* Step 4: Scheduling */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr' : 'repeat(2, 1fr)',
            gap: 12,
            marginBottom: 16
          }}>
            <div>
              <label style={{
                display: 'block',
                fontSize: '0.75rem',
                color: C.text,
                marginBottom: 8
              }}>
                Scheduled For
              </label>
              <input
                type="datetime-local"
                value={newTask.scheduledFor}
                onChange={(e) => setNewTask({ ...newTask, scheduledFor: e.target.value })}
                style={{
                  width: '100%',
                  padding: '10px',
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
              <label style={{
                display: 'block',
                fontSize: '0.75rem',
                color: C.text,
                marginBottom: 8
              }}>
                Assigned To
              </label>
              <input
                type="text"
                value={newTask.assignedTo}
                onChange={(e) => setNewTask({ ...newTask, assignedTo: e.target.value })}
                placeholder="Mechanic name..."
                style={{
                  width: '100%',
                  padding: '10px',
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
              <label style={{
                display: 'block',
                fontSize: '0.75rem',
                color: C.text,
                marginBottom: 8
              }}>
                Recurring
              </label>
              <select
                value={newTask.recurringPattern || ''}
                onChange={(e) => setNewTask({ ...newTask, recurringPattern: e.target.value || null })}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontFamily: F.mono,
                  fontSize: '0.75rem',
                  background: C.card,
                  border: `1px solid ${C.dim}`,
                  borderRadius: 5,
                  color: C.text,
                  cursor: 'pointer'
                }}
              >
                {recurringOptions.map(opt => (
                  <option key={opt.value || 'none'} value={opt.value || ''}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <Btn color={C.green} onClick={handleCreateTask}>
            Create Task
          </Btn>
        </div>
      )}

      {/* Filter Tabs */}
      <div style={{
        display: 'flex',
        gap: 8,
        marginBottom: 16,
        flexWrap: 'wrap'
      }}>
        {['pending', 'in_progress', 'completed', 'all'].map(f => (
          <Btn
            key={f}
            color={C.blue}
            active={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'in_progress' ? 'In Progress' : f.charAt(0).toUpperCase() + f.slice(1)}
          </Btn>
        ))}
      </div>

      {/* Task List */}
      {filteredTasks.length === 0 ? (
        <div style={{
          padding: compact ? 16 : 24,
          border: `1px solid ${C.dim}`,
          borderRadius: 8,
          background: C.card, boxShadow: C.cardShadow,
          textAlign: 'center',
          color: C.text,
          fontSize: '0.85rem'
        }}>
          No {filter !== 'all' ? filter : ''} tasks found
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fill, minmax(350px, 1fr))',
          gap: 12
        }}>
          {filteredTasks.map(task => {
            const priorityInfo = priorities[task.priority] || priorities.medium;
            const typeInfo = types[task.type] || types.general;

            return (
              <div key={task.id} style={{
                padding: compact ? 12 : 14,
                border: `2px solid ${priorityInfo.color}55`,
                borderRadius: 8,
                background: `${priorityInfo.color}08`
              }}>
                {/* Header */}
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: 8
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontFamily: F.head,
                      fontSize: compact ? '0.9rem' : '1rem',
                      color: priorityInfo.color,
                      fontWeight: 700,
                      marginBottom: 4
                    }}>
                      {task.title}
                    </div>
                    <div style={{
                      display: 'flex',
                      gap: 6,
                      flexWrap: 'wrap'
                    }}>
                      <span style={{
                        fontSize: '0.65rem',
                        padding: '2px 6px',
                        background: `${typeInfo.color}22`,
                        color: typeInfo.color,
                        borderRadius: 3,
                        fontFamily: F.mono,
                        textTransform: 'uppercase'
                      }}>
                        {typeInfo.label}
                      </span>
                      <span style={{
                        fontSize: '0.65rem',
                        padding: '2px 6px',
                        background: `${priorityInfo.color}22`,
                        color: priorityInfo.color,
                        borderRadius: 3,
                        fontFamily: F.mono,
                        textTransform: 'uppercase'
                      }}>
                        {priorityInfo.label}
                      </span>
                      {task.recurringPattern && (
                        <span style={{
                          fontSize: '0.65rem',
                          padding: '2px 6px',
                          background: `${C.purple}22`,
                          color: C.purple,
                          borderRadius: 3,
                          fontFamily: F.mono,
                          textTransform: 'uppercase'
                        }}>
                          {task.recurringPattern}
                        </span>
                      )}
                      {task.pmTemplate && (
                        <span style={{
                          fontSize: '0.65rem',
                          padding: '2px 6px',
                          background: `${C.blue}22`,
                          color: C.blue,
                          borderRadius: 3,
                          fontFamily: F.mono,
                          textTransform: 'uppercase',
                          fontWeight: 'bold'
                        }}>
                          AUTO-PM
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Description */}
                {task.description && (
                  <div style={{
                    fontSize: '0.75rem',
                    color: C.text,
                    marginBottom: 8,
                    fontStyle: 'italic'
                  }}>
                    {task.description}
                  </div>
                )}

                {/* Info Grid */}
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 8,
                  marginBottom: 8,
                  fontSize: '0.7rem',
                  color: C.text
                }}>
                  <div>
                    <div style={{ color: C.dim, marginBottom: 2 }}>Lane:</div>
                    <div style={{ color: C.text, fontWeight: 'bold' }}>
                      {task.lane ? `Lane ${task.lane}` : 'All Lanes'}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: C.dim, marginBottom: 2 }}>Duration:</div>
                    <div style={{ color: C.text, fontWeight: 'bold' }}>
                      {formatDuration(task.estimatedDuration)}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: C.dim, marginBottom: 2 }}>Scheduled:</div>
                    <div style={{ color: C.text, fontWeight: 'bold' }}>
                      {formatDate(task.scheduledFor)}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: C.dim, marginBottom: 2 }}>Assigned:</div>
                    <div style={{ color: C.text, fontWeight: 'bold' }}>
                      {task.assignedTo || 'Unassigned'}
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div style={{
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                  paddingTop: 8,
                  borderTop: `1px solid ${C.mechBtnBorderDim}`
                }}>
                  {task.status === 'pending' && (
                    <button
                      onClick={() => handleUpdateTask(task.id, { status: 'in_progress' })}
                      style={{
                        flex: 1,
                        fontFamily: F.mono,
                        fontSize: '0.65rem',
                        padding: '6px 10px',
                        background: C.blue,
                        border: 'none',
                        color: C.bg,
                        borderRadius: 4,
                        cursor: 'pointer',
                        textTransform: 'uppercase'
                      }}
                    >
                      Start
                    </button>
                  )}
                  {task.status === 'in_progress' && (
                    <button
                      onClick={() => handleCompleteTask(task.id)}
                      style={{
                        flex: 1,
                        fontFamily: F.mono,
                        fontSize: '0.65rem',
                        padding: '6px 10px',
                        background: C.green,
                        border: 'none',
                        color: C.bg,
                        borderRadius: 4,
                        cursor: 'pointer',
                        textTransform: 'uppercase'
                      }}
                    >
                      Complete
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteTask(task.id)}
                    style={{
                      fontFamily: F.mono,
                      fontSize: '0.65rem',
                      padding: '6px 10px',
                      background: C.red,
                      border: 'none',
                      color: C.bg,
                      borderRadius: 4,
                      cursor: 'pointer',
                      textTransform: 'uppercase'
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
