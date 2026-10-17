import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
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
        EditorView.theme({
          "&": { height: "100%", fontSize: "13px", backgroundColor: "#11151e", color: "#dde4ee" },
          ".cm-scroller": { overflow: "auto", fontFamily: "Consolas, 'Cascadia Code', monospace" },
          ".cm-content": { padding: "16px 0", minHeight: "240px" },
          ".cm-gutters": { backgroundColor: "#10141c", color: "#5f6b80", border: "none" },
          ".cm-activeLine": { backgroundColor: "#20293966" },
          ".cm-activeLineGutter": { backgroundColor: "#202939" },
          "&.cm-focused": { outline: "none" },
          ".cm-cursor": { borderLeftColor: "#b7bdff" },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#374575 !important" },
        }, { dark: true }),
      ],
    });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, [kind, readOnly, label]);

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
