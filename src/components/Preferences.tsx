import { palettes, paletteNames, useTheme } from "../theme";
import { Modal } from "./Modal";
import { Icon } from "./Icon";

export function Preferences({ onClose }: { onClose: () => void }) {
  const { palette, setPalette, t } = useTheme();
  return <Modal title={t("偏好设置")} onClose={onClose}>
    <fieldset className="palette-settings">
      <legend>{t("主题配色")}</legend>
      <p>{t("选择后立即应用并自动保存，适用于浅色和暗色模式。")}</p>
      <div className="palette-grid">{palettes.map((value) => <label key={value} data-palette={value}
        className={`palette-choice ${palette === value ? "selected" : ""}`}>
        <input type="radio" name="palette" value={value} checked={palette === value} onChange={() => setPalette(value)} />
        <span className="palette-preview" aria-hidden="true"><span /><span /><span /></span>
        <span className="palette-name">{t(paletteNames[value])}<Icon name="check" size={16} /></span>
      </label>)}</div>
    </fieldset>
  </Modal>;
}
