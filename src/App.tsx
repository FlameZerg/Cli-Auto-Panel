import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";
import { InlineNotice } from "./components/InlineNotice";
import { useDragSort } from "./features/drag/useDragSort";
import { ConfigGroups } from "./features/aliases/ConfigGroups";
import { ImportForm } from "./features/aliases/ImportForm";
import { previewEditor } from "./features/preview/previewEditing";
import { useTheme } from "./theme";
import { Sidebar } from "./components/Sidebar";
import { Preferences } from "./components/Preferences";
import { ZoomControls } from "./components/ZoomControls";
import { ModuleBoundary } from "./components/ModuleBoundary";
import { Modal } from "./components/Modal";
import type { Bootstrap, Change, CodexLauncher, ConfigDraft, ConfigEntry, Kind, Preview, TemplateDraft } from "./types";

type Page = "welcome" | "template" | "config" | "create" | "import" | "history";

// 首页只加载清单与导航；CodeMirror 和差异算法在首次进入编辑或预览时加载。
const ConfigEditor = lazy(() => import("./features/aliases/ConfigEditor").then((module) => ({ default: module.ConfigEditor })));
const CreateAliasForm = lazy(() => import("./features/aliases/CreateAliasForm").then((module) => ({ default: module.CreateAliasForm })));
const TemplateEditor = lazy(() => import("./features/common-config/TemplateEditor").then((module) => ({ default: module.TemplateEditor })));
const PreviewDialog = lazy(() => import("./features/preview/PreviewDialog").then((module) => ({ default: module.PreviewDialog })));

