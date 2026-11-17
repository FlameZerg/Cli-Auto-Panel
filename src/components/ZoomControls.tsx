import { clampZoom, useTheme } from "../theme";
import { Icon } from "./Icon";

export function ZoomControls() {
  const { zoom, setZoom, t } = useTheme();
  return <div className="zoom-controls" role="group" aria-label={t("页面缩放")}
    title={t("Ctrl + 鼠标滚轮 · 50–200%")}>
    <button className="icon-button" disabled={zoom <= .5} aria-label={t("缩小页面")}
      onClick={() => setZoom((value) => clampZoom(value - .1))}><Icon name="minus" size={16} /></button>
    <button className="zoom-value" onClick={() => setZoom(1)} aria-label={t("重置缩放")}>{Math.round(zoom * 100)}%</button>
    <button className="icon-button" disabled={zoom >= 2} aria-label={t("放大页面")}
      onClick={() => setZoom((value) => clampZoom(value + .1))}><Icon name="plus" size={16} /></button>
  </div>;
}
