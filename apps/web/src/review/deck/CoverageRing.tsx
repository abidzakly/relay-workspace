/** Coverage ring for the deck header: share of hunks touched. */
export function CoverageRing({
  value,
  size = 44,
  label,
}: {
  value: number;
  size?: number;
  label?: string;
}) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={label ?? `Coverage ${pct}%`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={5}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          className={`transition-[stroke-dashoffset] duration-500 ease-settle motion-reduce:transition-none ${pct === 100 ? 'stroke-moss' : 'stroke-primary'}`}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-2xs font-semibold tabular-nums">
        {pct}%
      </span>
    </div>
  );
}
