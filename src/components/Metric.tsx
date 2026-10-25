import type { ReactNode } from 'react';

export default function Metric({ label, value, sub, hl }: { label: string; value: ReactNode; sub?: ReactNode; hl?: boolean }) {
  return (
    <div className={`metric${hl ? ' hl' : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub != null && <div className="sub">{sub}</div>}
    </div>
  );
}
