import { CodeEditor } from "../../components/CodeEditor";
import type { TemplateDraft } from "../../types";
import { useI18n } from "../../theme";

export function TemplateEditor({ draft, references, disabled, onChange,
  onSave, onPreview, onDelete, onCopy, onExtract }: {
  draft: TemplateDraft; references: number; disabled: boolean;
  onChange: (draft: TemplateDraft) => void;
  onSave: () => void; onDelete: () => void; onCopy: () => void;
  onPreview: () => void;
  onExtract: () => void;
}) {
  const { t } = useI18n();
  return <div className="form-section">
    <div className="section-title"><div><h2>{t("编辑通用配置")}</h2></div>
      {/* 与侧栏使用统一绑定计数文案，包含历史失效引用。 */}
      <span className="tag">{draft.id ? t("{count} 份绑定", { count: references }) : t("新建草稿")}</span></div>
    <label>{t("通用配置名称")}<input value={draft.name} disabled={disabled} maxLength={120}
      onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder={t("为这组配置起一个名称")} /></label>
    <div className="editor-toolbar">
      <button disabled={disabled} onClick={onExtract}>{t("从编辑内容提取通用部分")}</button></div>
    <CodeEditor kind={draft.kind} value={draft.content}
      readOnly={disabled} onChange={(content) => onChange({ ...draft, content })} />
    <div className="actions"><button className="primary" disabled={disabled || !draft.name.trim()} onClick={onSave}>{t("保存并同步")}</button>
      <button disabled={disabled || !draft.name.trim()} onClick={onPreview}>{t("查看差异")}</button>
      <button disabled={disabled} onClick={onCopy}>{t("另存为新模板")}</button>
      {/* 引用不再禁用删除；后端在同一事务内清理全部绑定，点击后先核对删除预览。 */}
      {draft.id && <button className="danger-outline" disabled={disabled}
        title={t("删除此通用配置并清理 {count} 份绑定，保留别名源文件", { count: references })} onClick={onDelete}>{t("删除模板")}</button>}</div>
  </div>;
}
