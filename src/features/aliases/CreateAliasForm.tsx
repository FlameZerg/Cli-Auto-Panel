import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "../../components/CodeEditor";
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
  const entries = data.inventory.configs.filter((c) => c.kind === kind && !c.error);
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
        <label>名称后缀<input value={name} disabled={disabled || copying} placeholder={kind === "codex" ? "字母、数字、点、短横线、下划线" : "支持中文名称"}
          onChange={(e) => change(() => setName(e.target.value))} /></label>
        {kind === "codex" && <label>启动版本<select value={launcher} disabled={disabled}
          onChange={(e) => change(() => setLauncher(e.target.value))}>
          <option value="codex">仅 codex 旧版</option><option value="codexnew">仅 codexnew 新版</option>
          <option value="both">旧版和新版共用文件</option></select></label>}
        <label>通用配置<select value={templateId} disabled={disabled} onChange={(e) => change(() => setTemplateId(e.target.value))}>
          <option value="">不应用</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select></label>
      </div>
      <div className="notice">将创建 {kind === "codex" ? `E:\\.codex\\ccs\\config.${name || "<名称>"}.toml` : `E:\\.claude\\settings.${name || "<名称>"}.json`}。
        {launcher === "both" && " 两个命令共享同一份配置和模板绑定。"}</div>
      <section className="copy-source">
        <h3>从已有配置复制</h3>
        <select value={sourceId} disabled={disabled || copying} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">选择已有文件</option>{entries.map((c) => <option key={c.id} value={c.id}>{c.aliases.join(" / ") || c.path}</option>)}
        </select>
        <button disabled={disabled || copying || !sourceId} onClick={() => void copySource()}>
          {copying ? "读取中…" : "复制到草稿"}</button>
      </section>
      <label>个别配置原文</label>
      <CodeEditor value={content} kind={kind} readOnly={disabled || copying}
        onChange={(value) => change(() => setContent(value))} />
      <button className="primary" disabled={disabled || copying || !name.trim()}
        onClick={() => onSubmit({ type: "createAlias", kind, launcher, name: name.trim(), content,
          templateId: templateId || null })}>新建文件并注册别名</button>
    </div>
  );
}
