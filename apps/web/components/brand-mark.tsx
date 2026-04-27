// Placeholder wordmark/symbol — three wave lines (sources) converging over a
// gold underline. Reads as "many sources, one throughline." Replace once the
// real brand mark is finalized.

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d="M3 5c4 0 6 5 9 5s5-5 9-5"
        stroke="var(--color-primary)"
      />
      <path
        d="M3 12c4 0 6 5 9 5s5-5 9-5"
        stroke="var(--color-primary)"
      />
      <line x1="3" y1="19" x2="21" y2="19" stroke="var(--color-accent)" />
    </svg>
  );
}
