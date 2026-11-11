import { useEffect, useMemo, useRef } from "react";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { useTheme } from "../theme";
import { InlineNotice } from "./InlineNotice";
import { editorSetup, type EditorLanguage } from "./editorSetup";
import { buildLineDiff } from "../features/preview/lineDiff";
import { createInlineDiffDecorations, inlineDiffField, setInlineDiff } from "../features/preview/inlineDiff";

const noExtensions: Extension = [];

interface Props {
  value: string;
  kind: EditorLanguage;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  label?: string;
  extensions?: Extension;
  onReady?: (view: EditorView | null) => void;
  onUpdate?: (update: ViewUpdate) => void;
  diff?: {
    after: string | null;
    loading: boolean;
    error: string;
  };
}

export function CodeEditor({ value, kind, onChange, readOnly = false, label = "配置编辑器",
  extensions = noExtensions, onReady, onUpdate, diff }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const initialValue = useRef(value);
  const syncing = useRef(false);
  const readOnlyCompartment = useRef(new Compartment());
  const extraCompartment = useRef(new Compartment());
  // 回调和扩展通过引用与隔舱更新，不因差异重算销毁编辑器或丢失搜索、选区。
  const extra = useRef(extensions);
  const ready = useRef(onReady);
  const updated = useRef(onUpdate);
  extra.current = extensions;
  ready.current = onReady;
  updated.current = onUpdate;
  const { theme } = useTheme();
  const dark = theme === "dark";
  // 只计算当前输入对应的差异；加载或失败时保持原文可编辑，不沿用旧结果。
  const result = useMemo(() => {
    if (!diff || diff.loading || diff.error || diff.after === null) return { lines: null, error: "" };
    try { return { lines: buildLineDiff(value, diff.after), error: "" }; }
    catch (failure) { return { lines: null, error: String(failure) }; }
  }, [value, diff?.after, diff?.loading, diff?.error]);
  const diffError = diff?.error || result.error;
  callback.current = onChange;
  initialValue.current = value;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      doc: initialValue.current,
      parent: host.current,
      extensions: [
        editorSetup(kind, dark),
        inlineDiffField,
        extraCompartment.current.of(extra.current),
        readOnlyCompartment.current.of([
          EditorView.editable.of(!readOnly),
          EditorState.readOnly.of(readOnly),
        ]),
        // 只读原文同样可聚焦，确保双栏左侧能使用 Ctrl+F，而不会开放正文修改。
        EditorView.contentAttributes.of({ "aria-label": label, tabindex: "0" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !syncing.current) callback.current?.(update.state.doc.toString());
          updated.current?.(update);
        }),
      ],
    });
    view.current = editor;
    const notify = ready.current;
    notify?.(editor);
    return () => { notify?.(null); view.current = null; editor.destroy(); };
  }, [kind, label, dark]);

  useEffect(() => {
    view.current?.dispatch({ effects: extraCompartment.current.reconfigure(extensions) });
  }, [extensions]);

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

  return <div className="code-editor-shell" aria-busy={diff?.loading}>
    {/* 移除共享配置说明栏，仅在差异运算真实失败时保留错误。 */}
    <InlineNotice messages={[diffError]} tone="error" />
    <div className="code-editor" ref={host} />
  </div>;
}
