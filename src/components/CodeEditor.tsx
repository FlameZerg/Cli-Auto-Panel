import { useEffect, useMemo, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { highlightSelectionMatches, searchKeymap, openSearchPanel } from "@codemirror/search";
import { useTheme } from "../theme";
import { buildLineDiff } from "../features/preview/lineDiff";
import { createInlineDiffDecorations, inlineDiffField, setInlineDiff } from "../features/preview/inlineDiff";
import type { Kind } from "../types";

interface Props {
  value: string;
  kind: Kind;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  label?: string;
  diff?: {
    after: string | null;
    label: string;
    loading: boolean;
    error: string;
  };
}

export function CodeEditor({ value, kind, onChange, readOnly = false, label = "配置编辑器", diff }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const initialValue = useRef(value);
  const syncing = useRef(false);
  const readOnlyCompartment = useRef(new Compartment());
  const { theme } = useTheme();
  const dark = theme === "dark";
  // 只计算当前输入对应的差异；加载或失败时保持原文可编辑，不沿用旧结果。
  const result = useMemo(() => {
    if (!diff || diff.loading || diff.error || diff.after === null) return { lines: null, error: "" };
    try { return { lines: buildLineDiff(value, diff.after), error: "" }; }
    catch (failure) { return { lines: null, error: String(failure) }; }
  }, [value, diff?.after, diff?.loading, diff?.error]);
  const added = result.lines?.filter((line) => line.kind === "add").length ?? 0;
  const removed = result.lines?.filter((line) => line.kind === "remove").length ?? 0;
  const diffError = diff?.error || result.error;
  callback.current = onChange;
  initialValue.current = value;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      doc: initialValue.current,
      parent: host.current,
      extensions: [
        basicSetup,
        inlineDiffField,
        // Ctrl+F 搜索面板与选区匹配高亮：与 cc-switch 的内建搜索行为一致。
        // searchKeymap 提供 Ctrl-F / F3 / Shift-F3 / Ctrl-Shift-L 等全套绑定；
        // Mod-f 兜底确保面板一定能呼出（openSearchPanel 已在 searchKeymap 内，
        // 这里仅在面板未开时强制打开，避免与其他扩展冲突）。
        keymap.of([
          ...searchKeymap,
          { key: "Mod-f", run: (v) => openSearchPanel(v) },
        ]),
        highlightSelectionMatches(),
        kind === "claude" ? json() : StreamLanguage.define(toml),
        readOnlyCompartment.current.of([
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
        ]),
        EditorView.contentAttributes.of({ "aria-label": label }),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncing.current) callback.current?.(update.state.doc.toString());
        }),
        // 颜色全部引用 CSS 变量，随 html[data-theme] 自动切换；dark 标志
        // 决定 CodeMirror 内建补全/选区等 UI 的明暗基准，因此主题切换时重建编辑器。
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg-page)", color: "var(--text)" },
          ".cm-scroller": { overflow: "auto", fontFamily: "Consolas, 'Cascadia Code', monospace" },
          ".cm-content": { padding: "16px 0", minHeight: "240px" },
          ".cm-gutters": { backgroundColor: "var(--bg-rail)", color: "var(--muted)", border: "none" },
          ".cm-activeLine": { backgroundColor: "var(--accent-bg)" },
          ".cm-activeLineGutter": { backgroundColor: "var(--bg-column)" },
          "&.cm-focused": { outline: "none" },
          ".cm-cursor": { borderLeftColor: "var(--accent)" },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "var(--border-control-hover) !important" },
          // 搜索面板随主题变量取色，避免浅色主题下出现刺眼白底。
          ".cm-panels": { backgroundColor: "var(--bg-column)", color: "var(--text)", borderBottom: "1px solid var(--line)" },
          // 复用内置搜索面板的两行结构，仅为文本框和操作按钮适配主题，避免污染复选框及关闭按钮。
          ".cm-panel.cm-search .cm-textfield, .cm-panel.cm-search .cm-button": {
            background: "var(--bg-input)", color: "var(--text-input)",
            border: "1px solid var(--border-control)", fontSize: "70%",
          },
          ".cm-panel.cm-search .cm-textfield": { borderRadius: "0", padding: ".2em .5em" },
          ".cm-panel.cm-search .cm-button": { borderRadius: "1px", padding: ".2em 1em" },
          // 覆盖全局表单标签的纵向 flex 布局，使三个搜索选项紧跟查找按钮横向排列。
          ".cm-panel.cm-search label": {
            display: "inline", color: "var(--muted)", fontSize: "80%", whiteSpace: "pre",
          },
          ".cm-panel.cm-search input[type=checkbox]": {
            width: "auto", height: "auto", padding: "0", borderRadius: "0", verticalAlign: "middle",
          },
        }, { dark }),
      ],
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, [kind, label, dark]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    // 加载态只更新编辑权限，不销毁编辑器实例，避免 busy 状态变化造成视觉闪烁。
    editor.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    const editor = view.current;
    if (editor && value !== editor.state.doc.toString()) {
      syncing.current = true;
      try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } }); }
      finally { syncing.current = false; }
    }
  }, [value]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    // 按编辑器规范化后的文本核对基线，兼容 Windows CRLF，且不把预览行写入文档。
    const lines = editor.state.doc.eq(editor.state.toText(value)) ? result.lines : null;
    editor.dispatch({ effects: setInlineDiff.of(createInlineDiffDecorations(editor.state, lines ?? [])) });
  }, [value, result.lines, kind, label, dark]);

  return <div className={`code-editor-shell${diff ? " has-inline-diff" : ""}`} aria-busy={diff?.loading}>
    {diff && <div className="inline-diff-heading">
      <div className="diff-heading"><span>{diff.label}</span>
        {result.lines && <span className="diff-legend">
          <span className="diff-removed">−{removed} 删除</span>
          <span className="diff-added">+{added} 增加</span>
        </span>}</div>
      {diff.loading && <p className="inline-diff-status muted" role="status">正在生成通用配置差异…</p>}
      {diffError && <p className="inline-diff-error" role="alert">通用配置差异无法生成：{diffError}</p>}
      {result.lines && !added && !removed && <p className="inline-diff-status muted">没有代码内容变化。</p>}
    </div>}
    <div className="code-editor" ref={host} />
  </div>;
}
