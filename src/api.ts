import { invoke } from "@tauri-apps/api/core";
import type { Bootstrap, Change, CommitOutcome, Document, Kind, LayoutOutcome, MergePriority, Preview } from "./types";

// 集中定义前后端共用的配置操作协议。
export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  readConfig: (id: string) => invoke<Document>("read_config", { id }),
  extract: (kind: Kind, content: string) =>
    invoke<{ content: string; excluded: string[] }>("extract_common", { kind, content }),
  // 草稿级预览显式传递优先级，和保存采用同一规则，只读运算、不落盘。
  previewMerge: (kind: Kind, content: string, template: string | null, mergePriority: MergePriority,
    configId: string | null = null) =>
    invoke<string>("preview_merge", { kind, content, template, configId, mergePriority }),
  prepare: (expectedRevision: number, change: Change, expectedLayoutRevision: number) =>
    invoke<Preview>("prepare_change", { request: { expectedRevision, expectedLayoutRevision, change } }),
  // 布局直接保存到小份数据库状态，不生成配置备份或占用预览计划。
  updateLayout: (expectedRevision: number, expectedLayoutRevision: number, change: Change) =>
    invoke<LayoutOutcome>("update_layout", { request: { expectedRevision, expectedLayoutRevision, change } }),
  commit: (id: string) => invoke<CommitOutcome>("commit_change", { id }),
  recover: () => invoke<Bootstrap>("recover_pending"),
};
