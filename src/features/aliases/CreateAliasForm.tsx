import { useEffect, useRef, useState } from "react";
import { CodeEditor } from "../../components/CodeEditor";
import { api } from "../../api";
import type { Bootstrap, Change, Kind } from "../../types";

interface Props {
  kind: Kind;
  data: Bootstrap;
  disabled: boolean;
  onPrepare: (change: Change) => void;
  onDirty: () => void;
  onError: (error: unknown) => void;
}

export function CreateAliasForm({ kind, data, disabled, onPrepare, onDirty, onError }: Props) {
  const [name, setName] = useState("");
  const [launcher, setLauncher] = useState(kind === "codex" ? "codex" : "claude");
  const [templateId, setTemplateId] = useState("");
  const [content, setContent] = useState(kind === "codex" ? "" : "{}\n");
  const [sourceId, setSourceId] = useState("");
  const [copyApproved, setCopyApproved] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [copying, setCopying] = useState(false);
  const copySequence = useRef(0);
  useEffect(() => () => { copySequence.current += 1; }, []);
  const templates = data.state.templates.filter((t) => t.kind === kind);
  const entries = data.inventory.configs.filter((c) => c.kind === kind && !c.error);
  const change = (action: () => void) => { onDirty(); action(); };
  async function copySource() {
    if (!sourceId || !copyApproved || disabled) return;
    const sequence = ++copySequence.current;
    setCopying(true);
    try {
      const document = await api.readConfig(sourceId);
      if (sequence === copySequence.current) {
        setContent(document.content);
        setConfirmed(false);
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
      <details className="copy-source">
        <summary>可选：从已有配置复制（包含凭据，默认不复制）</summary>
        <select value={sourceId} disabled={disabled || copying} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">选择已有文件</option>{entries.map((c) => <option key={c.id} value={c.id}>{c.aliases.join(" / ") || c.path}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={copyApproved} onChange={(e) => setCopyApproved(e.target.checked)} />
          我明确允许把此文件的完整内容和凭据复制到新草稿</label>
        <button disabled={disabled || copying || !sourceId || !copyApproved} onClick={() => void copySource()}>
          {copying ? "读取中…" : "复制到草稿"}</button>
      </details>
      <label>个别配置原文（此编辑器为明文）</label>
      <CodeEditor value={content} kind={kind} readOnly={disabled || copying}
        onChange={(value) => change(() => setContent(value))} />
      <label className="check"><input type="checkbox" checked={confirmed} disabled={disabled || copying}
        onChange={(e) => setConfirmed(e.target.checked)} />已核对本配置中的账号、模型、路由及凭据，允许写入新文件</label>
      <button className="primary" disabled={disabled || copying || !name.trim() || !confirmed}
        onClick={() => onPrepare({ type: "createAlias", kind, launcher, name: name.trim(), content,
          templateId: templateId || null, credentialsConfirmed: confirmed })}>预览新建与注册</button>
    </div>
  );
}
