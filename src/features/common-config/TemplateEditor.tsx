import { CodeEditor } from "../../components/CodeEditor";
import { Shortcuts } from "../../components/Shortcuts";
import type { TemplateDraft } from "../../types";

export function TemplateEditor({ draft, references, disabled, revealed, onReveal, onChange,
  onSave, onDelete, onCopy, onExtract, onShortcut }: {
  draft: TemplateDraft; references: number; disabled: boolean; revealed: boolean;
  onReveal: (value: boolean) => void; onChange: (draft: TemplateDraft) => void;
  onSave: () => void; onDelete: () => void; onCopy: () => void;
  onExtract: () => void; onShortcut: (key: string, enabled: boolean) => void;
}) {
  return <div className="form-section">
    <div className="section-title"><div><span className="eyebrow">COMMON CONFIGURATION</span><h2>编辑通用配置</h2></div>
      <span className="tag">{draft.id ? `${references} 个文件引用` : "新建草稿"}</span></div>
    <p className="muted">用于跨别名共享插件、环境变量和偏好。保存时自动更新绑定文件；个别配置中的同名项以此片段为准。</p>
    <label>通用配置名称<input value={draft.name} disabled={disabled} maxLength={120}
      onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="为这组配置起一个名称" /></label>
    <div className="editor-toolbar"><label className="check"><input type="checkbox" checked={revealed} disabled={disabled}
      onChange={(e) => onReveal(e.target.checked)} />显示配置明文并允许编辑</label>
      <button disabled={disabled || !revealed} onClick={onExtract}>从编辑内容提取通用部分</button></div>
    <CodeEditor kind={draft.kind} value={revealed ? draft.content : "配置内容默认隐藏。勾选上方选项后可查看与编辑。"}
      readOnly={disabled || !revealed} onChange={revealed ? (content) => onChange({ ...draft, content }) : undefined} />
    <Shortcuts kind={draft.kind} disabled={disabled || !revealed} onApply={onShortcut} />
    <div className="notice">清空片段会剥离旧的匹配内容，但保留模板及引用；不会在下次启动时自动重新提取。
      Codex 自动提取不含 MCP，手动写入时将明确提示风险。</div>
    <div className="actions"><button className="primary" disabled={disabled || !draft.name.trim()} onClick={onSave}>预览保存与同步</button>
      <button disabled={disabled} onClick={onCopy}>另存为新模板</button>
      {draft.id && <button className="danger-outline" disabled={disabled || references > 0}
        title={references ? "请先解绑或迁移所有引用文件" : "删除此通用配置"} onClick={onDelete}>删除模板</button>}</div>
  </div>;
}
