import { CodeEditor } from "../../components/CodeEditor";
import type { TemplateDraft } from "../../types";

export function TemplateEditor({ draft, references, disabled, onChange,
  onSave, onPreview, onDelete, onCopy, onExtract }: {
  draft: TemplateDraft; references: number; disabled: boolean;
  onChange: (draft: TemplateDraft) => void;
  onSave: () => void; onDelete: () => void; onCopy: () => void;
  onPreview: () => void;
  onExtract: () => void;
}) {
  return <div className="form-section">
    <div className="section-title"><div><span className="eyebrow">COMMON CONFIGURATION</span><h2>编辑通用配置</h2></div>
      {/* 与侧栏使用统一绑定计数文案，包含历史失效引用。 */}
      <span className="tag">{draft.id ? `${references} 份绑定` : "新建草稿"}</span></div>
    <label>通用配置名称<input value={draft.name} disabled={disabled} maxLength={120}
      onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="为这组配置起一个名称" /></label>
    <div className="editor-toolbar">
      <button disabled={disabled} onClick={onExtract}>从编辑内容提取通用部分</button></div>
    <CodeEditor kind={draft.kind} value={draft.content}
      readOnly={disabled} onChange={(content) => onChange({ ...draft, content })} />
    <div className="actions"><button className="primary" disabled={disabled || !draft.name.trim()} onClick={onSave}>保存并同步</button>
      <button disabled={disabled || !draft.name.trim()} onClick={onPreview}>查看差异</button>
      <button disabled={disabled} onClick={onCopy}>另存为新模板</button>
      {/* 引用不再禁用删除；后端在同一事务内清理全部绑定，点击后先核对删除预览。 */}
      {draft.id && <button className="danger-outline" disabled={disabled}
        title={`删除此通用配置并清理 ${references} 份绑定，保留别名源文件`} onClick={onDelete}>删除模板</button>}</div>
  </div>;
}
