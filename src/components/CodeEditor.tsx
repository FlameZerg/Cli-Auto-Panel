import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { useTheme } from "../theme";
import type { Kind } from "../types";

interface Props {
  value: string;
  kind: Kind;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  label?: string;
}

export function CodeEditor({ value, kind, onChange, readOnly = false, label = "配置编辑器" }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const initialValue = useRef(value);
  const syncing = useRef(false);
  const { theme } = useTheme();
  const dark = theme === "dark";
  callback.current = onChange;
  initialValue.current = value;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      doc: initialValue.current,
      parent: host.current,
      extensions: [
        basicSetup,
        kind === "claude" ? json() : StreamLanguage.define(toml),
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
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
        }, { dark }),
      ],
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, [kind, readOnly, label, dark]);

  useEffect(() => {
    const editor = view.current;
    if (editor && value !== editor.state.doc.toString()) {
      syncing.current = true;
      try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } }); }
      finally { syncing.current = false; }
    }
  }, [value]);

  return <div className="code-editor" ref={host} />;
}