export function App() {
  const prefs = useTheme();
  const { t, language } = prefs;
  const [settings, setSettings] = useState(false);
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
  const [previewStale, setPreviewStale] = useState(false);
  // 同步作废计划标识，阻止修改后同一事件周期仍提交旧预览。
  const validPreview = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  const sequence = useRef(0);
  const closingRef = useRef(false);
  // 仅写盘流程保护退出；初始化或普通读取失败不应让窗口无法关闭。
  const writingRef = useRef(false);
  const busyRef = useRef(busy);
  // 静默保存不设置 busy 文案，重渲染时也必须保留互斥标记。
  busyRef.current = organizing ? t("保存列表布局…") : busy;

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
      if (live) setError(t("配置正在写入或恢复，请等结果返回后关闭窗口，避免中断文件提交。"));
      return true;
    };
    const destroyWindow = async () => {
      if (closingRef.current || blockCloseWhileWriting()) return;
      closingRef.current = true;
      try { await currentWindow.destroy(); }
      catch (failure) {
        closingRef.current = false;
        if (live) setError(t("无法关闭窗口：{error}", { error: String(failure) }));
      }
    };
    const unlisten = currentWindow.onCloseRequested(async (event) => {
      // 自己接管销毁及错误回显，避免 API 内部的异步销毁失败无人处理。
      event.preventDefault();
      if (closingRef.current || blockCloseWhileWriting()) return;
      await destroyWindow();
    }).catch((failure) => { if (live) setError(t("无法注册窗口关闭保护：{error}", { error: String(failure) })); return () => {}; });
    return () => { live = false; void unlisten.then((dispose) => dispose()); };
  }, [t]);

  const disabled = !data || !!busy || organizing || !!data.pendingRecovery;
  const entry = data?.inventory.configs.find((c) => c.id === selected);
  // 模板顺序属于布局，不能通过重排业务正文制造完整配置备份。
  const templates = useMemo(() => {
    const base = data?.state.templates.filter((t) => t.kind === kind) || [];
    const rank = new Map((data?.state.templateOrder ?? []).map((id, index) => [id, index]));
    return [...base].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [data?.state.templates, data?.state.templateOrder, kind]);
  // 别名配置显示顺序：configOrder 全局一份（跨产品页签共享）；未登记的项目按默认顺序排在末尾。
  const configs = useMemo(() => {
    // 保留当前产品的全量顺序，搜索过滤交给分组列表，避免组内排序提交不完整集合。
    const base = data?.inventory.configs.filter((c) => c.kind === kind) || [];
    const order = data?.state.configOrder;
    if (!order?.length) return base;
    const rank = new Map(order.map((id, index) => [id, index]));
    return [...base].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [data?.inventory.configs, data?.state.configOrder, kind]);
  const configCount = configs.filter((config) =>
    `${config.aliases.join(" ")} ${config.path}`.toLowerCase().includes(search.trim().toLowerCase())).length;
  // 全局状态、错误及操作警告共享一行；完整上下文通过悬停查看，不堆叠占用高度。
  const statusMessages = [
    data?.pendingRecovery ? t("检测到未完成的写入，请先检查并恢复。") : "",
    error, busy === "读取本地配置清单…" ? t("读取本地配置清单…") : busy, message,
    prefs.storageError ? t("偏好设置无法保存，下次启动可能不会保留。") : "",
    ...operationNotices, ...(data?.inventory.warnings ?? []),
  ];

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
    // 恢复绑定已保存的优先级，后续通用同步沿用该选择，不迁移历史状态。
    setConfigDraft({ id: target.id, name, content: document.content, hash: document.hash,
      notices: document.notices, templateId: binding?.templateId || null,
      mergePriority: binding?.mergePriority ?? "current" });
  }

  function chooseEntry(target: ConfigEntry) {
    if (busyRef.current || closingRef.current) return;
    // 普通切换只保持操作互斥，不进入会触发布局和透明度变化的全局可视加载态。
    if (data) void perform(t("读取配置文件…"), () => loadEntry(target, data), false, false);
  }

  function applyChange(change: Change, previewOnly = false, onReorderFailure?: () => void, onLayoutSaved?: () => void) {
    if (!data || disabled || busyRef.current) { onReorderFailure?.(); return; }
    // 分组与排序共用互斥的静默提交，不清空编辑器草稿或未保存标记。
    // 未获得回执时取消乐观排序并读取真实状态；不能把响应失败等同于确定未提交。
    if (change.type === "reorderTemplates" || change.type === "reorderConfigs"
      || change.type === "reorderConfigGroups"
      || change.type === "saveConfigGroup" || change.type === "deleteConfigGroup" || change.type === "assignConfigGroup") {
      void perform(t("保存列表布局…"), async () => {
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
          await refreshAfterFailure(new Error(t("列表布局未获得成功回执，请先确认刷新后的结果，勿直接重复保存：{error}", { error: String(failure) })));
        } finally {
          setOrganizing(false);
        }
      }, true, false);
      return;
    }
    // 预览只在主动点击时显示；普通保存和删除沿用同一计划后直接提交。
    void perform(t(previewOnly ? "生成差异预览…" : "执行配置操作…"), async () => {
      const result = await api.prepare(data.state.revision, change, data.state.layoutRevision ?? 0);
      if (previewOnly) {
        validPreview.current = result.id; setPreviewStale(false);
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
      throw new Error(t("{error}；刷新恢复状态失败：{refreshError}", { error: String(failure), refreshError: String(refreshError) }));
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
        setData(null); setPreview(null); setPreparedChange(null);
        if (change.type !== "setCodexLauncher") setDirty(false);
        setMessage(t("操作已落盘，操作编号：{id}。请刷新清单，无需重复保存。", { id: outcome.id }));
        setError([outcome.refreshError, ...warnings].filter(Boolean).join("；"));
        return;
      }
      result = outcome.snapshot;
    } catch (failure) {
      setPreview(null); setPreparedChange(null);
      return refreshAfterFailure(failure);
    }
    setData(result); setPreview(null); setPreparedChange(null);
    // 即时版本切换不提交也不清空编辑草稿，未保存标记必须原样保留。
    if (change.type !== "setCodexLauncher") setDirty(false);
    sequence.current += 1;
    // 落盘已完成，后续编辑器重读失败不能被当作提交失败或引导重复执行。
    try {
      if (change.type === "setCodexLauncher") {
        // 只刷新命令标签与列表，编辑器内容、选区和文件哈希基线保持不变。
      } else if (change.type === "saveTemplate") {
        const template = result.state.templates.find((t) => change.id ? t.id === change.id : t.kind === change.kind && t.name === change.name.trim());
        if (template) openTemplate({ ...template });
      } else if (change.type === "saveConfig") {
        // 重命名会改变配置 id，依据同目录下的新文件路径重新定位，避免停留在失效条目。
        const previous = data?.inventory.configs.find((c) => c.id === change.id);
        if (!previous) throw new Error(t("保存前的配置条目已失效，请刷新清单。"));
        const filename = previous.kind === "codex" ? `config.${change.name}.toml` : `settings.${change.name}.json`;
        const separator = Math.max(previous.path.lastIndexOf("\\"), previous.path.lastIndexOf("/"));
        const path = previous.path.slice(0, separator + 1) + filename;
        const target = result.inventory.configs.find((c) => c.kind === previous.kind && c.path === path);
        if (!target) throw new Error(t("保存后的配置未出现在清单中，请刷新清单。"));
        await loadEntry(target, result);
      } else if (change.type === "createAlias") {
        const prefix = change.kind === "claude" ? "claude" : change.launcher === "codexnew" ? "codexnew" : "codex";
        const target = result.inventory.configs.find((c) => c.aliases.includes(`${prefix}-${change.name}`));
        if (target) await loadEntry(target, result);
      } else {
        setSelected(null); setPage("welcome"); setConfigDraft(null); setTemplateDraft(null);
      }
    } catch (failure) {
      throw new Error(t("操作已落盘，但编辑内容重新载入失败：{error}。请重新载入或刷新清单，无需重复提交。", { error: String(failure) }));
    } finally {
      setMessage(warnings.length
        ? t("操作已落盘，但存在待处理事项：{warnings}", { warnings: warnings.join("；") })
        : change.type === "saveTemplate" ? plan.label
          : change.type === "setCodexLauncher" ? t("启动版本已切换，新开的 PowerShell 终端生效。") : t("已保存。"));
      setOperationNotices(plan.notices);
    }
  }

  async function commit() {
    const currentPreview = preview;
    const currentChange = preparedChange;
    if (!currentPreview || !currentChange || previewStale || validPreview.current !== currentPreview.id) return;
    await perform(t("提交并校验配置…"), () => commitPlan(currentPreview, currentChange), true);
  }

  function editPreview(path: string, content: string) {
    if (!data || !preview || busyRef.current || !preparedChange) return;
    const editor = previewEditor(data, preview, preparedChange);
    if (!editor || editor.path !== path) return;
    // 回写原草稿，不直接改预览文件或已有计划；哈希、名称及绑定参数仍保持原来的校验基线。
    if (preparedChange.type !== "saveConfig" && preparedChange.type !== "saveTemplate") return;
    validPreview.current = null; setPreviewStale(true); setDirty(true);
    setPreparedChange({ ...preparedChange, content });
    if (preparedChange.type === "saveConfig") {
      setConfigDraft((draft) => draft && draft.id === preparedChange.id ? { ...draft, content } : draft);
    } else {
      setTemplateDraft((draft) => draft && draft.id === preparedChange.id ? { ...draft, content } : draft);
    }
  }

  function repreview() {
    if (!data || !preparedChange || !previewStale || busyRef.current) return;
    // 重新走既有解析、合并及文件守卫；失败继续保留编辑内容，绝不恢复旧计划的提交能力。
    const change = preparedChange;
    void perform(t("重新生成差异预览…"), async () => {
      const result = await api.prepare(data.state.revision, change, data.state.layoutRevision ?? 0);
      validPreview.current = result.id; setPreviewStale(false); setPreview(result);
    });
  }

  function recover() {
    void perform(t("检查并恢复未完成操作…"), async () => {
      try {
        const result = await api.recover();
        setData(result); setDirty(false); setSelected(null); setPage("welcome");
        setConfigDraft(null); setTemplateDraft(null);
        setMessage(t("未完成操作已处理。"));
      } catch (failure) {
        return refreshAfterFailure(failure);
      }
    }, true);
  }

  function saveTemplate(previewOnly = false) {
    if (templateDraft) applyChange({ type: "saveTemplate", ...templateDraft }, previewOnly);
  }

  function saveConfig(previewOnly = false) {
    if (entry && configDraft) applyChange({ type: "saveConfig", id: entry.id, name: configDraft.name, content: configDraft.content,
      templateId: configDraft.templateId, mergePriority: configDraft.mergePriority,
      expectedHash: configDraft.hash }, previewOnly);
  }

  function switchCodexLauncher(launcher: CodexLauncher) {
    if (entry && configDraft) applyChange({
      type: "setCodexLauncher", id: entry.id, launcher, expectedHash: configDraft.hash,
    });
  }

  function refresh() {
    navigate(() => { void perform(t("刷新文件与绑定状态…"), async () => {
      const result = await api.bootstrap(); setData(result); setPage("welcome");
      setSelected(null); setConfigDraft(null); setTemplateDraft(null); setMessage(t("已重新读取文件及 profile。"));
    }); });
  }

  function extractContent(content: string, target: "template" | "new") {
    void perform(t("提取公共片段…"), async () => {
      const result = await api.extract(kind, content);
      if (target === "template" && templateDraft) {
        setTemplateDraft({ ...templateDraft, content: result.content }); setDirty(true);
      } else {
        openTemplate({ id: null, name: "", kind, content: result.content });
      }
      setMessage(result.excluded.length ? t("已排除专属字段：{fields}。", { fields: result.excluded.join("、") }) : t("已提取公共内容。"));
    });
  }

  const resetPage = (next: Page) => {
    setPage(next); setSelected(null); setDirty(false); setError(""); setMessage(""); setOperationNotices([]);
  };
  function closePreview() {
    if (busyRef.current) return;
    validPreview.current = null; setPreviewStale(false); setPreview(null); setPreparedChange(null);
  }
  // 模板卡片的 click 经 card() 包装：拖拽噪声 click 被吞掉，正常点击进入编辑。
  const pageStyle: CSSProperties & { "--page-zoom": number } = {
    zoom: prefs.zoom, height: `${100 / prefs.zoom}dvh`, "--page-zoom": prefs.zoom,
  };
  return <div className="app-shell" style={pageStyle}>
    <Sidebar data={data} page={page} selectedTemplate={page === "template" ? templateDraft?.id ?? null : null}
      disabled={disabled} busy={!!busy || organizing} drag={templateDrag}
      onNewTemplate={() => navigate(() => openTemplate({ id: null, name: "", kind, content: kind === "claude" ? "{}\n" : "" }))}
      onTemplate={(template) => navigate(() => openTemplate({ ...template }))}
      onPage={(next) => navigate(() => resetPage(next))} onSettings={() => setSettings(true)} />
    <main>
      <header className="topbar"><div><h1>{t("通用配置管理")}</h1></div><div className="topbar-actions">
        {dirty && <span className="draft-indicator">{t("草稿未保存")}</span>}
        <button disabled={!!busy || organizing} onClick={refresh}>{t("刷新清单")}</button></div></header>
      <div className="status-bar"><InlineNotice messages={statusMessages}
        tone={error || data?.pendingRecovery || prefs.storageError ? "error"
          : operationNotices.length || data?.inventory.warnings.length ? "notice" : "success"}
        actions={data?.pendingRecovery
          ? <button className="danger" disabled={!!busy} onClick={recover}>{t("检查并恢复")}</button>
          : (error || message || operationNotices.length > 0) && <button className="quiet"
            onClick={() => { setError(""); setMessage(""); setOperationNotices([]); }}>{t("关闭")}</button>} /></div>
      {!data ? <div className="welcome"><h2>{t(busy ? "正在读取本地配置…" : "面板尚未就绪")}</h2>
        <p>{t("需要读取指定的 PowerShell profile。不会执行其中的命令，也不会自动改写已有配置。")}</p>
        {!busy && <button onClick={refresh}>{t("重试读取")}</button>}</div> :
        <div className="workspace">
          <section className="config-column">
            {/* 产品切换属于别名文件清单，不占用左侧通用配置导航。 */}
            <div className="product-tabs" role="group" aria-label={t("配置类型")}>
              {(["codex", "claude"] as const).map((value) => <button key={value}
                className={kind === value ? "active" : ""} aria-pressed={kind === value}
                disabled={!!busy || organizing}
                onClick={() => navigate(() => { setKind(value); resetPage("welcome"); })}>
                {value === "codex" ? "Codex" : "Claude"}
              </button>)}
            </div>
            <div className="column-title"><h2>{t("别名配置文件")}</h2><span>{configCount}</span></div>
            <input className="search" aria-label={t("搜索别名或文件")} value={search} placeholder={t("搜索别名或文件…")} onChange={(e) => setSearch(e.target.value)} />
            <ConfigGroups key={kind} data={data} kind={kind} configs={configs} search={search}
              selected={page === "config" ? selected : null} disabled={disabled} saving={organizing} error={error}
              onSelect={chooseEntry} onChange={(change, onSaved) => applyChange(change, false, undefined, onSaved)}
              onReorderGroups={(order, cancel) => applyChange({ type: "reorderConfigGroups", kind, order }, false, cancel)}
              onReorder={(order, cancel) => applyChange({ type: "reorderConfigs", order }, false, cancel)} />
            <div className="column-footer">{t("{files} 份文件 · {commands} 个命令入口", {
              files: data.inventory.configs.length, commands: data.inventory.configs.reduce((sum, c) => sum + c.aliases.length, 0),
            })}</div>
          </section>
          <section className="editor-column">
            <ModuleBoundary key={page}><Suspense fallback={<p className="empty-small" role="status">{t("编辑器加载中…")}</p>}>
            {page === "welcome" && <div className="welcome"><span className="welcome-label">{kind === "codex" ? "TOML" : "JSON"}</span>
              <h2>{t("一份偏好，多份配置")}</h2><p>{t("从左侧选择配置文件，或创建一份通用配置。")}</p>
              <div className="welcome-steps"><div><b>01</b>{t("编辑通用片段")}</div><div><b>02</b>{t("为文件选择模板")}</div><div><b>03</b>{t("保存并同步")}</div></div>
              <p className="muted">{t("新建 / 删除别名会精确维护 PowerShell profile；已有终端与会话不会被重载或终止。")}</p></div>}
            {page === "template" && templateDraft && <TemplateEditor draft={templateDraft}
              references={data.state.bindings.filter((b) => b.templateId === templateDraft.id).length}
              disabled={disabled}
              onChange={(draft) => { setTemplateDraft(draft); setDirty(true); }}
              onExtract={() => extractContent(templateDraft.content, "template")}
              onSave={() => saveTemplate()} onPreview={() => saveTemplate(true)}
              onDelete={() => templateDraft.id && applyChange({ type: "deleteTemplate", id: templateDraft.id }, true)}
              onCopy={() => openTemplate({ ...templateDraft, id: null, name: t("{name} - 副本", { name: templateDraft.name }) })} />}
            {page === "config" && entry && <ConfigEditor entry={entry} draft={configDraft} data={data}
              disabled={disabled}
              onChange={(draft) => { setConfigDraft(draft); setDirty(true); }}
              onReload={() => chooseEntry(entry)}
              onExtract={() => { if (configDraft) navigate(() => extractContent(configDraft.content, "new")); }}
              onSave={() => saveConfig()} onPreview={() => saveConfig(true)}
              onLauncherChange={switchCodexLauncher}
              onDelete={() => applyChange({ type: "deleteConfig", id: entry.id, expectedHash: configDraft?.hash || entry.hash || "" })}
              onRemoveAlias={(name) => applyChange({ type: "removeAlias", name })} />}
            {page === "create" && <CreateAliasForm key={`create-${kind}`} kind={kind} data={data} disabled={disabled}
              onSubmit={applyChange} onDirty={() => setDirty(true)} onError={(failure) => setError(String(failure))} />}
            {page === "import" && <ImportForm key={`import-${kind}`} kind={kind} data={data} disabled={disabled}
              onSubmit={applyChange} onDirty={() => setDirty(true)} />}
            {page === "history" && <div className="form-section"><h2>{t("备份与恢复")}</h2>
              <InlineNotice messages={[t("最多保留 20 条配置备份；恢复前检查外部改动，排序及分组独立保存。")]} />
              <p className="file-path" title={data.dataPath}>{data.dataPath}</p>
              <InlineNotice tone="error" messages={[data.historyError]} />
              {!data.historyError && data.history.map((history) => <div className="history-row" key={history.id}><div><strong>{history.label}</strong>
                <small>{history.legacy ? t("旧版备份 · ") : ""}{new Date(history.createdAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</small></div>
                <button disabled={disabled || !history.canRestore} onClick={() => applyChange({ type: "restoreBackup", id: history.id })}>
                  {t(history.canRestore ? "恢复此操作" : "后续已有修改")}</button></div>)}
              {!data.historyError && !data.history.length && <p className="empty-small">{t("尚无已完成操作的备份。首次保存时自动创建。")}</p>}</div>}
            </Suspense></ModuleBoundary>
          </section>
        </div>}
      <footer className="app-footer">{data && <span title={data.profilePath}>PowerShell: {data.profilePath}</span>}
        <ZoomControls /></footer>
    </main>
    {settings && <Preferences onClose={() => setSettings(false)} />}
    {preview && <ModuleBoundary onClose={closePreview}><Suspense fallback={<Modal title={t("查看差异")} onClose={closePreview}>
      <p role="status">{t("编辑器加载中…")}</p></Modal>}><PreviewDialog preview={preview} busy={!!busy} stale={previewStale} error={error}
      editor={data ? previewEditor(data, preview, preparedChange) : null}
      onEdit={editPreview} onRepreview={repreview}
      onClose={closePreview}
      onCommit={() => void commit()} /></Suspense></ModuleBoundary>}
  </div>;
}
