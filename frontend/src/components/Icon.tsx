const PATHS = {
  dashboard: 'M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z',
  scenarios: 'M12 3l9 4.5-9 4.5L3 7.5zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5',
  graph: 'M6 6.5a2 2 0 100-4 2 2 0 000 4zM18 12a2 2 0 100-4 2 2 0 000 4zM6 21.5a2 2 0 100-4 2 2 0 000 4zM7.8 5.6l8.4 4.2M7.8 18.4l8.4-4.2',
  investigate: 'M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L21 21M10.5 10.5h.01',
  simulate: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 100 6 3 3 0 000-6zM6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2',
  mitigation: 'M4 5h6l4 7h6M4 19h6l4-7M17 9l3 3-3 3',
  reports: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  branch: 'M6 3v12M6 15a3 3 0 100 6 3 3 0 000-6zM18 3a3 3 0 100 6 3 3 0 000-6zM18 9c0 4-4 4-8 5.5',
  features: 'M4 20V10M10 20V4M16 20v-7M22 20H2M4 6l6-2 6 5 4-3',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  play: 'M7 5l12 7-12 7z',
  integrations: 'M9 3v4M15 3v4M7 7h10v5a5 5 0 01-10 0zM12 17v4',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
