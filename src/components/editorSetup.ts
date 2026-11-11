import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { editorSearch } from "./editorSearch";
import type { Kind } from "../types";

export type EditorLanguage = Kind | "text";

// 正文和差异面板共用编辑、查找、语法及主题配置；纯文本用于只读的自动生成文件。
export function editorSetup(kind: EditorLanguage, dark: boolean) {
  return [
    basicSetup,
    editorSearch,
    kind === "claude" ? json() : kind === "codex" ? StreamLanguage.define(toml) : [],
    EditorView.lineWrapping,
    // dark 决定内置面板的明暗基准，具体颜色仍跟随共享主题变量。
    EditorView.theme({
      "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--bg-page)", color: "var(--text)" },
      ".cm-scroller": { overflow: "auto", fontFamily: "Consolas, 'Cascadia Code', monospace" },
      ".cm-content": { padding: "16px 0", minHeight: "240px" },
      ".cm-gutters": { backgroundColor: "var(--bg-rail)", color: "var(--muted)", border: "none" },
      ".cm-activeLine": { backgroundColor: "var(--accent-bg)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--bg-column)" },
      "&.cm-focused": { outline: "none" },
      ".cm-cursor": { borderLeftColor: "var(--accent)" },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
        backgroundColor: "var(--border-control-hover) !important",
      },
    }, { dark }),
  ];
}
