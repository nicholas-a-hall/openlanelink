import React, { useState } from 'react';
import { F, neuRaised, neuInset } from '../shared';
import { useColors } from '../theme';

export default function LaneButton({
  icon,
  label,
  title,
  color,
  onClick,
  disabled = false,
  spinning = false,
  size = 'clamp(72px, 12vh, 116px)',
}) {
  const C = useColors();
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  const btnColor = disabled ? C.dim : (color || C.kioskCyan);

  const boxShadow = disabled || pressed
    ? neuInset(C)
    : hover
      ? `6px 6px 16px ${C.shadowDark}, -6px -6px 16px ${C.shadowLight}, 0 0 18px ${btnColor}4d`
      : neuRaised(C);

  return (
    <button
      title={title}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPressed(false); }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: C.surface,
        border: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: F.head,
        color: btnColor,
        opacity: disabled ? 0.45 : 1,
        boxShadow,
        transform: hover && !disabled ? 'scale(1.05)' : 'scale(1)',
        transition: 'box-shadow 0.2s ease, color 0.2s ease, transform 0.2s ease',
      }}
    >
      <span style={{
        fontSize: 'clamp(24px, 4.2vh, 40px)',
        lineHeight: 1,
        filter: spinning ? `drop-shadow(0 0 12px ${btnColor})` : 'none',
        opacity: disabled ? 0.5 : 1,
      }}>
        {icon}
      </span>
      <span style={{
        fontSize: 'clamp(9px, 1.3vh, 12px)',
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: 1,
        textAlign: 'center',
        lineHeight: 1.1,
        padding: '0 6px',
      }}>
        {label}
      </span>
    </button>
  );
}
