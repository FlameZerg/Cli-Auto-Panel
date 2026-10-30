import { CodeEditor } from "../../components/CodeEditor";
import { InlineNotice } from "../../components/InlineNotice";
import { MergePrioritySelect } from "./MergePrioritySelect";
import { useMergePreview } from "../preview/useMergePreview";
import type { Bootstrap, CodexLauncher, ConfigDraft, ConfigEntry } from "../../types";

export function ConfigEditor({ entry, draft, data, disabled, onChange,
  onSave, onPreview, onReload, onExtract, onDelete, onRemoveAlias, onLauncherChange }: {
  entry: ConfigEntry; draft: ConfigDraft | null; data: Bootstrap; disabled: boolean;
  onChange: (draft: ConfigDraft) => void;
  onSave: () => void; onReload: () => void; onExtract: () => void; onDelete: () => void;
  onPreview: () => void;
  onRemoveAlias: (name: string) => void;
  onLauncherChange: (launcher: CodexLauncher) => void;
}) {
  const templates = data.state.templates.filter((t) => t.kind === entry.kind);
  const selected = templates.find((t) => t.id === draft?.templateId);
  // 保留编辑器原文作为比较基线，实时预览后端将实际保存的新版合并结果。
  const showMergePreview = !!draft?.templateId;
  const merged = useMergePreview({
    kind: entry.kind, content: draft?.content ?? "", template: selected?.content ?? null,
    mergePriority: draft?.mergePriority ?? "current",
    configId: entry.id, revision: data.state.revision, enabled: showMergePreview,
  });
  // 名称修改只更新草稿；所有共享入口保留各自启动器前缀，随保存一起变更。
  const filename = draft && (entry.kind === "codex" ? `config.${draft.name}.toml` : `settings.${draft.name}.json`);
  const currentFilename = entry.path.slice(Math.max(entry.path.lastIndexOf("\\"), entry.path.lastIndexOf("/")) + 1);
  const renaming = !!draft && filename !== currentFilename;
  const commands = draft && entry.aliases.map((alias) => renaming
    ? `${alias.slice(0, alias.indexOf("-") + 1)}${draft.name}` : alias);
  // 版本取自已保存的命令入口；切换立即提交，不混入文件名或正文草稿。
  const hasOld = entry.aliases.some((alias) => alias.toLowerCase().startsWith("codex-"));
  const hasNew = entry.aliases.some((alias) => alias.toLowerCase().startsWith("codexnew-"));
  const launcher = hasOld && hasNew ? "both" : hasNew ? "codexnew" : hasOld ? "codex" : "";
  const filenameHint = `保存文件名：${filename}；命令：${commands?.join(" / ") || "无关联命令"}`;
  return <div className="form-section">
    {/* 别名标题及产品标签已在列表中呈现，右侧直接显示文件与编辑控件。 */}
    <p className="file-path" title={entry.path}>{entry.path}</p>
    {/* 后端不再返回共享说明，这里只呈现真实的读取、语法及兼容性错误。 */}
    <InlineNotice messages={[entry.error, ...(draft?.notices ?? [])]} tone="error" />
    {draft && <>
      <div className="form-row">
        <label>文件名称后缀<input value={draft.name} disabled={disabled}
          placeholder="支持中文、字母、数字、点、短横线、下划线"
          onChange={(e) => onChange({ ...draft, name: e.target.value })} /></label>
        {entry.kind === "codex" && <label>启动版本（即时保存）<select value={launcher} disabled={disabled}
          onChange={(event) => onLauncherChange(event.target.value as CodexLauncher)}>
          {!launcher && <option value="" disabled>尚无命令入口</option>}
          <option value="codex">仅 Codex 旧版</option>
          <option value="codexnew">仅 Codex 新版</option>
          <option value="both">旧版和新版共用</option>
        </select></label>}
      </div>
      <p className="field-hint muted" title={filenameHint}>{filenameHint}</p>
      <div className="binding-row">
        <label className="check"><input type="checkbox" checked={!!draft.templateId} disabled={disabled || !templates.length}
          onChange={(e) => onChange({ ...draft, templateId: e.target.checked ? templates[0]?.id || null : null })} />应用通用配置</label>
        <select aria-label="选择通用配置" value={draft.templateId || ""} disabled={disabled}
          onChange={(e) => onChange({ ...draft, templateId: e.target.value || null })}>
          {/* 选择项只显示通用配置名称，不展示内部同步版本。 */}
          <option value="">不应用通用配置</option>{templates.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}
        </select>
        {/* 优先级随草稿保存；未应用通用配置时禁用，避免产生无效设置。 */}
        <MergePrioritySelect value={draft.mergePriority} disabled={disabled || !draft.templateId}
          onChange={(mergePriority) => onChange({ ...draft, mergePriority })} />
      </div>
      <div className="editor-toolbar">
        <div><button disabled={disabled} onClick={onReload}>重新载入</button>
          <button disabled={disabled} onClick={onExtract}>提取为通用配置</button></div></div>
      {/* 差异直接装饰唯一的原文编辑器，不再在其下方重复渲染完整代码。 */}
      <CodeEditor kind={entry.kind} value={draft.content}
        readOnly={disabled} onChange={(content) => onChange({ ...draft, content })}
        diff={showMergePreview ? merged : undefined} />
      <div className="actions"><button className="primary" disabled={disabled || !draft.name.trim()} onClick={onSave}>保存配置及绑定</button>
        <button disabled={disabled || !draft.name.trim()} onClick={onPreview}>查看合并差异</button></div>
    </>}
    <section className="file-actions">
      <h3>别名与文件操作</h3>
      {entry.aliases.map((alias) => <button key={alias} disabled={disabled} className="danger-outline"
        onClick={() => onRemoveAlias(alias)}>仅移除 {alias}</button>)}
      <button className="danger" disabled={disabled || !!entry.error || !entry.hash} onClick={onDelete}>真实删除此文件及所有关联别名</button>
    </section>
  </div>;
}
