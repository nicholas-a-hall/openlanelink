import { useState } from 'react';
import { F, useCompact } from '../../shared';
import { useColors } from '../../theme';

export default function ComponentInventory({ components, dispatch }) {
  const C = useColors();
  const compact = useCompact();
  const [showAddComponent, setShowAddComponent] = useState(false);
  const [newComponent, setNewComponent] = useState({
    componentId: '',
    name: '',
    quantity: 0,
    minStock: 0,
    category: 'mechanical',
    unit: 'pieces'
  });

  const categories = {
    pins: { label: 'Pins', color: C.mechText },
    mechanical: { label: 'Mechanical', color: C.mechTextMuted },
    electronics: { label: 'Electronics', color: C.mechTextMuted },
    supplies: { label: 'Supplies', color: C.mechTextMuted }
  };

  const groupedComponents = {};
  components.forEach(comp => {
    if (!groupedComponents[comp.category]) {
      groupedComponents[comp.category] = [];
    }
    groupedComponents[comp.category].push(comp);
  });

  const handleQuantityChange = (comp, delta) => {
    const newQuantity = Math.max(0, comp.quantity + delta);
    dispatch('UPDATE_COMPONENT_INVENTORY', {
      id: comp._id,
      quantity: newQuantity
    });
  };

  const handleAddComponent = () => {
    if (!newComponent.componentId || !newComponent.name) {
      alert('Component ID and name are required');
      return;
    }

    if (components.find(c => c.componentId === newComponent.componentId)) {
      alert('Component ID already exists');
      return;
    }

    dispatch('ADD_COMPONENT', {
      component: {
        componentId: newComponent.componentId,
        name: newComponent.name,
        quantity: newComponent.quantity,
        minStock: newComponent.minStock,
        category: newComponent.category,
        unit: newComponent.unit
      }
    });

    setNewComponent({
      componentId: '',
      name: '',
      quantity: 0,
      minStock: 0,
      category: 'mechanical',
      unit: 'pieces'
    });
    setShowAddComponent(false);
  };

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
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16
      }}>
        <h2 style={{
          fontFamily: F.head,
          fontSize: compact ? '1.2rem' : '1.5rem',
          color: C.purple,
          margin: 0
        }}>
          Component Inventory
        </h2>
        <Btn color={C.green} onClick={() => setShowAddComponent(!showAddComponent)}>
          {showAddComponent ? 'Cancel' : '+ Add Component'}
        </Btn>
      </div>

      {/* Add Component Form */}
      {showAddComponent && (
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
            Add New Component
          </h3>

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
                marginBottom: 4
              }}>
                Component ID *
              </label>
              <input
                type="text"
                value={newComponent.componentId}
                onChange={(e) => setNewComponent({ ...newComponent, componentId: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
                placeholder="e.g., pins-white"
                style={{
                  width: '100%',
                  padding: '8px 10px',
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
                fontSize: '0.7rem',
                color: C.text,
                marginBottom: 4
              }}>
                Name *
              </label>
              <input
                type="text"
                value={newComponent.name}
                onChange={(e) => setNewComponent({ ...newComponent, name: e.target.value })}
                placeholder="e.g., White Bowling Pins"
                style={{
                  width: '100%',
                  padding: '8px 10px',
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
                fontSize: '0.7rem',
                color: C.text,
                marginBottom: 4
              }}>
                Initial Quantity
              </label>
              <input
                type="number"
                value={newComponent.quantity}
                onChange={(e) => setNewComponent({ ...newComponent, quantity: parseInt(e.target.value) || 0 })}
                style={{
                  width: '100%',
                  padding: '8px 10px',
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
                fontSize: '0.7rem',
                color: C.text,
                marginBottom: 4
              }}>
                Min Stock Level
              </label>
              <input
                type="number"
                value={newComponent.minStock}
                onChange={(e) => setNewComponent({ ...newComponent, minStock: parseInt(e.target.value) || 0 })}
                style={{
                  width: '100%',
                  padding: '8px 10px',
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
                fontSize: '0.7rem',
                color: C.text,
                marginBottom: 4
              }}>
                Category
              </label>
              <select
                value={newComponent.category}
                onChange={(e) => setNewComponent({ ...newComponent, category: e.target.value })}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  fontFamily: F.mono,
                  fontSize: '0.75rem',
                  background: C.card,
                  border: `1px solid ${C.dim}`,
                  borderRadius: 5,
                  color: C.text,
                  cursor: 'pointer'
                }}
              >
                {Object.entries(categories).map(([key, cat]) => (
                  <option key={key} value={key}>{cat.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{
                display: 'block',
                fontSize: '0.7rem',
                color: C.text,
                marginBottom: 4
              }}>
                Unit
              </label>
              <input
                type="text"
                value={newComponent.unit}
                onChange={(e) => setNewComponent({ ...newComponent, unit: e.target.value })}
                placeholder="e.g., pieces, bottles"
                style={{
                  width: '100%',
                  padding: '8px 10px',
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

          <Btn color={C.green} onClick={handleAddComponent}>
            Add Component
          </Btn>
        </div>
      )}

      {/* Component List by Category */}
      {components.length === 0 ? (
        <div style={{
          padding: compact ? 16 : 24,
          border: `1px solid ${C.dim}`,
          borderRadius: 8,
          background: C.card, boxShadow: C.cardShadow,
          textAlign: 'center',
          color: C.text,
          fontSize: '0.85rem'
        }}>
          No components found. Run the seed script or add components manually.
        </div>
      ) : (
        Object.entries(categories).map(([catKey, catInfo]) => {
          const items = groupedComponents[catKey] || [];
          if (items.length === 0) return null;

          return (
            <div key={catKey} style={{ marginBottom: 24 }}>
              <h3 style={{
                fontFamily: F.head,
                fontSize: compact ? '1rem' : '1.2rem',
                color: catInfo.color,
                margin: '0 0 12px 0',
                textTransform: 'uppercase'
              }}>
                {catInfo.label} ({items.length})
              </h3>

              <div style={{
                display: 'grid',
                gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 12
              }}>
                {items.map((comp) => {
                  const isLowStock = comp.quantity <= comp.minStock;
                  return (
                    <div key={comp._id} style={{
                      padding: compact ? 12 : 14,
                      border: `2px solid ${isLowStock ? C.orange : catInfo.color}55`,
                      borderRadius: 8,
                      background: isLowStock ? `${C.orange}11` : `${catInfo.color}08`
                    }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        marginBottom: 8
                      }}>
                        <div style={{
                          flex: 1,
                          minWidth: 0
                        }}>
                          <div style={{
                            fontFamily: F.head,
                            fontSize: '0.9rem',
                            color: isLowStock ? C.orange : catInfo.color,
                            fontWeight: 700,
                            marginBottom: 4
                          }}>
                            {comp.name}
                          </div>
                          <div style={{
                            fontSize: '0.65rem',
                            color: C.dim,
                            fontFamily: F.mono
                          }}>
                            ID: {comp.componentId}
                          </div>
                        </div>
                        <div style={{
                          fontSize: '1.2rem',
                          marginLeft: 8
                        }}>
                          {isLowStock ? '⚠️' : '✅'}
                        </div>
                      </div>

                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 8
                      }}>
                        <div>
                          <div style={{
                            fontFamily: F.head,
                            fontSize: compact ? '1.5rem' : '1.8rem',
                            color: isLowStock ? C.orange : catInfo.color,
                            fontWeight: 700
                          }}>
                            {comp.quantity}
                          </div>
                          <div style={{
                            fontSize: '0.65rem',
                            color: C.text
                          }}>
                            {comp.unit}
                          </div>
                        </div>
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          alignItems: 'flex-end'
                        }}>
                          <div style={{
                            fontSize: '0.7rem',
                            color: C.dim
                          }}>
                            Min: {comp.minStock}
                          </div>
                          {isLowStock && (
                            <div style={{
                              fontSize: '0.65rem',
                              color: C.orange,
                              fontWeight: 'bold',
                              textTransform: 'uppercase'
                            }}>
                              Low Stock!
                            </div>
                          )}
                        </div>
                      </div>

                      <div style={{
                        display: 'flex',
                        gap: 8
                      }}>
                        <button
                          onClick={() => handleQuantityChange(comp, -1)}
                          disabled={comp.quantity === 0}
                          style={{
                            flex: 1,
                            fontFamily: F.mono,
                            fontSize: compact ? '0.9rem' : '1.1rem',
                            padding: compact ? '14px' : '16px',
                            minHeight: compact ? '48px' : '56px',
                            background: comp.quantity === 0 ? C.mechBtnBgDisabled : C.mechBtnBgMed,
                            border: `2px solid ${comp.quantity === 0 ? C.mechBtnBorderDim : C.mechBtnBorderBright}`,
                            color: comp.quantity === 0 ? C.mechTextDim : C.mechText,
                            borderRadius: 8,
                            cursor: comp.quantity === 0 ? 'default' : 'pointer',
                            fontWeight: 'bold',
                            opacity: comp.quantity === 0 ? 0.5 : 1
                          }}
                        >
                          − Remove
                        </button>
                        <button
                          onClick={() => handleQuantityChange(comp, 1)}
                          style={{
                            flex: 1,
                            fontFamily: F.mono,
                            fontSize: compact ? '0.9rem' : '1.1rem',
                            padding: compact ? '14px' : '16px',
                            minHeight: compact ? '48px' : '56px',
                            background: C.mechBtnBgMed,
                            border: `2px solid ${C.mechBtnBorderBright}`,
                            color: C.mechText,
                            borderRadius: 8,
                            cursor: 'pointer',
                            fontWeight: 'bold'
                          }}
                        >
                          + Add
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
