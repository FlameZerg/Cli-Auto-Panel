import type { Bootstrap, Change, Kind, Preview } from "../../types";
import { configPath } from "../aliases/configNames";

export interface PreviewEditor { path: string; kind: Kind }

// 只定位本次保存的源正文；同事务生成的 profile、其他绑定文件及删除内容不可直接改写。
export function previewEditor(data: Bootstrap, preview: Preview, change: Change | null): PreviewEditor | null {
  if (change?.type === "saveTemplate") {
    const path = `通用配置库 / ${change.name.trim()}`;
    return preview.files.some((file) => file.path === path && file.action === "元数据")
      ? { path, kind: change.kind } : null;
  }
  if (change?.type !== "saveConfig") return null;
  const entry = data.inventory.configs.find((config) => config.id === change.id);
  if (!entry) return null;
  const path = configPath(entry, change.name);
  const normalize = (value: string) => value.replace(/\//g, "\\").toLowerCase();
  const file = preview.files.find((file) => file.action !== "真实删除" && normalize(file.path) === normalize(path));
  return file ? { path: file.path, kind: entry.kind } : null;
}

export function previewLanguage(path: string): Kind | "text" {
  return /\.toml$/i.test(path) ? "codex" : /\.json$/i.test(path) ? "claude" : "text";
}
