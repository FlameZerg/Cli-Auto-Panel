import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "../../components/CodeEditor";
import { useMergePreview } from "../preview/useMergePreview";
import { api } from "../../api";
import type { Bootstrap, Change, Kind } from "../../types";

interface Props {
  kind: Kind;
  data: Bootstrap;
  disabled: boolean;
  onSubmit: (change: Change) => void;
  onDirty: () => void;
  onError: (error: unknown) => void;
}

export function CreateAliasForm({ kind, data, disabled, onSubmit, onDirty, onError }: Props) {
  const [name, setName] = useState("");
  const [launcher, setLauncher] = useState(kind === "codex" ? "codex" : "claude");
  const [templateId, setTemplateId] = useState("");
  const [content, setContent] = useState(kind === "codex" ? "" : "{}\n");
  const [sourceId, setSourceId] = useState("");
  const [copying, setCopying] = useState(false);
  const copySequence = useRef(0);
  useEffect(() => () => { copySequence.current += 1; }, []);
  const templates = data.state.templates.filter((t) => t.kind === kind);
  const selected = templates.find((t) => t.id === templateId);
  // 新建表单也保留未合并草稿，避免反复切换模板后累积旧片段或无法取消应用。
  const merged = useMergePreview({
    kind, content, template: selected?.content ?? null, revision: data.state.revision, enabled: !!selected,
  });
  const entries = data.inventory.configs.filter((c) => c.kind === kind && !c.error);
  // 路径提示使用后端实际目录，并统一末尾分隔符以兼容环境变量覆盖。
  const root = (kind === "codex" ? data.codexRoot : data.claudeRoot).replace(/[\\/]+$/, "");
  const filename = kind === "codex" ? `config.${name.trim() || "<名称>"}.toml` : `settings.${name.trim() || "<名称>"}.json`;
  const change = (action: () => void) => { onDirty(); action(); };
  async function copySource() {
    if (!sourceId || disabled || copying) return;
    const sequence = ++copySequence.current;
    setCopying(true);
    try {
      const document = await api.readConfig(sourceId);
      if (sequence === copySequence.current) {
        setContent(document.content);
        onDirty();
      }
    } catch (error) { if (sequence === copySequence.current) onError(error); }
    finally { if (sequence === copySequence.current) setCopying(false); }
  }
  return (
    <div className="form-section">
      <div className="section-title"><div><span className="eyebrow">NEW CONFIGURATION</span><h2>新建别名配置</h2></div>
        <span className="tag">{kind === "codex" ? "TOML" : "JSON"}</span></div>
      <p className="muted">配置文件、别名注册和通用配置绑定将一起提交。已有文件或命令不会被覆盖。</p>
      <div className="form-row">
        <label>名称后缀<input value={name} disabled={disabled || copying} placeholder="支持中文、字母、数字、点、短横线、下划线"
          onChange={(e) => change(() => setName(e.target.value))} /></label>
        {kind === "codex" && <label>启动版本<select value={launcher} disabled={disabled}
          onChange={(e) => change(() => setLauncher(e.target.value))}>
          <option value="codex">仅 codex 旧版</option><option value="codexnew">仅 codexnew 新版</option>
          <option value="both">旧版和新版共用文件</option></select></label>}
        <label>通用配置<select value={templateId} disabled={disabled}
          onChange={(e) => change(() => setTemplateId(e.target.value))}>
          <option value="">不应用</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select></label>
      </div>
      <div className="notice">将创建 {`${root}\\${filename}`}。
        {launcher === "both" && " 两个命令共享同一份配置和模板绑定。"}</div>
      <section className="copy-source">
        <h3>从已有配置复制</h3>
        <select value={sourceId} disabled={disabled || copying} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">选择已有文件</option>{entries.map((c) => <option key={c.id} value={c.id}>{c.aliases.join(" / ") || c.path}</option>)}
        </select>
        <button disabled={disabled || copying || !sourceId} onClick={() => void copySource()}>
          {copying ? "读取中…" : "复制到草稿"}</button>
      </section>
      <label>个别配置{selected ? "（同一编辑器内红删绿增，绿色新增行仅预览）" : "原文"}</label>
      {/* 与已有配置页共用内联差异，预览内容不混入新建文件的原始草稿。 */}
      <CodeEditor value={content} kind={kind} readOnly={disabled || copying}
        onChange={(value) => change(() => setContent(value))}
        diff={selected ? { ...merged, label: `当前草稿 → 应用「${selected.name}」` } : undefined} />
      <button className="primary" disabled={disabled || copying || !name.trim()}
        onClick={() => onSubmit({ type: "createAlias", kind, launcher, name: name.trim(), content,
          templateId: templateId || null })}>新建文件并注册别名</button>
    </div>
  );
}
