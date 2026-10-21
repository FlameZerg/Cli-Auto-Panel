export type DiffKind = "equal" | "remove" | "add";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
  noNewline: boolean;
}

interface Edit { kind: DiffKind; text: string }

// 保留行尾语义：空文件不产生虚构空行，末行缺少换行也能被准确比较。
function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").match(/[^\n]*\n|[^\n]+$/g) || [];
}

function backtrack(before: string[], after: string[], trace: Map<number, number>[]): Edit[] {
  let x = before.length;
  let y = after.length;
  const reversed: Edit[] = [];
  for (let depth = trace.length - 1; depth >= 0; depth -= 1) {
    const previous = trace[depth];
    const diagonal = x - y;
    const left = previous.get(diagonal - 1) ?? -1;
    const right = previous.get(diagonal + 1) ?? -1;
    const previousDiagonal = diagonal === -depth || (diagonal !== depth && left < right)
      ? diagonal + 1 : diagonal - 1;
    const previousX = previous.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      reversed.push({ kind: "equal", text: before[x - 1] });
      x -= 1; y -= 1;
    }
    if (depth === 0) break;
    if (x === previousX) {
      reversed.push({ kind: "add", text: after[y - 1] }); y -= 1;
    } else {
      reversed.push({ kind: "remove", text: before[x - 1] }); x -= 1;
    }
  }
  return reversed.reverse();
}

// Myers 最短编辑路径；先剥离共同首尾，避免大文件的小改动消耗整份文件的比较成本。
function compareMiddle(before: string[], after: string[]): Edit[] {
  if (!before.length) return after.map((text) => ({ kind: "add", text }));
  if (!after.length) return before.map((text) => ({ kind: "remove", text }));
  const available = new Set(before);
  if (!after.some((line) => available.has(line))) {
    return [...before.map((text): Edit => ({ kind: "remove", text })),
      ...after.map((text): Edit => ({ kind: "add", text }))];
  }
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  let work = 0;
  // 明确限制极端差异的路径搜索成本，超限报告错误，绝不展示伪造或降级的 diff。
  const maxWork = 2_000_000;
  for (let depth = 0; depth <= before.length + after.length; depth += 1) {
    trace.push(frontier);
    const next = new Map<number, number>();
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      if (++work > maxWork) throw new Error("差异过于复杂，已停止逐行比较；请缩小本次编辑范围后重试。");
      const left = frontier.get(diagonal - 1) ?? -1;
      const right = frontier.get(diagonal + 1) ?? -1;
      let x = diagonal === -depth || (diagonal !== depth && left < right) ? right : left + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        if (++work > maxWork) throw new Error("差异比较超过支持上限，请缩小本次编辑范围后重试。");
        x += 1; y += 1;
      }
      next.set(diagonal, x);
      if (x >= before.length && y >= after.length) return backtrack(before, after, trace);
    }
    frontier = next;
  }
  throw new Error("未能生成完整差异，已停止预览。");
}

export function buildLineDiff(beforeText: string, afterText: string): DiffLine[] {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let end = 0;
  while (end < before.length - start && end < after.length - start
    && before[before.length - end - 1] === after[after.length - end - 1]) end += 1;
  const edits: Edit[] = [
    ...before.slice(0, start).map((text): Edit => ({ kind: "equal", text })),
    ...compareMiddle(before.slice(start, before.length - end), after.slice(start, after.length - end)),
    ...before.slice(before.length - end).map((text): Edit => ({ kind: "equal", text })),
  ];
  let beforeLine = 0;
  let afterLine = 0;
  return edits.map((edit) => ({
    kind: edit.kind,
    text: edit.text.endsWith("\n") ? edit.text.slice(0, -1) : edit.text,
    beforeLine: edit.kind === "add" ? null : ++beforeLine,
    afterLine: edit.kind === "remove" ? null : ++afterLine,
    noNewline: !edit.text.endsWith("\n"),
  }));
}
