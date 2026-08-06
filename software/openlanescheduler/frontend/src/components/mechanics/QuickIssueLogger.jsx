import { useState, useEffect } from 'react';
import { F, useCompact } from '../../shared';
import { useColors } from '../../theme';

export default function QuickIssueLogger({ lane, components, onClose, onSubmit }) {
  const C = useColors();
  const compact = useCompact();
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [description, setDescription] = useState('');
  const [resolvedBy, setResolvedBy] = useState('');
  const [selectedComponents, setSelectedComponents] = useState([]);
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(data => {
        const cats = (data.serviceCategories || []).map(label => ({
          id: label.toLowerCase().replace(/\s+/g, '-'),
          label
        }));
        setCategories(cats);
      })
      .catch(() => {
        setCategories([{ id: 'other', label: 'OTHER' }]);
      });
  }, []);

  const severities = [
    { id: 'low', label: 'Low', color: C.mechText },
    { id: 'medium', label: 'Medium', color: C.mechTextMuted },
    { id: 'high', label: 'High', color: C.mechText }
  ];

  const handleComponentToggle = (compId) => {
    const exists = selectedComponents.find(c => c.component === compId);
    if (exists) {
      setSelectedComponents(selectedComponents.filter(c => c.component !== compId));
    } else {
      setSelectedComponents([...selectedComponents, { component: compId, quantity: 1 }]);
    }
  };

  const handleComponentQuantityChange = (compId, delta) => {
    setSelectedComponents(selectedComponents.map(c => {
      if (c.component === compId) {
        const newQty = Math.max(1, c.quantity + delta);
        return { ...c, quantity: newQty };
      }
      return c;
    }));
  };

  const handleSubmit = () => {
    if (!category) {
      alert('Please select a category');
      return;
    }

    onSubmit({
      issue: {
        category,
        severity,
        description
      },
      componentsUsed: selectedComponents,
      resolvedBy: resolvedBy || 'Unknown'
    });
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
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: C.overlayBg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      padding: compact ? 12 : 20
    }}>
      <div style={{
        background: C.bg,
        border: `2px solid ${C.orange}`,
        borderRadius: 12,
        padding: compact ? 16 : 24,
        maxWidth: 600,
        width: '100%',
        maxHeight: '90vh',
        overflow: 'auto',
        fontFamily: F.mono
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 20
        }}>
          <h2 style={{
            fontFamily: F.head,
            fontSize: compact ? '1.2rem' : '1.5rem',
            color: C.orange,
            margin: 0
          }}>
            Resolve Service Call - Lane {lane}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: C.text,
              fontSize: '1.5rem',
              cursor: 'pointer',
              padding: 4
            }}
          >
            ×
          </button>
        </div>

        {/* Category Selection */}
        <div style={{ marginBottom: 20 }}>
          <label style={{
            display: 'block',
            fontSize: '0.8rem',
            color: C.text,
            marginBottom: 8
          }}>
            Issue Category *
          </label>
          <div style={{
            display: 'grid',
            gridTemplateColumns: compact ? '1fr 1fr' : '1fr 1fr 1fr',
            gap: 8
          }}>
            {categories.map(cat => (
              <Btn
                key={cat.id}
                color={C.mechText}
                active={category === cat.id}
                onClick={() => setCategory(cat.id)}
              >
                {cat.label}
              </Btn>
            ))}
          </div>
        </div>

        {/* Severity Selection */}
        <div style={{ marginBottom: 20 }}>
          <label style={{
            display: 'block',
            fontSize: '0.8rem',
            color: C.text,
            marginBottom: 8
          }}>
            Severity
          </label>
          <div style={{
            display: 'flex',
            gap: 8
          }}>
            {severities.map(sev => (
              <Btn
                key={sev.id}
                color={sev.color}
                active={severity === sev.id}
                onClick={() => setSeverity(sev.id)}
              >
                {sev.label}
              </Btn>
            ))}
          </div>
        </div>

        {/* Description */}
        <div style={{ marginBottom: 20 }}>
          <label style={{
            display: 'block',
            fontSize: '0.8rem',
            color: C.text,
            marginBottom: 8
          }}>
            Description (Optional)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the issue and resolution..."
            style={{
              width: '100%',
              minHeight: 80,
              padding: 10,
              fontFamily: F.mono,
              fontSize: '0.85rem',
              background: C.card,
              border: `1px solid ${C.dim}`,
              borderRadius: 5,
              color: C.text,
              resize: 'vertical'
            }}
          />
        </div>

        {/* Resolved By */}
        <div style={{ marginBottom: 20 }}>
          <label style={{
            display: 'block',
            fontSize: '0.8rem',
            color: C.text,
            marginBottom: 8
          }}>
            Resolved By
          </label>
          <input
            type="text"
            value={resolvedBy}
            onChange={(e) => setResolvedBy(e.target.value)}
            placeholder="Mechanic name..."
            style={{
              width: '100%',
              padding: 10,
              fontFamily: F.mono,
              fontSize: '0.85rem',
              background: C.card,
              border: `1px solid ${C.dim}`,
              borderRadius: 5,
              color: C.text
            }}
          />
        </div>

        {/* Components Used */}
        {components.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <label style={{
              display: 'block',
              fontSize: '0.8rem',
              color: C.text,
              marginBottom: 8
            }}>
              Components Used (Optional)
            </label>
            <div style={{
              maxHeight: 200,
              overflow: 'auto',
              border: `1px solid ${C.dim}`,
              borderRadius: 5,
              padding: 8
            }}>
              {components.map(comp => {
                const id = comp.componentId;
                const selected = selectedComponents.find(c => c.component === id);
                return (
                  <div key={id} style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    marginBottom: 4,
                    background: selected ? `${C.purple}11` : 'transparent',
                    border: `1px solid ${selected ? C.purple : 'transparent'}`,
                    borderRadius: 4,
                    cursor: 'pointer'
                  }}>
                    <div
                      onClick={() => handleComponentToggle(id)}
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8
                      }}
                    >
                      <div style={{
                        width: 16,
                        height: 16,
                        border: `2px solid ${selected ? C.purple : C.dim}`,
                        borderRadius: 3,
                        background: selected ? C.purple : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '0.6rem',
                        color: C.bg
                      }}>
                        {selected && '✓'}
                      </div>
                      <div style={{
                        fontSize: '0.75rem',
                        color: C.text
                      }}>
                        {comp.name}
                      </div>
                    </div>
                    {selected && (
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6
                      }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleComponentQuantityChange(id, -1);
                          }}
                          style={{
                            background: C.purple,
                            border: 'none',
                            color: C.bg,
                            width: 20,
                            height: 20,
                            borderRadius: 3,
                            cursor: 'pointer',
                            fontSize: '0.8rem',
                            fontWeight: 'bold'
                          }}
                        >
                          −
                        </button>
                        <span style={{
                          fontSize: '0.75rem',
                          color: C.purple,
                          fontWeight: 'bold',
                          minWidth: 20,
                          textAlign: 'center'
                        }}>
                          {selected.quantity}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleComponentQuantityChange(id, 1);
                          }}
                          style={{
                            background: C.purple,
                            border: 'none',
                            color: C.bg,
                            width: 20,
                            height: 20,
                            borderRadius: 3,
                            cursor: 'pointer',
                            fontSize: '0.8rem',
                            fontWeight: 'bold'
                          }}
                        >
                          +
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Action Buttons */}
        <div style={{
          display: 'flex',
          gap: 10,
          justifyContent: 'flex-end'
        }}>
          <Btn color={C.dim} onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            color={C.green}
            onClick={handleSubmit}
            disabled={!category}
          >
            Resolve & Log
          </Btn>
        </div>
      </div>
    </div>
  );
}
