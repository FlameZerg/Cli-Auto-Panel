import { useEffect, useState } from "react";
import { api } from "../../api";
import type { Kind, MergePriority } from "../../types";

interface Input {
  kind: Kind;
  content: string;
  template: string | null;
  mergePriority: MergePriority;
  configId?: string;
  revision: number;
  enabled: boolean;
}

interface Result { input: Input; after: string; error: string }

// 预览不更改草稿；模板、优先级与版本一起核对，快速切换时不显示过期差异。
export function useMergePreview(input: Input) {
  const { kind, content, template, mergePriority, configId, revision, enabled } = input;
  const [result, setResult] = useState<Result | null>(null);
  const current = result && result.input.kind === kind && result.input.content === content
    && result.input.template === template && result.input.configId === configId
    && result.input.mergePriority === mergePriority
    && result.input.revision === revision
    && result.input.enabled === enabled ? result : null;
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // 轻量延迟合并连续输入，减少每个按键跨进程解析；勾选后无需点击保存即可看到差异。
    const timer = window.setTimeout(() => {
      api.previewMerge(kind, content, template, mergePriority, configId ?? null)
        .then((after) => { if (live) setResult({ input: { kind, content, template, mergePriority, configId, revision, enabled }, after, error: "" }); })
        .catch((failure) => { if (live) setResult({ input: { kind, content, template, mergePriority, configId, revision, enabled }, after: "", error: String(failure) }); });
    }, 150);
    return () => { live = false; window.clearTimeout(timer); };
  }, [kind, content, template, mergePriority, configId, revision, enabled]);
  return {
    after: current?.after ?? null,
    error: current?.error ?? "",
    loading: enabled && !current,
  };
}
