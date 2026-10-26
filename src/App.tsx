import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { useDragSort } from "./features/drag/useDragSort";
import { ConfigEditor } from "./features/aliases/ConfigEditor";
import { ConfigGroups } from "./features/aliases/ConfigGroups";
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
  // 列表元数据静默保存时仍需锁定交互，防止与编辑器写入共用同一个后端计划。
  const [organizing, setOrganizing] = useState(false);
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
  // 静默保存不设置 busy 文案，重渲染时也必须保留互斥标记。
  busyRef.current = organizing ? "保存列表布局…" : busy;

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

  const disabled = !data || !!busy || organizing || !!data.pendingRecovery;
  const entry = data?.inventory.configs.find((c) => c.id === selected);
  // 模板顺序属于布局，不能通过重排业务正文制造完整配置备份。
  const templates = (() => {
    const base = data?.state.templates.filter((t) => t.kind === kind) || [];
    const rank = new Map((data?.state.templateOrder ?? []).map((id, index) => [id, index]));
    return [...base].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  })();
  // 别名配置显示顺序：configOrder 全局一份（跨产品页签共享）；未登记的项目按默认顺序排在末尾。
  const configs = (() => {
    // 保留当前产品的全量顺序，搜索过滤交给分组列表，避免组内排序提交不完整集合。
    const base = data?.inventory.configs.filter((c) => c.kind === kind) || [];
    const order = data?.state.configOrder;
    if (!order?.length) return base;
    const rank = new Map(order.map((id, index) => [id, index]));
    return [...base].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  })();
  const configCount = configs.filter((config) =>
    `${config.aliases.join(" ")} ${config.path}`.toLowerCase().includes(search.trim().toLowerCase())).length;

  // —— 拖拽排序（零依赖）———————————————————————————————————————————
  // 排序仅在完整列表视图下允许；搜索过滤中的顺序不具备完整语义，直接禁用（快速失败，不做静默猜测）。
  const dragEnabled = !disabled && !search.trim();
  // 模板排序只走独立布局入口，不再触发配置恢复日志。
  const templateDrag = useDragSort(templates, (t) => t.id, dragEnabled,
    (order) => applyChange({ type: "reorderTemplates", kind, order }, false, templateDrag.cancel));

  async function perform(label: string, action: () => Promise<void>, writesFiles = false, showBusy = true) {
    if (busyRef.current || closingRef.current) return;
    busyRef.current = label;
    writingRef.current = writesFiles;
    if (showBusy) setBusy(label);
    setError(""); setMessage(""); setOperationNotices([]);
    try { await action(); } catch (failure) { setError(String(failure)); }
    finally {
      writingRef.current = false; busyRef.current = "";
      if (showBusy) setBusy("");
    }
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
    if (target.error) {
      setSelected(target.id); setPage("config"); setConfigDraft(null); setDirty(false);
      return;
    }
    const document = await api.readConfig(target.id);
    if (operation !== sequence.current) return;
    const binding = current.state.bindings.find((b) => b.configId === target.id);
    // 文件名中间的后缀作为草稿名称，保存时与命令名保持一致。
    const filename = target.path.slice(Math.max(target.path.lastIndexOf("\\"), target.path.lastIndexOf("/")) + 1);
    const name = target.kind === "codex" ? filename.slice(7, -5) : filename.slice(9, -5);
    // 读取成功后再一次性切换条目，避免异步读取期间卸载当前编辑器造成画面闪烁。
    setSelected(target.id); setPage("config"); setDirty(false);
    setConfigDraft({ id: target.id, name, content: document.content, hash: document.hash,
      notices: document.notices, templateId: binding?.templateId || null });
  }

  function chooseEntry(target: ConfigEntry) {
    if (busyRef.current || closingRef.current) return;
    // 普通切换只保持操作互斥，不进入会触发布局和透明度变化的全局可视加载态。
    if (data) void perform("读取配置文件…", () => loadEntry(target, data), false, false);
  }

  function applyChange(change: Change, previewOnly = false, onReorderFailure?: () => void, onLayoutSaved?: () => void) {
    if (!data || disabled || busyRef.current) { onReorderFailure?.(); return; }
    // 分组与排序共用互斥的静默提交，不清空编辑器草稿或未保存标记。
    // 未获得回执时取消乐观排序并读取真实状态；不能把响应失败等同于确定未提交。
    if (change.type === "reorderTemplates" || change.type === "reorderConfigs"
      || change.type === "saveConfigGroup" || change.type === "deleteConfigGroup" || change.type === "assignConfigGroup") {
      void perform("保存列表布局…", async () => {
        setOrganizing(true);
        try {
          const result = await api.updateLayout(data.state.revision, data.state.layoutRevision ?? 0, change);
          // 索引失败显式标记不可用并移除未核验的恢复入口，不把它当作真实空历史。
          setData({ ...data, history: result.history ?? [], historyError: result.historyError, state: { ...data.state,
            layoutRevision: result.layoutRevision, configOrder: result.configOrder,
            templateOrder: result.templateOrder, configGroups: result.configGroups } });
          onLayoutSaved?.();
          if (result.historyError) setError(result.historyError);
        } catch (failure) {
          onReorderFailure?.();
          await refreshAfterFailure(new Error(`列表布局未获得成功回执，请先确认刷新后的结果，勿直接重复保存：${String(failure)}`));
        } finally {
          setOrganizing(false);
        }
      }, true, false);
      return;
    }
    // 预览只在主动点击时显示；普通保存和删除沿用同一计划后直接提交。
    void perform(previewOnly ? "生成差异预览…" : "执行配置操作…", async () => {
      const result = await api.prepare(data.state.revision, change, data.state.layoutRevision ?? 0);
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
    let warnings: string[] = [];
    try {
      const outcome = await api.commit(plan.id);
      warnings = outcome.warnings;
      if (!outcome.snapshot) {
        // 已提交但刷新失败：停用后续修改，保留明确回执，不将操作重新提交。
        setData(null); setPreview(null); setPreparedChange(null); setDirty(false);
        setMessage(`操作已落盘，操作编号：${outcome.id}。请刷新清单，无需重复保存。`);
        setError([outcome.refreshError, ...warnings].filter(Boolean).join("；"));
        return;
      }
      result = outcome.snapshot;
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
        // 重命名会改变配置 id，依据同目录下的新文件路径重新定位，避免停留在失效条目。
        const previous = data?.inventory.configs.find((c) => c.id === change.id);
        if (!previous) throw new Error("保存前的配置条目已失效，请刷新清单。");
        const filename = previous.kind === "codex" ? `config.${change.name}.toml` : `settings.${change.name}.json`;
        const separator = Math.max(previous.path.lastIndexOf("\\"), previous.path.lastIndexOf("/"));
        const path = previous.path.slice(0, separator + 1) + filename;
        const target = result.inventory.configs.find((c) => c.kind === previous.kind && c.path === path);
        if (!target) throw new Error("保存后的配置未出现在清单中，请刷新清单。");
        await loadEntry(target, result);
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
      setMessage(warnings.length
        ? `操作已落盘，但存在待处理事项：${warnings.join("；")}`
        : "操作已落盘并通过保存链路回读校验。");
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

  function saveTemplate(previewOnly = false, syncBindings = true) {
    if (templateDraft) applyChange({ type: "saveTemplate", ...templateDraft, syncBindings }, previewOnly);
  }

  function saveConfig(previewOnly = false) {
    if (entry && configDraft) applyChange({ type: "saveConfig", id: entry.id, name: configDraft.name, content: configDraft.content,
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

  const resetPage = (next: Page) => {
    setPage(next); setSelected(null); setDirty(false); setError(""); setMessage(""); setOperationNotices([]);
  };
  // 模板卡片的 click 经 card() 包装：拖拽噪声 click 被吞掉，正常点击进入编辑。
  return <div className="app-shell">
    <aside className="rail">
      <div className="brand"><span className="brand-mark">CLI</span><div><strong>Auto Panel</strong><small>本地配置工作台</small></div></div>
      <div className="product-tabs">
        {(["codex", "claude"] as Kind[]).map((value) => <button key={value} className={kind === value ? "active" : ""}
          disabled={!!busy || organizing} onClick={() => navigate(() => { setKind(value); resetPage("welcome"); })}>{value === "codex" ? "Codex" : "Claude"}</button>)}
      </div>
      <div className="sidebar-heading"><span>通用配置</span><button disabled={disabled} onClick={() => navigate(() =>
        openTemplate({ id: null, name: "", kind, content: kind === "claude" ? "{}\n" : "" }))}>新建</button></div>
      <nav className="template-list" aria-label="通用配置列表" {...templateDrag.container}>
        {templateDrag.ordered.map((template) => {
          const count = data?.state.bindings.filter((b) => b.templateId === template.id).length || 0;
          const state = templateDrag.dragging === template.id ? " dragging" : templateDrag.over === template.id ? " drag-over" : "";
          // 通用配置仅展示名称和绑定数，内部版本继续用于同步，不作为界面文案。
          return <button key={template.id} disabled={!!busy || organizing}
            className={page === "template" && templateDraft?.id === template.id ? `selected${state}` : state.trim()}
            {...templateDrag.card(template.id, () => navigate(() => openTemplate({ ...template })))}><span>{template.name}</span><small>{count} 份绑定</small></button>;
        })}
        {!templates.length && <p className="sidebar-empty">还没有通用配置<br />可从现有文件中提取</p>}
      </nav>
      <div className="sidebar-bottom">
        <button disabled={disabled} onClick={() => navigate(() => resetPage("create"))}>新建别名与文件</button>
        <button disabled={disabled} onClick={() => navigate(() => resetPage("import"))}>导入已有配置</button>
        <button disabled={!!busy || organizing} onClick={() => navigate(() => resetPage("history"))}>备份与恢复</button>
      </div>
    </aside>
    <main>
      <header className="topbar"><div><span className="eyebrow">{kind === "codex" ? "CODEX / CODEXNEW" : "CLAUDE CODE"}</span>
        <h1>通用配置管理</h1></div><div className="topbar-actions">
        {dirty && <span className="draft-indicator">草稿未保存</span>}
        <ThemeToggle />
        <button disabled={!!busy || organizing} onClick={refresh}>刷新清单</button></div></header>
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
      {data?.inventory.warnings.filter((warning) => !warning.startsWith("存在失去入口的绑定")).map((warning) =>
        <div className="notice global-notice" key={warning}>{warning}</div>)}
      {!data ? <div className="welcome"><h2>{busy ? "正在读取本地配置…" : "面板尚未就绪"}</h2>
        <p>需要读取指定的 PowerShell profile。不会执行其中的命令，也不会自动改写已有配置。</p>
        {!busy && <button onClick={refresh}>重试读取</button>}</div> :
        <div className="workspace">
          <section className="config-column"><div className="column-title"><h2>别名配置文件</h2><span>{configCount}</span></div>
            <input className="search" aria-label="搜索别名或文件" value={search} placeholder="搜索别名或文件…" onChange={(e) => setSearch(e.target.value)} />
            <ConfigGroups key={kind} data={data} kind={kind} configs={configs} search={search}
              selected={page === "config" ? selected : null} disabled={disabled} saving={organizing} error={error}
              onSelect={chooseEntry} onChange={(change, onSaved) => applyChange(change, false, undefined, onSaved)}
              onReorder={(order, cancel) => applyChange({ type: "reorderConfigs", order }, false, cancel)} />
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
              onChange={(draft) => { setTemplateDraft(draft); setDirty(true); }}
              onExtract={() => extractContent(templateDraft.content, "template")}
              onSave={() => saveTemplate()} onPreview={() => saveTemplate(true)}
              onSaveOnly={() => saveTemplate(false, false)}
              onDelete={() => templateDraft.id && applyChange({ type: "deleteTemplate", id: templateDraft.id }, true)}
              onCopy={() => openTemplate({ ...templateDraft, id: null, name: `${templateDraft.name} - 副本` })} />}
            {page === "config" && entry && <ConfigEditor entry={entry} draft={configDraft} data={data}
              disabled={disabled}
              onChange={(draft) => { setConfigDraft(draft); setDirty(true); }}
              onReload={() => chooseEntry(entry)}
              onExtract={() => { if (configDraft) navigate(() => extractContent(configDraft.content, "new")); }}
              onSave={() => saveConfig()} onPreview={() => saveConfig(true)}
              onDelete={() => applyChange({ type: "deleteConfig", id: entry.id, expectedHash: configDraft?.hash || entry.hash || "" })}
              onRemoveAlias={(name) => applyChange({ type: "removeAlias", name })} />}
            {page === "create" && <CreateAliasForm key={`create-${kind}`} kind={kind} data={data} disabled={disabled}
              onSubmit={applyChange} onDirty={() => setDirty(true)} onError={(failure) => setError(String(failure))} />}
            {page === "import" && <ImportForm key={`import-${kind}`} kind={kind} data={data} disabled={disabled}
              onSubmit={applyChange} onDirty={() => setDirty(true)} />}
            {page === "history" && <div className="form-section"><span className="eyebrow">LOCAL BACKUPS</span><h2>备份与恢复</h2>
              <p className="notice">配置历史存入数据库，最多保留 20 条且正文合计不超过 256 MiB；
                排序与分组独立保存，不生成配置备份。恢复时仍会检查外部文件是否变化。
                旧版 JSON 留在原目录，不自动删除；旧备份的恢复资格不会放宽。</p><p className="file-path">{data.dataPath}</p>
              {data.historyError && <p className="error-box" role="alert">{data.historyError}</p>}
              {!data.historyError && data.history.map((history) => <div className="history-row" key={history.id}><div><strong>{history.label}</strong>
                <small>{history.legacy ? "旧版备份 · " : ""}{new Date(history.createdAt).toLocaleString("zh-CN")}</small></div>
                <button disabled={disabled || !history.canRestore} onClick={() => applyChange({ type: "restoreBackup", id: history.id })}>
                  {history.canRestore ? "恢复此操作" : "后续已有修改"}</button></div>)}
              {!data.historyError && !data.history.length && <p className="empty-small">尚无已完成操作的备份。首次保存时自动创建。</p>}</div>}
          </section>
        </div>}
      {data && <footer className="app-footer"><span title={data.profilePath}>PowerShell：{data.profilePath}</span>
        <span>保存后无需常驻面板</span></footer>}
    </main>
    {preview && <PreviewDialog preview={preview} busy={!!busy}
      onClose={() => { setPreview(null); setPreparedChange(null); }}
      onCommit={() => void commit()} />}
  </div>;
}
