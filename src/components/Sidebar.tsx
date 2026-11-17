import { useMemo } from "react";
import { useTheme } from "../theme";
import type { Bootstrap, Template } from "../types";
import type { useDragSort } from "../features/drag/useDragSort";
import { Icon } from "./Icon";

interface Props {
  data: Bootstrap | null; selectedTemplate: string | null;
  disabled: boolean; busy: boolean; page: string;
  drag: ReturnType<typeof useDragSort<Template>>;
  onNewTemplate: () => void; onTemplate: (template: Template) => void;
  onPage: (page: "create" | "import" | "history") => void; onSettings: () => void;
}
export function Sidebar({ data, selectedTemplate, disabled, busy, page, drag,
  onNewTemplate, onTemplate, onPage, onSettings }: Props) {
  const { theme, toggle, language, setLanguage, t } = useTheme();
  const themeAction = t(theme === "light" ? "切换为暗色主题" : "切换为浅色主题");
  // 绑定数一次建立索引，避免每个模板在每次呈现时重扫全部绑定。
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const binding of data?.state.bindings ?? []) result.set(binding.templateId, (result.get(binding.templateId) ?? 0) + 1);
    return result;
  }, [data?.state.bindings]);
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark">CLI</span><div><strong>Auto Panel</strong><small>{t("本地配置工作台")}</small></div></div>
    <button className="sidebar-create" disabled={disabled} aria-label={t("新建别名与文件")}
      title={t("新建别名与文件")} onClick={() => onPage("create")}>
      <Icon name="plus" /><span>{t("新建别名与文件")}</span><Icon name="arrow" size={16} />
    </button>
    <nav aria-label={t("本地配置工作台")}>
      <div className="nav-section"><span>{t("通用配置")}</span>
        <button className="icon-button" disabled={disabled} aria-label={t("新建通用配置")}
          title={t("新建通用配置")} onClick={onNewTemplate}><Icon name="plus" size={17} /></button>
      </div>
      <div className="template-list" aria-label={t("通用配置列表")} {...drag.container}>
        {drag.ordered.map((template) => {
          const count = counts.get(template.id) ?? 0;
          const label = `${template.name} · ${t("{count} 份绑定", { count })}`;
          return <button key={template.id} disabled={busy} aria-label={label} title={label}
            aria-current={selectedTemplate === template.id ? "page" : undefined}
            className={`nav-item ${selectedTemplate === template.id ? "active" : ""} ${drag.dragging === template.id ? "dragging" : ""} ${drag.over === template.id ? "drag-over" : ""}`}
            {...drag.card(template.id, () => onTemplate(template))}>
            <Icon name="sharedConfig" />
            <span>{template.name}</span><span className="nav-count">{count}</span>
          </button>;
        })}
        {/* 空状态只指向保留的新建入口，避免提示已移除的操作。 */}
        {!drag.ordered.length && <p className="sidebar-empty">{t("还没有通用配置")}<br />{t("点击上方加号新建通用配置")}</p>}
      </div>
    </nav>
    <footer className="sidebar-footer">
      {/* 五个入口使用同一列表节奏，不再保留旧分组和分隔线留下的额外间距。 */}
      <button className={`nav-item ${page === "import" ? "active" : ""}`} disabled={disabled}
        aria-label={t("导入已有配置")} title={t("导入已有配置")} onClick={() => onPage("import")}>
        <Icon name="import" /><span>{t("导入已有配置")}</span>
      </button>
      <button className={`nav-item ${page === "history" ? "active" : ""}`} disabled={busy}
        aria-label={t("备份与恢复")} title={t("备份与恢复")} onClick={() => onPage("history")}>
        <Icon name="history" /><span>{t("备份与恢复")}</span>
      </button>
      <button className="nav-item" onClick={toggle} aria-label={themeAction} title={themeAction}>
        <Icon name={theme === "light" ? "sun" : "moon"} /><span>{t(theme === "light" ? "浅色主题" : "暗色主题")}</span>
      </button>
      <button className="nav-item" onClick={() => setLanguage(language === "zh" ? "en" : "zh")}
        aria-label={language === "zh" ? "Switch to English" : "切换为中文"} title={language === "zh" ? "Switch to English" : "切换为中文"}>
        <Icon name="languages" /><span>{language === "zh" ? "中文" : "English"}</span><span className="language-code">{language.toUpperCase()}</span>
      </button>
      <button className="nav-item" onClick={onSettings} aria-label={t("偏好设置")} title={t("偏好设置")}>
        <Icon name="settings" /><span>{t("偏好设置")}</span>
      </button>
    </footer>
  </aside>;
}
