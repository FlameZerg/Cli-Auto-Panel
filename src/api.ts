import { invoke } from "@tauri-apps/api/core";
import type { Bootstrap, Change, Document, Kind, Preview } from "./types";

// 仅调用受限桌面命令，不提供任意路径写入或外网请求接口。
export const api = {
  bootstrap: () => invoke<Bootstrap>("bootstrap"),
  readConfig: (id: string) => invoke<Document>("read_config", { id }),
  extract: (kind: Kind, content: string) =>
    invoke<{ content: string; excluded: string[] }>("extract_common", { kind, content }),
  shortcut: (kind: Kind, content: string, key: string, enabled: boolean) =>
    invoke<string>("apply_shortcut", { kind, content, key, enabled }),
  prepare: (expectedRevision: number, change: Change) =>
    invoke<Preview>("prepare_change", { request: { expectedRevision, change } }),
  preview: (showSecrets: boolean) => invoke<Preview>("preview_change", { showSecrets }),
  commit: (id: string) => invoke<Bootstrap>("commit_change", { id }),
  recover: () => invoke<Bootstrap>("recover_pending"),
};
