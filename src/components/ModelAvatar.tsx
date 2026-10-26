import { vendorOf } from '../lib/vendor.ts';
import VendorIcon from './BrandIcons.tsx';

/** 模型 / 服务商图标：识别出厂商时显示厂商标识，否则显示首字母 */
export default function ModelAvatar({ model, host, size = 36 }: { model: string; host?: string; size?: number }) {
  const v = vendorOf(model, host);
  const letter = (model.replace(/^[^a-z0-9一-龥]+/i, '')[0] ?? '?').toUpperCase();
  return (
    <span className={`avatar ${v ? `vendor-${v}` : 'letter'}`} style={{ width: size, height: size, borderRadius: size * 0.3 }} aria-hidden="true">
      {v ? <VendorIcon vendor={v} size={Math.round(size * 0.62)} /> : <b style={{ fontSize: size * 0.42 }}>{letter}</b>}
    </span>
  );
}
