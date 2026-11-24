import { invoke } from "@tauri-apps/api/core";
import type { Bootstrap, Change, CommitOutcome, Document, Kind, LayoutOutcome, MergePriority, Preparation } from "./types";

let pendingBootstrap: Promise<Bootstrap> | null = null;
function bootstrap(): Promise<Bootstrap> {
  // 仅合并进行中的读取，完成即释放；刷新不复用上一次扫描快照。
  if (!pendingBootstrap) {
    const request: Promise<Bootstrap> = invoke<Bootstrap>("bootstrap").finally(() => {
      if (pendingBootstrap === request) pendingBootstrap = null;
    });
    pendingBootstrap = request;
  }
  return pendingBootstrap;
}
async function write<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  // 写入前后的读取必须分代，不能让写后刷新接收到写前仍在途的旧快照。
  pendingBootstrap = null;
  try { return await invoke<T>(command, args); }
  finally { pendingBootstrap = null; }
}

// 集中定义前后端共用的配置操作协议。
export const api = {
  bootstrap,
  readConfig: (id: string) => invoke<Document>("read_config", { id }),
  // 草稿级预览显式传递优先级，和保存采用同一规则，只读运算、不落盘。
  previewMerge: (kind: Kind, content: string, template: string | null, mergePriority: MergePriority,
    configId: string | null = null) =>
    invoke<string>("preview_merge", { kind, content, template, configId, mergePriority }),
  prepare: (expectedRevision: number, change: Change, expectedLayoutRevision: number) =>
    invoke<Preparation>("prepare_change", { request: { expectedRevision, expectedLayoutRevision, change } }),
  // 布局直接保存到小份数据库状态，不生成配置备份或占用预览计划。
  updateLayout: (expectedRevision: number, expectedLayoutRevision: number, change: Change) =>
    write<LayoutOutcome>("update_layout", { request: { expectedRevision, expectedLayoutRevision, change } }),
  commit: (id: string) => write<CommitOutcome>("commit_change", { id }),
  recover: () => write<Bootstrap>("recover_pending"),
};
