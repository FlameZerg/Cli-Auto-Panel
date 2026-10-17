use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Codex,
    Claude,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub content: String,
    pub revision: u64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub config_id: String,
    pub template_id: String,
    pub applied_content: String,
    pub applied_revision: u64,
    pub last_hash: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelState {
    pub revision: u64,
    pub templates: Vec<Template>,
    pub bindings: Vec<Binding>,
    #[serde(default)]
    pub imports: Vec<ImportedConfig>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ImportedConfig {
    pub path: String,
    pub kind: Kind,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alias {
    pub name: String,
    pub path: String,
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct AstResult {
    pub aliases: Vec<Alias>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub id: String,
    pub path: String,
    pub kind: Kind,
    pub aliases: Vec<String>,
    pub hash: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub configs: Vec<ConfigEntry>,
    pub warnings: Vec<String>,
}

#[derive(Clone)]
pub struct Paths {
    pub profile: PathBuf,
    pub codex_root: PathBuf,
    pub claude_root: PathBuf,
    pub codex_base: PathBuf,
    pub data: PathBuf,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Change {
    SaveTemplate {
        id: Option<String>,
        name: String,
        kind: Kind,
        content: String,
    },
    DeleteTemplate { id: String },
    SaveConfig {
        id: String,
        content: String,
        template_id: Option<String>,
        expected_hash: String,
    },
    CreateAlias {
        kind: Kind,
        launcher: String,
        name: String,
        content: String,
        template_id: Option<String>,
    },
    RemoveAlias { name: String },
    DeleteConfig { id: String, expected_hash: String },
    ImportConfig { path: String, kind: Kind },
    RestoreBackup { id: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequest {
    pub expected_revision: u64,
    pub change: Change,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: PathBuf,
    pub before: Option<String>,
    pub after: Option<String>,
    pub before_identity: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPlan {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub before_state: PanelState,
    pub after_state: PanelState,
    pub files: Vec<FileChange>,
    pub notices: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    pub path: String,
    pub action: String,
    pub before: String,
    pub after: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub label: String,
    pub files: Vec<PreviewFile>,
    pub notices: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub can_restore: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub state: PanelState,
    pub inventory: Inventory,
    pub history: Vec<HistoryEntry>,
    pub profile_path: String,
    pub data_path: String,
    pub pending_recovery: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub content: String,
    pub hash: String,
    pub notices: Vec<String>,
}

#[derive(Serialize)]
pub struct Extraction {
    pub content: String,
    pub excluded: Vec<String>,
}
