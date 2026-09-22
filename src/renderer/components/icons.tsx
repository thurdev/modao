/**
 * Hand-rolled 16px line icons. No icon dependency: the set is small, the
 * stroke weight is consistent, and every glyph reads at sidebar size.
 */
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement>

function Svg({ children, ...props }: P & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const Icon = {
  profiles: (p: P) => (
    <Svg {...p}>
      <rect x="2" y="2.6" width="5.2" height="5.2" rx="1.4" />
      <rect x="8.8" y="2.6" width="5.2" height="5.2" rx="1.4" />
      <rect x="2" y="9.2" width="5.2" height="4.2" rx="1.4" />
      <rect x="8.8" y="9.2" width="5.2" height="4.2" rx="1.4" />
    </Svg>
  ),
  library: (p: P) => (
    <Svg {...p}>
      <path d="M2.4 3.2h11.2M2.4 8h11.2M2.4 12.8h11.2" />
      <circle cx="5.4" cy="3.2" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="10.2" cy="8" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="6.6" cy="12.8" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  ),
  browse: (p: P) => (
    <Svg {...p}>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="m10.6 10.6 3 3" />
    </Svg>
  ),
  conflicts: (p: P) => (
    <Svg {...p}>
      <path d="M3 4.2h6.4v8.2H3z" />
      <path d="M6.6 3h6.4v8.2" />
    </Svg>
  ),
  health: (p: P) => (
    <Svg {...p}>
      <path d="M1.8 8h3l1.4-3.4L9 11.4 10.4 8h3.8" />
    </Svg>
  ),
  saves: (p: P) => (
    <Svg {...p}>
      <path d="M2.6 4.2a5.4 2.2 0 1 0 10.8 0 5.4 2.2 0 1 0-10.8 0" />
      <path d="M2.6 4.2v7.6c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V4.2" />
      <path d="M2.6 8c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2" />
    </Svg>
  ),
  settings: (p: P) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" />
    </Svg>
  ),
  play: (p: P) => (
    <Svg {...p}>
      <path d="M4.6 2.9 12.8 8l-8.2 5.1z" fill="currentColor" />
    </Svg>
  ),
  plus: (p: P) => (
    <Svg {...p}>
      <path d="M8 3.4v9.2M3.4 8h9.2" />
    </Svg>
  ),
  search: (p: P) => (
    <Svg {...p}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3 3" />
    </Svg>
  ),
  external: (p: P) => (
    <Svg {...p}>
      <path d="M9 3h4v4M13 3 7.4 8.6" />
      <path d="M12.2 9.6v3a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 12.6V5.2a1.4 1.4 0 0 1 1.4-1.4h3" />
    </Svg>
  ),
  trash: (p: P) => (
    <Svg {...p}>
      <path d="M2.8 4.2h10.4M6.2 4.2V2.9h3.6v1.3M4.4 4.2l.6 8.4a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.6-8.4" />
    </Svg>
  ),
  copy: (p: P) => (
    <Svg {...p}>
      <rect x="5.4" y="5.4" width="8" height="8" rx="1.4" />
      <path d="M10.6 5.4V4a1.4 1.4 0 0 0-1.4-1.4H4A1.4 1.4 0 0 0 2.6 4v5.2A1.4 1.4 0 0 0 4 10.6h1.4" />
    </Svg>
  ),
  download: (p: P) => (
    <Svg {...p}>
      <path d="M8 2.6v7.2M5.2 7.2 8 10l2.8-2.8M2.8 12.4h10.4" />
    </Svg>
  ),
  upload: (p: P) => (
    <Svg {...p}>
      <path d="M8 10.4V3.2M5.2 6 8 3.2 10.8 6M2.8 12.8h10.4" />
    </Svg>
  ),
  folder: (p: P) => (
    <Svg {...p}>
      <path d="M2.2 4.6a1.4 1.4 0 0 1 1.4-1.4h2.3l1.4 1.8h5.1a1.4 1.4 0 0 1 1.4 1.4v5.2a1.4 1.4 0 0 1-1.4 1.4H3.6a1.4 1.4 0 0 1-1.4-1.4z" />
    </Svg>
  ),
  refresh: (p: P) => (
    <Svg {...p}>
      <path d="M13.2 7.2a5.2 5.2 0 1 0-.7 3.4" />
      <path d="M13.4 3.2v3.8h-3.8" />
    </Svg>
  ),
  /** Rolls a change back: an arrow returning to where it started. */
  undo: (p: P) => (
    <Svg {...p}>
      <path d="M2.8 8.8a5.2 5.2 0 1 1 1 3" />
      <path d="M2.6 4.8v3.8h3.8" />
    </Svg>
  ),
  check: (p: P) => (
    <Svg {...p}>
      <path d="m3.4 8.4 3 3 6.2-7" />
    </Svg>
  ),
  close: (p: P) => (
    <Svg {...p}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  ),
  chevron: (p: P) => (
    <Svg {...p}>
      <path d="m6 3.6 4.4 4.4L6 12.4" />
    </Svg>
  ),
  doc: (p: P) => (
    <Svg {...p}>
      <path d="M4 2.4h5l3 3v8.2H4z" />
      <path d="M9 2.4v3h3" />
    </Svg>
  ),
  warn: (p: P) => (
    <Svg {...p}>
      <path d="M8 2.8 14.2 13H1.8z" />
      <path d="M8 6.6v3M8 11.4v.1" />
    </Svg>
  ),
  bolt: (p: P) => (
    <Svg {...p}>
      <path d="M8.8 1.8 3.4 9h4l-.6 5.2L12.6 7h-4z" />
    </Svg>
  )
}

export type IconName = keyof typeof Icon
