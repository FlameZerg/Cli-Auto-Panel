import { CodeEditor } from "../../components/CodeEditor";
import type { TemplateDraft } from "../../types";

export function TemplateEditor({ draft, references, disabled, onChange,
  onSave, onSaveOnly, onPreview, onDelete, onCopy, onExtract }: {
  draft: TemplateDraft; references: number; disabled: boolean;
  onChange: (draft: TemplateDraft) => void;
  onSave: () => void; onDelete: () => void; onCopy: () => void;
  onSaveOnly: () => void;
  onPreview: () => void;
  onExtract: () => void;
}) {
  return <div className="form-section">
    <div className="section-title"><div><span className="eyebrow">COMMON CONFIGURATION</span><h2>编辑通用配置</h2></div>
      {/* 与侧栏使用统一绑定计数文案，包含历史失效引用。 */}
      <span className="tag">{draft.id ? `${references} 份绑定` : "新建草稿"}</span></div>
    <p className="muted">用于跨别名共享插件、环境变量和偏好。保存并同步会更新绑定文件；个别配置中的同名项以此片段为准。</p>
    <label>通用配置名称<input value={draft.name} disabled={disabled} maxLength={120}
      onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="为这组配置起一个名称" /></label>
    <div className="editor-toolbar">
      <button disabled={disabled} onClick={onExtract}>从编辑内容提取通用部分</button></div>
    <CodeEditor kind={draft.kind} value={draft.content}
      readOnly={disabled} onChange={(content) => onChange({ ...draft, content })} />
    <div className="notice">清空片段并同步后会剥离旧的匹配内容，但保留模板及引用；不会在下次启动时自动重新提取。
      Codex 自动提取不含 MCP，可直接在编辑器中补充。</div>
    <div className="notice">仅保存模板不会改动引用文件，可用于先修复模板内容；删除会清理模板及全部绑定，
      保留别名源文件和现有内容。模板存储在通用配置库中，删除不是仅隐藏卡片。</div>
    <div className="actions"><button className="primary" disabled={disabled || !draft.name.trim()} onClick={onSave}>保存并同步</button>
      <button disabled={disabled || !draft.name.trim()} onClick={onSaveOnly}>仅保存模板</button>
      <button disabled={disabled || !draft.name.trim()} onClick={onPreview}>查看差异</button>
      <button disabled={disabled} onClick={onCopy}>另存为新模板</button>
      {/* 引用不再禁用删除；后端在同一事务内清理全部绑定，点击后先核对删除预览。 */}
      {draft.id && <button className="danger-outline" disabled={disabled}
        title={`删除此通用配置并清理 ${references} 份绑定，保留别名源文件`} onClick={onDelete}>删除模板</button>}</div>
  </div>;
}
