import { useId, type CSSProperties } from 'react';

interface MarkProps {
  size?: number;
  /** Accessible name. When omitted the mark is decorative. */
  title?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The GhostGrid monogram, engraved rather than drawn: a watch-bezel ring with fine tick marks, a brass "G" whose
 * crossbar points at a faceted diamond, and three hairline spokes from that diamond to the bezel.
 * The diamond is the hidden shared dependency; the spokes are the links nobody mapped.
 */
export function LogoMark({ size = 32, title, className, style }: MarkProps) {
  const uid = useId().replace(/:/g, '');
  const gold = `gg-gold-${uid}`;
  const face = `gg-face-${uid}`;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      style={style}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={gold} x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#F3E2B3" />
          <stop offset="0.45" stopColor="#CDA45D" />
          <stop offset="1" stopColor="#8A6A30" />
        </linearGradient>
        <linearGradient id={face} x1="26" y1="26" x2="38" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFF3CF" />
          <stop offset="1" stopColor="#B88B3F" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill="none" stroke={`url(#${gold})`} strokeWidth="0.9" />
      <circle cx="32" cy="32" r="27" fill="none" stroke={`url(#${gold})`} strokeWidth="1.2" strokeDasharray="0.5 2.75" strokeLinecap="round" opacity="0.75" />
      <g stroke={`url(#${gold})`} strokeWidth="0.7" strokeDasharray="1.2 1.8" strokeLinecap="round" opacity="0.8">
        <path d="M32 26.5V6.5" />
        <path d="M27.2 35L10 45" />
        <path d="M36.8 35L54 45" />
      </g>
      <path
        d="M44.73 19.27A18 18 0 1 0 50 32H38.2"
        fill="none"
        stroke={`url(#${gold})`}
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M32 25.8L38.2 32L32 38.2L25.8 32Z" fill={`url(#${face})`} />
      <path d="M32 25.8L38.2 32L32 38.2L25.8 32Z" fill="none" stroke="#0A1110" strokeWidth="0.6" opacity="0.5" />
      <path d="M32 25.8L32 38.2M25.8 32L38.2 32" stroke="#0A1110" strokeWidth="0.45" opacity="0.35" />
    </svg>
  );
}

export function Logo({ size = 34, className = '', wordmark = true }: { size?: number; className?: string; wordmark?: boolean }) {
  return (
    <span className={`logo ${className}`}>
      <LogoMark size={size} />
      {wordmark && (
        <span className="logo-word">
          Ghost<b>grid</b>
        </span>
      )}
    </span>
  );
}
