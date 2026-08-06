import React from 'react';
import { F, neuRaised } from '../shared';
import { useColors } from '../theme';

export default function ConfirmModal({ title, message, onConfirm, onCancel }) {
  const C = useColors();

  const btn = (color) => ({
    background: C.surface,
    border: 'none',
    color,
    padding: '15px 30px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 14,
    fontFamily: F.head,
    textTransform: 'uppercase',
    letterSpacing: 2,
    boxShadow: neuRaised(C),
    transition: 'box-shadow 0.2s ease',
  });

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: C.overlayBg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 3000,
    }}>
      <div style={{
        background: C.surface,
        borderRadius: 16,
        padding: 40,
        maxWidth: 400,
        textAlign: 'center',
        boxShadow: neuRaised(C),
        fontFamily: F.head,
      }}>
        <h3 style={{
          fontSize: 22,
          marginBottom: 15,
          color: C.kioskCyan,
        }}>
          {title}
        </h3>
        <p style={{
          fontSize: 14,
          color: `${C.kioskCyan}b3`,
          marginBottom: 30,
          lineHeight: 1.6,
        }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: 15, justifyContent: 'center' }}>
          <button style={btn(C.text)} onClick={onCancel}>Cancel</button>
          <button style={btn(C.kioskGreen)} onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
