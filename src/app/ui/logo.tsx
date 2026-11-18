/** The Walkthrough mark: an amber tile with a house outline (inline SVG, no remote image). Decorative. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true" focusable="false">
      <rect width="30" height="30" rx="7" fill="#F2A33A" />
      <path d="M8 19h14M10 19v-6l5-4 5 4v6" stroke="#13202B" strokeWidth="2.2" fill="none" strokeLinejoin="round" />
    </svg>
  );
}
