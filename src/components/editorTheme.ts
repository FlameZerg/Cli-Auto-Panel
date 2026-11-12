import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// 自定义高亮仅在深色主题启用，浅色完整沿用 basicSetup 原有的默认高亮颜色。
export const editorHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--code-property)" },
  { tag: tags.string, color: "var(--code-string)" },
  { tag: tags.number, color: "var(--code-number)" },
  // TOML 的节名、日期和布尔值使用 atom，JSON 的布尔值与 null 使用独立标签。
  { tag: [tags.keyword, tags.atom, tags.bool, tags.null], color: "var(--code-literal)" },
  { tag: tags.comment, color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.punctuation, tags.operator], color: "var(--code-punctuation)" },
  { tag: tags.invalid, color: "var(--code-invalid)", textDecoration: "underline" },
], { themeType: "dark" }));

// 明暗基准独立重配置；实际颜色跟随共享变量，不重建编辑器或清空编辑状态。
export function editorTheme(dark: boolean) {
  return EditorView.theme({
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
  }, { dark });
}
