import { CodeEditor } from "../../components/CodeEditor";
import { Shortcuts } from "../../components/Shortcuts";
import type { Bootstrap, ConfigDraft, ConfigEntry } from "../../types";

export function ConfigEditor({ entry, draft, data, disabled, revealed, onReveal, onChange,
  onSave, onReload, onExtract, onDelete, onRemoveAlias, onShortcut }: {
  entry: ConfigEntry; draft: ConfigDraft | null; data: Bootstrap; disabled: boolean;
  revealed: boolean; onReveal: (value: boolean) => void; onChange: (draft: ConfigDraft) => void;
  onSave: () => void; onReload: () => void; onExtract: () => void; onDelete: () => void;
  onRemoveAlias: (name: string) => void; onShortcut: (key: string, enabled: boolean) => void;
}) {
  const templates = data.state.templates.filter((t) => t.kind === entry.kind);
  return <div className="form-section">
    <div className="section-title"><div><span className="eyebrow">ALIAS CONFIGURATION</span>
      <h2>{entry.aliases.join(" / ") || "手动导入的配置"}</h2></div><span className="tag">{entry.kind.toUpperCase()}</span></div>
    <p className="file-path">{entry.path}</p>
    {entry.aliases.length > 1 && <p className="notice">这些入口共享同一个真实文件，只能共同选择一份通用配置。</p>}
    {entry.error && <p className="error-box">{entry.error}</p>}
    {draft && <>
      {draft.notices.map((notice) => <p className="notice" key={notice}>{notice}</p>)}
      <div className="binding-row">
        <label className="check"><input type="checkbox" checked={!!draft.templateId} disabled={disabled || !templates.length}
          onChange={(e) => onChange({ ...draft, templateId: e.target.checked ? templates[0]?.id || null : null })} />应用通用配置</label>
        <select aria-label="选择通用配置" value={draft.templateId || ""} disabled={disabled}
          onChange={(e) => onChange({ ...draft, templateId: e.target.value || null })}>
          <option value="">不应用通用配置</option>{templates.map((t) => <option value={t.id} key={t.id}>{t.name} · v{t.revision}</option>)}
        </select>
        <span className="muted">选择仅修改草稿，保存后才落盘</span>
      </div>
      <div className="editor-toolbar"><label className="check"><input type="checkbox" checked={revealed} disabled={disabled}
        onChange={(e) => onReveal(e.target.checked)} />显示配置明文并允许编辑</label>
        <div><button disabled={disabled} onClick={onReload}>重新载入</button>
          <button disabled={disabled} onClick={onExtract}>提取为通用配置</button></div></div>
      <CodeEditor kind={entry.kind} value={revealed ? draft.content : "配置内容默认隐藏，避免凭据意外出现在屏幕上。勾选上方选项后可查看与编辑。"}
        readOnly={disabled || !revealed} onChange={revealed ? (content) => onChange({ ...draft, content }) : undefined} />
      <Shortcuts kind={entry.kind} disabled={disabled || !revealed} onApply={onShortcut} />
      <div className="notice">预览的是源文件的合并结果，不是已验证的 CLI 运行时最终配置。
        取消应用不会恢复曾被覆盖的旧值，需要时请使用备份。</div>
      <button className="primary" disabled={disabled} onClick={onSave}>预览保存配置及绑定</button>
    </>}
    <details className="danger-zone">
      <summary>别名与文件操作</summary>
      <p>移除入口保留文件；删除文件会真实删除源文件，并清理全部已识别的关联入口。</p>
      {entry.aliases.map((alias) => <button key={alias} disabled={disabled} className="danger-outline"
        onClick={() => onRemoveAlias(alias)}>仅移除 {alias}</button>)}
      <button className="danger" disabled={disabled || !!entry.error || !entry.hash} onClick={onDelete}>真实删除此文件及所有关联别名</button>
    </details>
  </div>;
}
