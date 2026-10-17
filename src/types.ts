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
  };
  inventory: { configs: ConfigEntry[]; warnings: string[] };
  history: { id: string; label: string; createdAt: string; canRestore: boolean }[];
  profilePath: string;
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
  | { type: "saveTemplate"; id: string | null; name: string; kind: Kind; content: string }
  | { type: "deleteTemplate"; id: string }
  | { type: "saveConfig"; id: string; content: string; templateId: string | null; expectedHash: string }
  | {
      type: "createAlias"; kind: Kind; launcher: string; name: string; content: string;
      templateId: string | null;
    }
  | { type: "removeAlias"; name: string }
  | { type: "deleteConfig"; id: string; expectedHash: string }
  | { type: "importConfig"; path: string; kind: Kind }
  | { type: "restoreBackup"; id: string };

export interface TemplateDraft {
  id: string | null;
  name: string;
  kind: Kind;
  content: string;
}

export interface ConfigDraft {
  id: string;
  content: string;
  hash: string;
  templateId: string | null;
  notices: string[];
}
