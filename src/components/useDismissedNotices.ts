import { useState } from "react";

const storageKey = "cli-auto-panel.dismissed-notices";
type Dismissals = { ids: Set<string>; storageError: boolean };

function loadDismissals(): Dismissals {
  try {
    const raw = localStorage.getItem(storageKey);
    const saved: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(saved) || !saved.every((id) => typeof id === "string")) {
      throw new Error("已关闭提示记录格式无效。");
    }
    return { ids: new Set<string>(saved), storageError: false };
  } catch (error) {
    console.error("无法读取提示关闭记录：", error);
    return { ids: new Set(), storageError: true };
  }
}

export function useDismissedNotices() {
  const [{ ids, storageError }, setDismissals] = useState(loadDismissals);

  function dismiss(keys: string[]) {
    if (!keys.length) return;
    const next = new Set([...ids, ...keys]);
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next]));
      setDismissals({ ids: next, storageError: false });
    } catch (error) {
      console.error("无法保存提示关闭记录：", error);
      setDismissals({ ids: next, storageError: true });
    }
  }

  return { ids, storageError, dismiss };
}
