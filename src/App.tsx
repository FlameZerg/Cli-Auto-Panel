import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { ConfigEditor } from "./features/aliases/ConfigEditor";
import { CreateAliasForm } from "./features/aliases/CreateAliasForm";
import { ImportForm } from "./features/aliases/ImportForm";
import { TemplateEditor } from "./features/common-config/TemplateEditor";
import { PreviewDialog } from "./features/preview/PreviewDialog";
import { useTheme } from "./theme";
import type { Bootstrap, Change, ConfigDraft, ConfigEntry, Kind, Preview, TemplateDraft } from "./types";

type Page = "welcome" | "template" | "config" | "create" | "import" | "history";

// 主题切换是即时呈现开关：不参与业务 busy 状态，避免与配置读写流程互相阻塞。
function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return <button onClick={toggle} aria-label="切换深色浅色模式"
    title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}>
    {theme === "dark" ? "浅色模式" : "深色模式"}</button>;
}

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [kind, setKind] = useState<Kind>("codex");
  const [page, setPage] = useState<Page>("welcome");
  const [selected, setSelected] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft | null>(null);
  const [configDraft, setConfigDraft] = useState<ConfigDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  // 普通保存不打开预览，但仍展示后端生成的操作范围与兼容性提示。
  const [operationNotices, setOperationNotices] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [preparedChange, setPreparedChange] = useState<Change | null>(null);
  const [search, setSearch] = useState("");
  const sequence = useRef(0);
  const closingRef = useRef(false);
  // 仅写盘流程保护退出；初始化或普通读取失败不应让窗口无法关闭。
  const writingRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    let live = true;
    setBusy("读取本地配置清单…");
    api.bootstrap().then((result) => { if (live) setData(result); })
      .catch((failure) => { if (live) setError(String(failure)); })
      .finally(() => { if (live) setBusy(""); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    const currentWindow = getCurrentWindow();
    const blockCloseWhileWriting = () => {
      if (!writingRef.current) return false;
      if (live) setError("配置正在写入或恢复，请等结果返回后关闭窗口，避免中断文件提交。");
      return true;
    };
    const destroyWindow = async () => {
      if (closingRef.current || blockCloseWhileWriting()) return;
      closingRef.current = true;
      try { await currentWindow.destroy(); }
      catch (failure) {
        closingRef.current = false;
        if (live) setError(`无法关闭窗口：${String(failure)}`);
      }
    };
    const unlisten = currentWindow.onCloseRequested(async (event) => {
      // 自己接管销毁及错误回显，避免 API 内部的异步销毁失败无人处理。
      event.preventDefault();
      if (closingRef.current || blockCloseWhileWriting()) return;
      await destroyWindow();
    }).catch((failure) => { if (live) setError(`无法注册窗口关闭保护：${String(failure)}`); return () => {}; });
    return () => { live = false; void unlisten.then((dispose) => dispose()); };
  }, []);

  const disabled = !data || !!busy || !!data.pendingRecovery;
  const entry = data?.inventory.configs.find((c) => c.id === selected);
  const templates = data?.state.templates.filter((t) => t.kind === kind) || [];
  const configs = data?.inventory.configs.filter((c) =>
    c.kind === kind && `${c.aliases.join(" ")} ${c.path}`.toLowerCase().includes(search.toLowerCase())) || [];

  async function perform(label: string, action: () => Promise<void>, writesFiles = false) {
    if (busyRef.current || closingRef.current) return;
    busyRef.current = label;
    writingRef.current = writesFiles;
    setBusy(label); setError(""); setMessage(""); setOperationNotices([]);
    try { await action(); } catch (failure) { setError(String(failure)); }
    finally { writingRef.current = false; busyRef.current = ""; setBusy(""); }
  }

  function navigate(action: () => void) {
    if (busyRef.current || closingRef.current) return;
    setDirty(false); sequence.current += 1; action();
  }

  function openTemplate(draft: TemplateDraft) {
    setTemplateDraft(draft); setSelected(null); setPage("template"); setDirty(!draft.id);
    setError(""); setMessage(""); setOperationNotices([]);
  }

  async function loadEntry(target: ConfigEntry, current: Bootstrap) {
    const operation = ++sequence.current;
    setSelected(target.id); setPage("config"); setConfigDraft(null); setDirty(false);
    if (target.error) return;
    const document = await api.readConfig(target.id);
    if (operation !== sequence.current) return;
    const binding = current.state.bindings.find((b) => b.configId === target.id);
    setConfigDraft({ id: target.id, content: document.content, hash: document.hash,
      notices: document.notices, templateId: binding?.templateId || null });
  }

  function chooseEntry(target: ConfigEntry) {
    navigate(() => { if (data) void perform("读取配置文件…", () => loadEntry(target, data)); });
  }

  function applyChange(change: Change, previewOnly = false) {
    if (!data || disabled) return;
    // 预览只在主动点击时显示；普通保存和删除沿用同一计划后直接提交。
    void perform(previewOnly ? "生成差异预览…" : "执行配置操作…", async () => {
      const result = await api.prepare(data.state.revision, change);
      if (previewOnly) {
        setPreparedChange(change); setPreview(result);
      } else {
        await commitPlan(result, change);
      }
    }, !previewOnly);
  }

  // 提交或恢复失败后重新读取真实状态；读取失败时停止新修改，避免沿用旧状态。
  async function refreshAfterFailure(failure: unknown): Promise<never> {
    try {
      setData(await api.bootstrap());
    } catch (refreshError) {
      setData(null);
      throw new Error(`${String(failure)}；刷新恢复状态失败：${String(refreshError)}`);
    }
    throw failure;
  }

  async function commitPlan(plan: Preview, change: Change) {
    let result: Bootstrap;
    try {
      result = await api.commit(plan.id);
    } catch (failure) {
      setPreview(null); setPreparedChange(null);
      return refreshAfterFailure(failure);
    }
    setData(result); setPreview(null); setPreparedChange(null); setDirty(false);
    sequence.current += 1;
    // 落盘已完成，后续编辑器重读失败不能被当作提交失败或引导重复执行。
    try {
      if (change.type === "saveTemplate") {
        const template = result.state.templates.find((t) => change.id ? t.id === change.id : t.kind === change.kind && t.name === change.name.trim());
        if (template) openTemplate({ ...template });
      } else if (change.type === "saveConfig") {
        const target = result.inventory.configs.find((c) => c.id === change.id);
        if (target) await loadEntry(target, result);
      } else if (change.type === "createAlias") {
        const prefix = change.kind === "claude" ? "claude" : change.launcher === "codexnew" ? "codexnew" : "codex";
        const target = result.inventory.configs.find((c) => c.aliases.includes(`${prefix}-${change.name}`));
        if (target) await loadEntry(target, result);
      } else {
        setSelected(null); setPage("welcome"); setConfigDraft(null); setTemplateDraft(null);
      }
    } catch (failure) {
      throw new Error(`操作已落盘，但编辑内容重新载入失败：${String(failure)}。请重新载入或刷新清单，无需重复提交。`);
    } finally {
      setMessage("操作已落盘并通过保存链路回读校验。");
      setOperationNotices(plan.notices);
    }
  }

  async function commit() {
    const currentPreview = preview;
    const currentChange = preparedChange;
    if (!currentPreview || !currentChange) return;
    await perform("提交并校验配置…", () => commitPlan(currentPreview, currentChange), true);
  }

  function recover() {
    void perform("检查并恢复未完成操作…", async () => {
      try {
        const result = await api.recover();
        setData(result); setDirty(false); setSelected(null); setPage("welcome");
        setConfigDraft(null); setTemplateDraft(null);
        setMessage("未完成操作已处理。");
      } catch (failure) {
        return refreshAfterFailure(failure);
      }
    }, true);
  }

  function saveTemplate(previewOnly = false) {
    if (templateDraft) applyChange({ type: "saveTemplate", ...templateDraft }, previewOnly);
  }

  function saveConfig(previewOnly = false) {
    if (entry && configDraft) applyChange({ type: "saveConfig", id: entry.id, content: configDraft.content,
      templateId: configDraft.templateId, expectedHash: configDraft.hash }, previewOnly);
  }

  function refresh() {
    navigate(() => { void perform("刷新文件与绑定状态…", async () => {
      const result = await api.bootstrap(); setData(result); setPage("welcome");
      setSelected(null); setConfigDraft(null); setTemplateDraft(null); setMessage("已重新读取文件及 profile。");
    }); });
  }

  function extractContent(content: string, target: "template" | "new") {
    void perform("提取公共片段…", async () => {
      const result = await api.extract(kind, content);
      if (target === "template" && templateDraft) {
        setTemplateDraft({ ...templateDraft, content: result.content }); setDirty(true);
      } else {
        openTemplate({ id: null, name: "", kind, content: result.content });
      }
      setMessage(result.excluded.length ? `已排除专属字段：${result.excluded.join("、")}。` : "已提取公共内容。");
    });
  }

  function shortcut(key: string, enabled: boolean) {
    const content = page === "template" ? templateDraft?.content : configDraft?.content;
    if (content === undefined) return;
    const baseline = content;
    const operation = sequence.current;
    void perform("更新草稿快捷设置…", async () => {
      const updated = await api.shortcut(kind, baseline, key, enabled);
      if (operation !== sequence.current) return;
      if (page === "template" && templateDraft) setTemplateDraft({ ...templateDraft, content: updated });
      if (page === "config" && configDraft) setConfigDraft({ ...configDraft, content: updated });
      setDirty(true);
    });
  }

  const resetPage = (next: Page) => {
    setPage(next); setSelected(null); setDirty(false); setError(""); setMessage(""); setOperationNotices([]);
  };
  return <div className="app-shell">
    <aside className="rail">
      <div className="brand"><span className="brand-mark">CLI</span><div><strong>Auto Panel</strong><small>本地配置工作台</small></div></div>
      <div className="product-tabs">
        {(["codex", "claude"] as Kind[]).map((value) => <button key={value} className={kind === value ? "active" : ""}
          disabled={!!busy} onClick={() => navigate(() => { setKind(value); resetPage("welcome"); })}>{value === "codex" ? "Codex" : "Claude"}</button>)}
      </div>
      <div className="sidebar-heading"><span>通用配置</span><button disabled={disabled} onClick={() => navigate(() =>
        openTemplate({ id: null, name: "", kind, content: kind === "claude" ? "{}\n" : "" }))}>新建</button></div>
      <nav className="template-list" aria-label="通用配置列表">
        {templates.map((template) => {
          const count = data?.state.bindings.filter((b) => b.templateId === template.id).length || 0;
          return <button key={template.id} disabled={!!busy} className={page === "template" && templateDraft?.id === template.id ? "selected" : ""}
            onClick={() => navigate(() => openTemplate({ ...template }))}><span>{template.name}</span><small>v{template.revision} · {count} 份文件</small></button>;
        })}
        {!templates.length && <p className="sidebar-empty">还没有通用配置<br />可从现有文件中提取</p>}
      </nav>
      <div className="sidebar-bottom">
        <button disabled={disabled} onClick={() => navigate(() => resetPage("create"))}>新建别名与文件</button>
        <button disabled={disabled} onClick={() => navigate(() => resetPage("import"))}>导入已有配置</button>
        <button disabled={!!busy} onClick={() => navigate(() => resetPage("history"))}>备份与恢复</button>
      </div>
    </aside>
    <main>
      <header className="topbar"><div><span className="eyebrow">{kind === "codex" ? "CODEX / CODEXNEW" : "CLAUDE CODE"}</span>
        <h1>通用配置管理</h1></div><div className="topbar-actions">
        {dirty && <span className="draft-indicator">草稿未保存</span>}
        <ThemeToggle />
        <button disabled={!!busy} onClick={refresh}>刷新清单</button></div></header>
      {busy && <div className="progress" role="status">{busy}</div>}
      {error && <div className="error-box" role="alert">{error}<button className="quiet" onClick={() => setError("")}>关闭提示</button></div>}
      {message && <div className="success-box" role="status">{message}<button className="quiet" onClick={() => setMessage("")}>关闭提示</button></div>}
      {operationNotices.length > 0 && <div className="notice global-notice" role="status">
        {operationNotices.map((notice) => <div key={notice}>{notice}</div>)}
        <button className="quiet" onClick={() => setOperationNotices([])}>关闭操作提示</button>
      </div>}
      {data?.pendingRecovery && <div className="error-box">
        <strong>检测到上次未完成的写入，所有新修改已暂停。</strong><p>恢复前会核对全部文件；遇到外部新内容时会停止，不强制覆盖。</p>
        <button className="danger" disabled={!!busy} onClick={recover}>检查并恢复</button></div>}
      {data?.inventory.warnings.map((warning) => <div className="notice global-notice" key={warning}>{warning}</div>)}
      {!data ? <div className="welcome"><h2>{busy ? "正在读取本地配置…" : "面板尚未就绪"}</h2>
        <p>需要读取指定的 PowerShell profile。不会执行其中的命令，也不会自动改写已有配置。</p>
        {!busy && <button onClick={refresh}>重试读取</button>}</div> :
        <div className="workspace">
          <section className="config-column"><div className="column-title"><h2>别名配置文件</h2><span>{configs.length}</span></div>
            <input className="search" aria-label="搜索别名或文件" value={search} placeholder="搜索别名或文件…" onChange={(e) => setSearch(e.target.value)} />
            <div className="config-list">{configs.map((config) => {
              const binding = data.state.bindings.find((b) => b.configId === config.id);
              const template = data.state.templates.find((t) => t.id === binding?.templateId);
              const health = config.error ? "读取错误" : binding ? binding.lastHash === config.hash ? "已同步" : "外部已修改" : "未绑定";
              return <button key={config.id} disabled={!!busy} className={`config-card ${selected === config.id && page === "config" ? "selected" : ""}`}
                onClick={() => chooseEntry(config)}>
                <div className="card-label"><strong>{config.aliases.join(" / ") || "手动导入"}</strong>
                  <span className={`status ${config.error || health === "外部已修改" ? "warning" : binding ? "synced" : ""}`}>{health}</span></div>
                <span className="card-path" title={config.path}>{config.path.split(/[\\/]/).pop()}</span>
                <span className="card-template">{template ? `通用配置：${template.name}` : "保留原配置，可手动选择模板"}</span>
              </button>;
            })}{!configs.length && <p className="empty-small">没有符合条件的配置文件。可新建别名，或手动导入受管目录中的文件。</p>}</div>
            <div className="column-footer">{data.inventory.configs.length} 份文件 · {data.inventory.configs.reduce((sum, c) => sum + c.aliases.length, 0)} 个命令入口</div>
          </section>
          <section className="editor-column">
            {page === "welcome" && <div className="welcome"><span className="welcome-label">{kind === "codex" ? "TOML" : "JSON"}</span>
              <h2>一份偏好，多份配置</h2><p>从左侧选择配置文件，或创建一份通用配置。<br />模板优先覆盖同名项，其他个别设置保留。</p>
              <div className="welcome-steps"><div><b>01</b>编辑通用片段</div><div><b>02</b>为文件选择模板</div><div><b>03</b>保存并同步</div></div>
              <p className="muted">新建 / 删除别名会精确维护 PowerShell profile；已有终端与会话不会被重载或终止。</p></div>}
            {page === "template" && templateDraft && <TemplateEditor draft={templateDraft}
              references={data.state.bindings.filter((b) => b.templateId === templateDraft.id).length}
              disabled={disabled}
              onChange={(draft) => { setTemplateDraft(draft); setDirty(true); }} onShortcut={shortcut}
              onExtract={() => extractContent(templateDraft.content, "template")}
              onSave={() => saveTemplate()} onPreview={() => saveTemplate(true)}
              onDelete={() => templateDraft.id && applyChange({ type: "deleteTemplate", id: templateDraft.id })}
              onCopy={() => openTemplate({ ...templateDraft, id: null, name: `${templateDraft.name} - 副本` })} />}
            {page === "config" && entry && <ConfigEditor entry={entry} draft={configDraft} data={data}
              disabled={disabled}
              onChange={(draft) => { setConfigDraft(draft); setDirty(true); }} onShortcut={shortcut}
              onReload={() => chooseEntry(entry)}
              onExtract={() => { if (configDraft) navigate(() => extractContent(configDraft.content, "new")); }}
              onSave={() => saveConfig()} onPreview={() => saveConfig(true)}
              onDelete={() => applyChange({ type: "deleteConfig", id: entry.id, expectedHash: configDraft?.hash || entry.hash || "" })}
              onRemoveAlias={(name) => applyChange({ type: "removeAlias", name })} />}
            {page === "create" && <CreateAliasForm key={`create-${kind}`} kind={kind} data={data} disabled={disabled}
              onSubmit={applyChange} onDirty={() => setDirty(true)} onError={(failure) => setError(String(failure))} />}
            {page === "import" && <ImportForm key={`import-${kind}`} kind={kind} disabled={disabled}
              onSubmit={applyChange} onDirty={() => setDirty(true)} />}
            {page === "history" && <div className="form-section"><span className="eyebrow">LOCAL BACKUPS</span><h2>备份与恢复</h2>
              <p className="notice">只允许恢复当前状态对应的最近操作，避免覆盖后续修改；
                其他记录仍保留在本地，不自动删除。</p><p className="file-path">{data.dataPath}</p>
              {data.history.map((history) => <div className="history-row" key={history.id}><div><strong>{history.label}</strong>
                <small>{new Date(history.createdAt).toLocaleString("zh-CN")}</small></div>
                <button disabled={disabled || !history.canRestore} onClick={() => applyChange({ type: "restoreBackup", id: history.id })}>
                  {history.canRestore ? "恢复此操作" : "后续已有修改"}</button></div>)}
              {!data.history.length && <p className="empty-small">尚无已完成操作的备份。首次保存时自动创建。</p>}</div>}
          </section>
        </div>}
      {data && <footer className="app-footer"><span title={data.profilePath}>PowerShell：{data.profilePath}</span>
        <span>状态 v{data.state.revision} · 保存后无需常驻面板</span></footer>}
    </main>
    {preview && <PreviewDialog preview={preview} busy={!!busy}
      onClose={() => { setPreview(null); setPreparedChange(null); }}
      onCommit={() => void commit()} />}
  </div>;
}
