import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { DiffLine } from "./lineDiff";

export const setInlineDiff = StateEffect.define<DecorationSet>();

// 块级预览通过状态字段直接提供，允许 CodeMirror 正确计算同一滚动区域的高度。
export const inlineDiffField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    const replacement = transaction.effects.find((effect) => effect.is(setInlineDiff));
    if (replacement?.is(setInlineDiff)) return replacement.value;
    // 原文变化立即移除旧差异，等待当前输入对应的后端结果，避免展示错位或过期预览。
    return transaction.docChanged ? Decoration.none : decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

class AddedLinesWidget extends WidgetType {
  constructor(readonly lines: readonly DiffLine[]) { super(); }

  eq(other: AddedLinesWidget) {
    return this.lines.length === other.lines.length && this.lines.every((line, index) => {
      const next = other.lines[index];
      return line.text === next.text && line.afterLine === next.afterLine && line.noNewline === next.noNewline;
    });
  }

  toDOM() {
    const block = document.createElement("div");
    block.className = "cm-diff-added-block";
    block.contentEditable = "false";
    block.title = "通用配置合并后的新增内容，仅预览；保存后写入文件";
    for (const line of this.lines) {
      const row = document.createElement("div");
      row.className = "cm-diff-added-line";
      const sign = document.createElement("span");
      sign.className = "cm-diff-sign";
      sign.textContent = "+";
      sign.setAttribute("aria-label", `新增，第 ${line.afterLine} 行`);
      const text = document.createElement("span");
      text.className = "cm-diff-added-text";
      // 仅以文本插入配置内容，避免将外部配置解释为 HTML。
      text.textContent = line.text || " ";
      row.append(sign, text);
      if (line.noNewline) {
        const marker = document.createElement("span");
        marker.className = "cm-diff-no-newline";
        marker.textContent = " ↵（末行无换行）";
        row.append(marker);
      }
      block.append(row);
    }
    return block;
  }
}

export function createInlineDiffDecorations(state: EditorState, lines: readonly DiffLine[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let nextBeforeLine = 1;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === "add") {
      const start = index;
      while (index < lines.length && lines[index].kind === "add") index += 1;
      // 新增内容锚定到下一条原文之前；无末尾换行时则放在文档末尾之后。
      const beforeLine = nextBeforeLine <= state.doc.lines;
      const position = beforeLine ? state.doc.line(nextBeforeLine).from : state.doc.length;
      ranges.push(Decoration.widget({
        widget: new AddedLinesWidget(lines.slice(start, index)), block: true, side: beforeLine ? -1 : 1,
      }).range(position));
      continue;
    }
    if (line.kind === "remove") {
      ranges.push(Decoration.line({ attributes: {
        class: "cm-diff-removed-line",
        "data-no-newline": String(line.noNewline),
        title: `合并后删除的原文${line.noNewline ? "（末行无换行）" : ""}`,
      } }).range(state.doc.line(nextBeforeLine).from));
    }
    nextBeforeLine += 1;
    index += 1;
  }
  return Decoration.set(ranges, true);
}
