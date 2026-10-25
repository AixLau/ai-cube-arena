interface Props {
  checked: boolean;
  onChange(checked: boolean): void;
}

/** 魔方工具栏开关：是否外扩显示被遮挡的三个面 */
export default function HiddenFacesToggle({ checked, onChange }: Props) {
  return (
    <label className="switch" title="在魔方外侧悬浮显示被遮挡面的颜色">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden />
      显示隐藏面
    </label>
  );
}
