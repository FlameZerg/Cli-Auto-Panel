export type Kind = "codex" | "claude";

export interface Template {
  id: string;
  name: string;
  kind: Kind;
  content: string;
  revision: number;
}

export interface Binding {
  configId: string;
  templateId: string;
  appliedContent: string;
  appliedRevision: number;
  lastHash: string;
}

export interface ConfigEntry {
  id: string;
  path: string;
  kind: Kind;
  aliases: string[];
  hash: string | null;
  error: string | null;
}

export interface Bootstrap {
  state: {
    revision: number;
    templates: Template[];
    bindings: Binding[];
    imports: { path: string; kind: Kind }[];
    // 别名配置的自定义显示顺序；缺省表示尚未排序（沿用默认顺序）。
    configOrder?: string[];
  };
  inventory: { configs: ConfigEntry[]; warnings: string[] };
  history: { id: string; label: string; createdAt: string; canRestore: boolean }[];
  profilePath: string;
  // 实际受管目录由后端解析，前端不再硬编码盘符或推断用户目录。
  codexRoot: string;
  claudeRoot: string;
  dataPath: string;
  pendingRecovery: boolean;
}

export interface Document {
  content: string;
  hash: string;
  notices: string[];
}

export interface Preview {
  id: string;
  label: string;
  files: { path: string; action: string; before: string; after: string }[];
  notices: string[];
}

export type Change =
  | { type: "saveTemplate"; id: string | null; name: string; kind: Kind; content: string; syncBindings: boolean }
  | { type: "deleteTemplate"; id: string }
  // 名称后缀与配置草稿一起保存，由后端同步更新文件及全部命令入口。
  | { type: "saveConfig"; id: string; name: string; content: string; templateId: string | null; expectedHash: string }
  | {
      type: "createAlias"; kind: Kind; launcher: string; name: string; content: string;
      templateId: string | null;
    }
  | { type: "removeAlias"; name: string }
  | { type: "deleteConfig"; id: string; expectedHash: string }
  | { type: "importConfig"; path: string; kind: Kind }
  | { type: "restoreBackup"; id: string }
  | { type: "reorderTemplates"; kind: Kind; order: string[] }
  | { type: "reorderConfigs"; order: string[] };

export interface TemplateDraft {
  id: string | null;
  name: string;
  kind: Kind;
  content: string;
}

export interface ConfigDraft {
  id: string;
  name: string;
  content: string;
  hash: string;
  templateId: string | null;
  notices: string[];
}
