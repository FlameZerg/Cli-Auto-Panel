import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { editorSearch } from "./editorSearch";
import { editorHighlighting } from "./editorTheme";
import type { Kind } from "../types";

export type EditorLanguage = Kind | "text";

// 正文和差异面板共用编辑、查找及语法配置；主题通过独立隔舱更新。
export function editorSetup(kind: EditorLanguage) {
  return [
    basicSetup,
    editorSearch,
    editorHighlighting,
    kind === "claude" ? json() : kind === "codex" ? StreamLanguage.define(toml) : [],
    EditorView.lineWrapping,
  ];
}
