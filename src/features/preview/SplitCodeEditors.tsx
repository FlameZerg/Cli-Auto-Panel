import { useEffect, useRef, useState } from "react";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { CodeEditor } from "../../components/CodeEditor";
import { InlineNotice } from "../../components/InlineNotice";
import type { EditorLanguage } from "../../components/editorSetup";
import type { SplitDiffRow } from "./splitDiff";
import { connectSplitEditors, splitEditorExtensions } from "./splitEditorDecorations";

interface Props {
  before: string; after: string; kind: EditorLanguage; rows: readonly SplitDiffRow[];
  readOnly: boolean; onChange?: (content: string) => void;
}

// 左只读、右可编辑，同一共享组件提供主题、语法、撤销和 Ctrl+F，不另建搜索实现。
export function SplitCodeEditors({ before, after, kind, rows, readOnly, onChange }: Props) {
  const [left, setLeft] = useState<EditorView | null>(null);
  const [right, setRight] = useState<EditorView | null>(null);
  const [error, setError] = useState("");
  const connection = useRef<ReturnType<typeof connectSplitEditors> | null>(null);
  useEffect(() => {
    if (!left || !right) return;
    const pair = connectSplitEditors(left, right, setError);
    connection.current = pair;
    return () => { pair.dispose(); connection.current = null; };
  }, [left, right]);
  useEffect(() => { connection.current?.update(rows, before, after); }, [rows, before, after, left, right]);

  function updated(update: ViewUpdate) {
    if (update.geometryChanged || update.viewportChanged || update.docChanged) connection.current?.measure();
  }
  return <div className="split-code-editors">
    <InlineNotice messages={[error]} tone="error" />
    <div className="split-editor-panes">
      <div className="split-editor-pane">
        <div className="diff-column-heading">操作前</div>
        <CodeEditor value={before} kind={kind} readOnly label="操作前，只读"
          extensions={splitEditorExtensions} onReady={setLeft} onUpdate={updated} />
      </div>
      <div className="split-editor-pane">
        <div className="diff-column-heading">操作后</div>
        <CodeEditor value={after} kind={kind} readOnly={readOnly} onChange={onChange} label="操作后"
          extensions={splitEditorExtensions} onReady={setRight} onUpdate={updated} />
      </div>
    </div>
  </div>;
}
