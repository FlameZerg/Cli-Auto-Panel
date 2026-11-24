import type { OrphanedBinding, Template } from "../../types";
import { useI18n } from "../../theme";

export function OrphanedBindings({ bindings, templates, disabled, onOpen, onRemove, onDismiss }: {
  bindings: OrphanedBinding[];
  templates: Template[];
  disabled: boolean;
  onOpen: (template: Template) => void;
  onRemove: (binding: OrphanedBinding) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  if (!bindings.length) return null;

  const byId = new Map(templates.map((template) => [template.id, template]));
  const unknownCount = bindings.filter((binding) => !binding.filename).length;
  // 先显示已确认的文件名，只有缺少路径证据的历史记录才显示缺名提示。
  const ordered = [...bindings].sort((first, second) => Number(!first.filename) - Number(!second.filename)
    || (first.filename ?? "").localeCompare(second.filename ?? ""));
  return <div className="binding-warning">
    <button className="quiet binding-warning-close" aria-label={t("关闭失效绑定提示")} onClick={onDismiss}>
      {t("关闭")}</button>
    <details open>
      <summary>{t("失去入口的配置文件（{count} 份绑定）", { count: bindings.length })}</summary>
      <ul>{ordered.map((binding) => {
        const template = byId.get(binding.templateId);
        return <li key={`${binding.templateId}:${binding.configId}`}>
          <div className="binding-warning-row">
            <strong>{binding.filename ?? t("原文件名不可用")}</strong>
            {template
              ? <button className="quiet" disabled={disabled} onClick={() => onOpen(template)}>
                {t("打开通用配置「{name}」", { name: template.name })}</button>
              : <div><span>{t("通用配置已不存在")}</span> <button className="danger-outline"
                disabled={disabled} onClick={() => onRemove(binding)}>{t("移除绑定")}</button></div>}
          </div>
        </li>;
      })}</ul>
      {unknownCount > 0 && <p>{t("有 {count} 份历史绑定只保留路径校验值，无法确定原文件名。", { count: unknownCount })}</p>}
    </details>
  </div>;
}
