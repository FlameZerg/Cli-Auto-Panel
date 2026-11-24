import { CodeEditor } from "../../components/CodeEditor";
import type { OrphanedBinding, TemplateDraft } from "../../types";
import { useI18n } from "../../theme";

export function TemplateEditor({ draft, references, orphaned, disabled, onChange,
  onSave, onPreview, onDelete, onCopy, onRemoveOrphan }: {
  draft: TemplateDraft; references: number; disabled: boolean;
  orphaned: OrphanedBinding[];
  onChange: (draft: TemplateDraft) => void;
  onSave: () => void; onDelete: () => void; onCopy: () => void;
  onPreview: () => void;
  onRemoveOrphan: (binding: OrphanedBinding) => void;
}) {
  const { t } = useI18n();
  return <div className="form-section">
    <div className="section-title"><div><h2>{t("编辑通用配置")}</h2></div>
      {/* 与侧栏使用统一绑定计数文案，包含历史失效引用。 */}
      <span className="tag">{draft.id ? t("{count} 份绑定", { count: references }) : t("新建草稿")}</span></div>
    <label>{t("通用配置名称")}<input value={draft.name} disabled={disabled} maxLength={120}
      onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder={t("为这组配置起一个名称")} /></label>
    <CodeEditor kind={draft.kind} value={draft.content}
      readOnly={disabled} onChange={(content) => onChange({ ...draft, content })} />
    <div className="actions"><button className="primary" disabled={disabled || !draft.name.trim()} onClick={onSave}>{t("保存并同步")}</button>
      <button disabled={disabled || !draft.name.trim()} onClick={onPreview}>{t("查看差异")}</button>
      <button disabled={disabled} onClick={onCopy}>{t("另存为新模板")}</button>
      {/* 引用不再禁用删除；后端在同一事务内清理全部绑定，点击后先核对删除预览。 */}
      {draft.id && <button className="danger-outline" disabled={disabled}
        title={t("删除此通用配置并清理 {count} 份绑定，保留别名源文件", { count: references })} onClick={onDelete}>{t("删除模板")}</button>}</div>
    {orphaned.length > 0 && <section className="file-actions">
      <h3>{t("失去入口的绑定")}</h3>
      {orphaned.map((binding) => {
        const filename = binding.filename ?? t("原文件名不可用");
        return <div key={binding.configId} className="history-row">
          <strong>{filename}</strong>
          <button className="danger-outline" disabled={disabled}
            aria-label={t("移除 {filename} 的绑定", { filename })}
            onClick={() => onRemoveOrphan(binding)}>{t("移除绑定")}</button>
        </div>;
      })}
    </section>}
  </div>;
}
