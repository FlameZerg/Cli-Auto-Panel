import { CodeEditor } from "../../components/CodeEditor";
import { InlineNotice } from "../../components/InlineNotice";
import { MergePrioritySelect } from "./MergePrioritySelect";
import { configName, configPath, fileName } from "./configNames";
import { useMergePreview } from "../preview/useMergePreview";
import type { Bootstrap, ConfigDraft, ConfigEntry } from "../../types";
import { useI18n } from "../../theme";

export function ConfigEditor({ entry, draft, data, disabled, onChange,
  onSave, onPreview, onDelete, onForget, onRemoveAlias }: {
  entry: ConfigEntry; draft: ConfigDraft | null; data: Bootstrap; disabled: boolean;
  onChange: (draft: ConfigDraft) => void;
  onSave: () => void; onDelete: () => void;
  onPreview: () => void;
  onRemoveAlias: (name: string) => void;
  onForget: () => void;
}) {
  const { t } = useI18n();
  const templates = data.state.templates.filter((t) => t.kind === entry.kind);
  const selected = templates.find((t) => t.id === draft?.templateId);
  // 保留编辑器原文作为比较基线，实时预览后端将实际保存的合并结果。
  const showMergePreview = !!draft?.templateId;
  const merged = useMergePreview({
    kind: entry.kind, content: draft?.content ?? "", template: selected?.content ?? null,
    mergePriority: draft?.mergePriority ?? "current",
    configId: entry.id, revision: data.state.revision, enabled: showMergePreview,
  });
  const filename = draft && fileName(configPath(entry, draft.name));
  const rename = !!draft && draft.name !== configName(entry);
  const commands = entry.aliases
    .map((alias) => rename ? `${alias.slice(0, alias.indexOf("-") + 1)}${draft?.name}` : alias);
  const filenameHint = t("保存文件名：{filename}；命令：{commands}", { filename: filename || "",
    commands: commands.join(" / ") || t("无关联命令") });
  return <div className="form-section">
    {/* 别名标题及产品标签已在列表中呈现，右侧直接显示文件与编辑控件。 */}
    <p className="file-path" title={entry.path}>{entry.path}</p>
    <InlineNotice messages={[entry.error, ...(draft?.notices ?? [])]} tone="error" />
    {draft && <>
      <div className="form-row">
        <label>{t("文件名称后缀")}<input value={draft.name} disabled={disabled}
          placeholder={t("支持中文、字母、数字、点、短横线、下划线")}
          onChange={(e) => onChange({ ...draft, name: e.target.value })} /></label>
      </div>
      <p className="field-hint muted" title={filenameHint}>{filenameHint}</p>
      <div className="binding-row">
        <label className="check"><input type="checkbox" checked={!!draft.templateId} disabled={disabled || !templates.length}
          onChange={(e) => onChange({ ...draft, templateId: e.target.checked ? templates[0]?.id || null : null,
            mergePriority: e.target.checked ? "template" : draft.mergePriority })} />{t("应用通用配置")}</label>
        <select aria-label={t("选择通用配置")} value={draft.templateId || ""} disabled={disabled}
          onChange={(e) => onChange({ ...draft, templateId: e.target.value || null,
            mergePriority: e.target.value ? "template" : draft.mergePriority })}>
          {/* 选择项只显示通用配置名称，不展示内部同步版本。 */}
          <option value="">{t("不应用通用配置")}</option>{templates.map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}
        </select>
        {/* 新选择绑定默认应用通用值，持续同步由绑定开关控制。 */}
        <MergePrioritySelect value={draft.mergePriority} disabled={disabled || !draft.templateId}
          onChange={(mergePriority) => onChange({ ...draft, mergePriority })} />
      </div>
      {/* 差异直接装饰唯一的原文编辑器，不再在其下方重复渲染完整代码。 */}
      <CodeEditor key={entry.id} kind={entry.kind} value={draft.content}
        readOnly={disabled} onChange={(content) => onChange({ ...draft, content })}
        diff={showMergePreview ? merged : undefined} />
      <div className="actions"><button className="primary" disabled={disabled || !draft.name.trim()} onClick={onSave}>{t("保存配置及绑定")}</button>
        <button disabled={disabled || !draft.name.trim()} onClick={onPreview}>{t("查看合并差异")}</button></div>
    </>}
    <section className="file-actions">
      <h3>{t("别名与文件操作")}</h3>
      {entry.aliases.map((alias) => <button key={alias} disabled={disabled} className="danger-outline"
        onClick={() => onRemoveAlias(alias)}>{t("仅移除 {alias}", { alias })}</button>)}
      {entry.error || !draft || draft.notices.length > 0 ? <button className="danger-outline"
        disabled={disabled} onClick={onForget}>{t("移除管理记录")}</button> : null}
      {entry.hash && !entry.error && <button className="danger" disabled={disabled} onClick={onDelete}>
        {t("真实删除此文件及所有关联别名")}</button>}
    </section>
  </div>;
}
