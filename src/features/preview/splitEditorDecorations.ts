import { EditorState, RangeSet, StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { BlockType, Decoration, EditorView, WidgetType, type BlockInfo, type DecorationSet } from "@codemirror/view";
import { foldEffect } from "@codemirror/language";
import type { SplitDiffRow } from "./splitDiff";

const setSplitDecorations = StateEffect.define<DecorationSet>();

// 空位和红绿标记只存在于装饰层，不写入文档，复制、查找及保存均使用真实正文。
export const splitEditorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, transaction) => {
    const replacement = transaction.effects.find((effect) => effect.is(setSplitDecorations));
    return replacement?.is(setSplitDecorations) ? replacement.value
      : transaction.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// 双栏始终展开真实正文，防止单侧折叠改变对应行的几何关系；普通编辑器不受影响。
export const splitEditorExtensions = [
  splitEditorField,
  EditorState.transactionFilter.of((transaction) =>
    transaction.effects.some((effect) => effect.is(foldEffect)) ? [] : transaction),
];

class AlignmentSpacer extends WidgetType {
  constructor(readonly height: number, readonly kind: string) { super(); }
  eq(other: AlignmentSpacer) { return this.height === other.height && this.kind === other.kind; }
  get estimatedHeight() { return this.height; }
  toDOM() {
    const element = document.createElement("div");
    element.className = `cm-diff-spacer ${this.kind}`;
    element.style.height = `${this.height}px`;
    element.setAttribute("aria-hidden", "true");
    return element;
  }
}

function textHeight(block: BlockInfo): number {
  const type = block.type;
  return typeof type === "number" ? (type === BlockType.Text ? block.height : 0)
    : type.reduce((height, child) => height + textHeight(child), 0);
}

function rowHeight(view: EditorView, number: number | null): number {
  if (number === null) return 0;
  return Math.max(view.defaultLineHeight, textHeight(view.lineBlockAt(view.state.doc.line(number).from)));
}

function sideDecorations(
  view: EditorView, rows: readonly SplitDiffRow[], heights: readonly [number, number][], side: "before" | "after",
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  let nextLine = 1;
  rows.forEach((row, index) => {
    const line = row[side];
    const ownHeight = heights[index][side === "before" ? 0 : 1];
    const height = Math.max(...heights[index]);
    const kind = line?.kind === "remove" ? "cm-split-removed-line"
      : line?.kind === "add" ? "cm-split-added-line" : "";
    if (line) {
      const number = side === "before" ? line.beforeLine : line.afterLine;
      if (number === null) throw new Error("双栏差异行号缺失，已停止对齐。");
      const current = view.state.doc.line(number);
      if (kind) ranges.push(Decoration.line({ attributes: {
        class: kind, "data-no-newline": String(line.noNewline),
      } }).range(current.from));
      if (height - ownHeight > .5) {
        ranges.push(Decoration.widget({
          widget: new AlignmentSpacer(height - ownHeight, kind), block: true, side: 1,
        }).range(current.to));
      }
      nextLine = number + 1;
    } else if (height > 0) {
      const inside = nextLine <= view.state.doc.lines;
      ranges.push(Decoration.widget({
        widget: new AlignmentSpacer(height, ""), block: true, side: inside ? -1 : 1,
      }).range(inside ? view.state.doc.line(nextLine).from : view.state.doc.length));
    }
  });
  return Decoration.set(ranges, true);
}

// 成对视图按 CodeMirror 实际换行高度对齐；测量读写分离，窗口、搜索面板及正文变化都可重新布局。
export function connectSplitEditors(before: EditorView, after: EditorView, onError: (error: string) => void) {
  let rows: readonly SplitDiffRow[] = [];
  let expectedBefore: Text | null = null;
  let expectedAfter: Text | null = null;
  let revision = 0;
  let disposed = false;
  let applying = false;
  const pendingScroll = new Map<EditorView, number>();
  const measureKey = {};

  function documentsMatch() {
    return expectedBefore && expectedAfter && before.state.doc.eq(expectedBefore) && after.state.doc.eq(expectedAfter);
  }

  function measure() {
    if (disposed || applying) return;
    const currentRevision = revision;
    before.requestMeasure({
      key: measureKey,
      read: () => {
        if (disposed || currentRevision !== revision || !documentsMatch()) return null;
        try {
          return { heights: rows.map((row): [number, number] => [
            rowHeight(before, row.before?.beforeLine ?? null), rowHeight(after, row.after?.afterLine ?? null),
          ]), error: "" };
        } catch (failure) { return { heights: null, error: String(failure) }; }
      },
      write: (result) => {
        // 测量写阶段仍处于 CodeMirror 更新中；退出该阶段后再派发装饰事务，避免重入报错。
        queueMicrotask(() => {
          if (disposed || currentRevision !== revision || !result || !documentsMatch()) return;
          if (result.error || !result.heights) { onError(result.error); return; }
          applying = true;
          try {
            for (const [view, side] of [[before, "before"], [after, "after"]] as const) {
              const decorations = sideDecorations(view, rows, result.heights, side);
              if (!RangeSet.eq([view.state.field(splitEditorField)], [decorations])) {
                view.dispatch({ effects: setSplitDecorations.of(decorations) });
              }
            }
            onError("");
          } catch (failure) { onError(String(failure)); }
          finally { applying = false; }
        });
      },
    });
  }

  function scroll(source: EditorView, target: EditorView) {
    const expected = pendingScroll.get(source);
    pendingScroll.delete(source);
    if (expected !== undefined && Math.abs(expected - source.scrollDOM.scrollTop) < 1) return;
    if (Math.abs(target.scrollDOM.scrollTop - source.scrollDOM.scrollTop) < 1) return;
    // 记录实际落点，目标端后续异步 scroll 不反向传播，避免循环和搜索定位被弹回。
    target.scrollDOM.scrollTop = source.scrollDOM.scrollTop;
    pendingScroll.set(target, target.scrollDOM.scrollTop);
    measure();
  }
  const scrollBefore = () => scroll(before, after);
  const scrollAfter = () => scroll(after, before);
  before.scrollDOM.addEventListener("scroll", scrollBefore, { passive: true });
  after.scrollDOM.addEventListener("scroll", scrollAfter, { passive: true });

  return {
    measure,
    update(nextRows: readonly SplitDiffRow[], beforeText: string, afterText: string) {
      rows = nextRows;
      // 每次正文变动只规范化一次；滚动测量复用不可变文档引用，不重复解析整份配置。
      const oldDocument = before.state.toText(beforeText);
      const newDocument = after.state.toText(afterText);
      expectedBefore = before.state.doc.eq(oldDocument) ? before.state.doc : oldDocument;
      expectedAfter = after.state.doc.eq(newDocument) ? after.state.doc : newDocument;
      revision += 1;
      measure();
    },
    dispose() {
      disposed = true;
      before.scrollDOM.removeEventListener("scroll", scrollBefore);
      after.scrollDOM.removeEventListener("scroll", scrollAfter);
    },
  };
}
