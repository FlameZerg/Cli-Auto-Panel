import { CodeEditor } from "../../components/CodeEditor";
import { useMergePreview } from "../preview/useMergePreview";
import type { Bootstrap, ConfigDraft, ConfigEntry } from "../../types";

export function ConfigEditor({ entry, draft, data, disabled, onChange,
  onSave, onPreview, onReload, onExtract, onDelete, onRemoveAlias }: {
  entry: ConfigEntry; draft: ConfigDraft | null; data: Bootstrap; disabled: boolean;
  onChange: (draft: ConfigDraft) => void;
  onSave: () => void; onReload: () => void; onExtract: () => void; onDelete: () => void;
  onPreview: () => void;
  onRemoveAlias: (name: string) => void;
}) {
  const templates = data.state.templates.filter((t) => t.kind === entry.kind);
  const binding = data.state.bindings.find((b) => b.configId === entry.id);
  const selected = templates.find((t) => t.id === draft?.templateId);
  // 保留编辑器原文作为比较基线，实时预览后端将实际保存的新版合并结果。
  const showMergePreview = !!draft && (!!draft.templateId || !!binding);
  const merged = useMergePreview({
    kind: entry.kind, content: draft?.content ?? "", template: selected?.content ?? null,
    configId: entry.id, revision: data.state.revision, enabled: showMergePreview,
  });
  // 名称修改只更新草稿；所有共享入口保留各自启动器前缀，随保存一起变更。
  const filename = draft && (entry.kind === "codex" ? `config.${draft.name}.toml` : `settings.${draft.name}.json`);
  const currentFilename = entry.path.slice(Math.max(entry.path.lastIndexOf("\\"), entry.path.lastIndexOf("/")) + 1);
  const renaming = !!draft && filename !== currentFilename;
  const commands = draft && entry.aliases.map((alias) => renaming
    ? `${alias.slice(0, alias.indexOf("-") + 1)}${draft.name}` : alias);
  return <div className="form-section">
    <div className="section-title"><div><span className="eyebrow">ALIAS CONFIGURATION</span>
      <h2>{entry.aliases.join(" / ") || "手动导入的配置"}</h2></div><span className="tag">{entry.kind.toUpperCase()}</span></div>
    <p className="file-path">{entry.path}</p>
    {entry.aliases.length > 1 && <p className="notice">这些入口共享同一个真实文件，只能共同选择一份通用配置。</p>}
    {entry.error && <p className="error-box">{entry.error}</p>}
    {draft && <>
      {draft.notices.map((notice) => <p className="notice" key={notice}>{notice}</p>)}
      <label>文件名称后缀<input value={draft.name} disabled={disabled}
        placeholder="支持中文、字母、数字、点、短横线、下划线"
        onChange={(e) => onChange({ ...draft, name: e.target.value })} /></label>
      <p className="muted">保存文件名：{filename}。{commands?.length
        ? `对应命令：${commands.join(" / ")}。${renaming ? "重命名后旧命令入口将移除，新命令在新开的 PowerShell 终端生效。" : ""}`
        : "此文件没有关联命令，重命名不会新建命令入口。"}</p>
      <div className="binding-row">
        <label className="check"><input type="checkbox" checked={!!draft.templateId} disabled={disabled || !templates.length}
          onChange={(e) => onChange({ ...draft, templateId: e.target.checked ? templates[0]?.id || null : null })} />应用通用配置</label>
        <select aria-label="选择通用配置" value={draft.templateId || ""} disabled={disabled}
          onChange={(e) => onChange({ ...draft, templateId: e.target.value || null })}>
          {/* 选择项只显示通用配置名称，不展示内部同步版本。 */}
          <option value="">不应用通用配置</option>{templates.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
        </select>
        <span className="muted">在下方同一编辑器内显示红删绿增；原文可编辑，绿色新增行仅预览，保存后写入文件</span>
      </div>
      <div className="editor-toolbar">
        <div><button disabled={disabled} onClick={onReload}>重新载入</button>
          <button disabled={disabled} onClick={onExtract}>提取为通用配置</button></div></div>
      {/* 差异直接装饰唯一的原文编辑器，不再在其下方重复渲染完整代码。 */}
      <CodeEditor kind={entry.kind} value={draft.content}
        readOnly={disabled} onChange={(content) => onChange({ ...draft, content })}
        diff={showMergePreview ? { ...merged,
          label: selected ? `当前草稿 → 应用「${selected.name}」` : "当前草稿 → 取消通用配置",
        } : undefined} />
      <div className="notice">预览的是源文件的合并结果，不是已验证的 CLI 运行时最终配置。
        取消应用不会恢复曾被覆盖的旧值，需要时请使用备份。</div>
      <div className="actions"><button className="primary" disabled={disabled || !draft.name.trim()} onClick={onSave}>保存配置及绑定</button>
        <button disabled={disabled || !draft.name.trim()} onClick={onPreview}>查看合并差异</button></div>
    </>}
    <section className="file-actions">
      <h3>别名与文件操作</h3>
      <p>移除入口保留文件；删除文件会真实删除源文件，并清理全部已识别的关联入口。</p>
      {entry.aliases.map((alias) => <button key={alias} disabled={disabled} className="danger-outline"
        onClick={() => onRemoveAlias(alias)}>仅移除 {alias}</button>)}
      <button className="danger" disabled={disabled || !!entry.error || !entry.hash} onClick={onDelete}>真实删除此文件及所有关联别名</button>
    </section>
  </div>;
}
