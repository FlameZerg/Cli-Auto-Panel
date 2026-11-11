import type { DiffLine } from "./lineDiff";

export interface SplitDiffRow {
  before: DiffLine | null;
  after: DiffLine | null;
}

// 复用已有逐行差异，按连续变更块配对；单边多出的行用空位对齐，不丢弃任何原文或新文。
export function buildSplitDiff(lines: readonly DiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.kind === "equal") {
      rows.push({ before: line, after: line });
      index += 1;
      continue;
    }
    const before: DiffLine[] = [];
    const after: DiffLine[] = [];
    while (index < lines.length && lines[index].kind !== "equal") {
      const changed = lines[index];
      if (changed.kind === "remove") before.push(changed);
      else after.push(changed);
      index += 1;
    }
    for (let offset = 0; offset < Math.max(before.length, after.length); offset += 1) {
      rows.push({ before: before[offset] ?? null, after: after[offset] ?? null });
    }
  }
  return rows;
}
