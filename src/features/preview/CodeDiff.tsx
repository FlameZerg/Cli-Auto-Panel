import { useMemo } from "react";
import { InlineNotice } from "../../components/InlineNotice";
import { buildLineDiff } from "./lineDiff";

interface Props { before: string; after: string; label?: string }

export function CodeDiff({ before, after, label = "代码差异" }: Props) {
  const result = useMemo(() => {
    try { return { lines: buildLineDiff(before, after), error: "" }; }
    catch (failure) { return { lines: [], error: String(failure) }; }
  }, [before, after]);
  // 差异错误与主界面共用单行提示，不用多行错误框挤占代码区域。
  if (result.error) return <InlineNotice tone="error" messages={[result.error]} />;
  const added = result.lines.filter((line) => line.kind === "add").length;
  const removed = result.lines.filter((line) => line.kind === "remove").length;
  return <section className="code-diff" aria-label={label}>
    <div className="diff-heading"><span>{label}</span>
      <span className="diff-legend"><span className="diff-removed">−{removed} 删除</span>
        <span className="diff-added">+{added} 增加</span></span></div>
    {!added && !removed && <p className="diff-unchanged">没有代码内容变化。</p>}
    <div className="diff-code" role="region" aria-label={`${label}：红色删除，绿色增加`} tabIndex={0}>
      {result.lines.map((line, index) => <div className={`diff-line diff-${line.kind}`} key={index}>
        <span className="diff-number" aria-label="原行号">{line.beforeLine ?? ""}</span>
        <span className="diff-number" aria-label="新行号">{line.afterLine ?? ""}</span>
        <span className="diff-sign" aria-label={line.kind === "remove" ? "删除" : line.kind === "add" ? "增加" : "未变"}>
          {line.kind === "remove" ? "-" : line.kind === "add" ? "+" : " "}</span>
        <span className="diff-text">{line.text || " "}
          {line.noNewline && <span className="diff-no-newline"> ↵（末行无换行）</span>}</span>
      </div>)}
    </div>
  </section>;
}
