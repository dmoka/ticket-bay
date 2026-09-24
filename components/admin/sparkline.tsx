/** Tiny inline trend line. Server-rendered SVG, data color only. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const w = 120;
  const h = 28;
  if (values.length < 2) return <svg className={className} viewBox={`0 0 ${w} ${h}`} />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 6)] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polygon points={area} fill="var(--chart-1)" opacity={0.08} />
      <polyline points={line} fill="none" stroke="var(--chart-1)" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
