import { useMemo } from "react";
import { InlineNotice } from "../../components/InlineNotice";
import { buildLineDiff, type DiffLine } from "./lineDiff";
import { buildSplitDiff } from "./splitDiff";
import { SplitCodeEditors } from "./SplitCodeEditors";
import type { EditorLanguage } from "../../components/editorSetup";

export type DiffView = "split" | "unified";

interface Props {
  before: string; after: string; label?: string; action?: string; view?: DiffView;
  kind?: EditorLanguage; readOnly?: boolean; onChange?: (content: string) => void;
}

export function CodeDiff({ before, after, label = "代码差异", action, view = "split",
  kind = "text", readOnly = true, onChange }: Props) {
  const result = useMemo(() => {
    try {
      const lines = buildLineDiff(before, after);
      return { lines, rows: buildSplitDiff(lines), error: "" };
    } catch (failure) { return { lines: [], rows: [], error: String(failure) }; }
  }, [before, after]);
  // 比较失败时明确显示错误，仍保留真实正文编辑器，允许撤销或缩小改动后重新比较。
  const added = result.lines.filter((line) => line.kind === "add").length;
  const removed = result.lines.filter((line) => line.kind === "remove").length;
  return <section className="code-diff" aria-label={label}>
    {/* 文件与差异统计共用标题行，不再叠加重复的方向标题和文件外框。 */}
    <div className="diff-heading"><span className="diff-file-heading" title={label}>
      {action && <span className={["真实删除", "删除模板"].includes(action) ? "danger-text" : "accent"}>{action} </span>}
      {label}</span>
      {!result.error && <span className="diff-legend"><span className="diff-removed">−{removed} 删除</span>
        <span className="diff-added">+{added} 增加</span></span>}</div>
    <InlineNotice tone="error" messages={[result.error]} />
    {!result.error && !added && !removed && <p className="diff-unchanged">没有代码内容变化。</p>}
    {view === "split" ? <SplitCodeEditors before={before} after={after} kind={kind}
      rows={result.rows} readOnly={readOnly} onChange={onChange} />
      : <div className="diff-code" role="region" aria-label={`${label}：红色删除，绿色增加`} tabIndex={0}>
      {result.lines.map((line, index) => <div className={`diff-line diff-${line.kind}`} key={index}>
        <span className="diff-number" aria-label="原行号">{line.beforeLine ?? ""}</span>
        <span className="diff-number" aria-label="新行号">{line.afterLine ?? ""}</span>
        <LineContent line={line} />
      </div>)}
    </div>}
  </section>;
}

// 单栏保留原有行内容及末行标记，外部配置始终作为文本渲染，不解释为 HTML。
function LineContent({ line }: { line: DiffLine }) {
  return <>
    <span className="diff-sign" aria-label={line.kind === "remove" ? "删除" : line.kind === "add" ? "增加" : "未变"}>
      {line.kind === "remove" ? "-" : line.kind === "add" ? "+" : " "}</span>
    <span className="diff-text">{line.text || " "}
      {line.noNewline && <span className="diff-no-newline"> ↵（末行无换行）</span>}</span>
  </>;
}
