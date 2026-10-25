/** 首页模型生态展示用的厂商图标（简化示意，保留各家的配色与识别特征） */
export type Vendor = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'qwen' | 'more';

function arc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const p = (a: number) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)].map((n) => n.toFixed(2)).join(' ');
  return `M ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)}`;
}

export default function VendorIcon({ vendor, size = 28 }: { vendor: Vendor; size?: number }) {
  switch (vendor) {
    case 'openai':
      return (
        <svg width={size} height={size} viewBox="-12 -12 24 24" aria-hidden="true">
          <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
            {[0, 60, 120, 180, 240, 300].map((a) => (
              <rect key={a} x="-2.9" y="-9.6" width="5.8" height="10.6" rx="2.9" transform={`rotate(${a}) translate(0 0.4)`} />
            ))}
          </g>
        </svg>
      );
    case 'anthropic':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#191919" d="M13.9 5h2.7l4.9 14h-2.7zM8.4 5h2.9l4.9 14h-2.8l-1-2.9H7.6L6.6 19H3.8zm-.1 8.6h3.6L10.1 8.4z" />
        </svg>
      );
    case 'google':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" strokeWidth="3.6" strokeLinecap="butt">
          <path d={arc(12, 12, 8, 200, 318)} stroke="#EA4335" />
          <path d={arc(12, 12, 8, 140, 200)} stroke="#FBBC05" />
          <path d={arc(12, 12, 8, 40, 140)} stroke="#34A853" />
          <path d={arc(12, 12, 8, 0, 40)} stroke="#4285F4" />
          <path d="M12 12h9.8" stroke="#4285F4" />
        </svg>
      );
    case 'deepseek':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4D6BFE"
            d="M22.4 5.6c-.4-.2-.7.2-.9.5-.3.3-.6.5-.9.6-1.3.1-2.4-.3-3.4-1.2-.7-.6-1.5-.8-2.4-.6.6.6 1.1 1.4 1.3 2.3.2.8-.2 1.7-1 2.1-1.7.8-2.5-1.3-4.8-2.4C7.6 5.6 4.6 6.6 3 9c-1.6 2.3-1.3 5.6.6 7.7 1.9 2.1 5.1 2.8 7.6 1.6 1-.4 1.8-1.1 2.6-1.8.6-.5 1.3-.7 2-.5-.7.9-1.7 1.6-2.7 2.1 2.6.2 5.3-1 6.9-3.1.7-1 1.1-2.1 1.2-3.3.1-1.1 0-2.3.4-3.3.4-1 1.3-1.7 1.1-2.8zM8.6 14.2c-.5.3-1.2.2-1.5-.3-.3-.5-.2-1.2.3-1.5.5-.3 1.2-.2 1.5.3.3.5.2 1.1-.3 1.5z"
          />
        </svg>
      );
    case 'qwen':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
          <defs>
            <linearGradient id="qwen-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#8b5cf6" />
              <stop offset="1" stopColor="#5b3df5" />
            </linearGradient>
          </defs>
          <g fill="none" stroke="url(#qwen-g)" strokeWidth="2.2" strokeLinejoin="round">
            <path d="M12 2.8 20 17H4z" />
            <path d="M12 21.2 4 7h16z" />
          </g>
          <circle cx="12" cy="12" r="2.2" fill="url(#qwen-g)" />
        </svg>
      );
    case 'more':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
  }
}
