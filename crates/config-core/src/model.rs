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

// 分组只组织同一产品下的配置卡片，不参与模板绑定或真实文件布局。
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigGroup {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub config_ids: Vec<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelState {
    pub revision: u64,
    // 布局独立计版，拖拽和分组不再使配置撤销失效。
    #[serde(default, skip_serializing_if = "is_zero")]
    pub layout_revision: u64,
    pub templates: Vec<Template>,
    pub bindings: Vec<Binding>,
    #[serde(default)]
    pub imports: Vec<ImportedConfig>,
    // 别名配置的自定义显示顺序：跨应用类型全局一份，按配置 id 登记。
    // 空列表不序列化，保证与旧版本数据库及旧备份的状态比对仍完全一致。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config_order: Vec<String>,
    // 缺省和空值均兼容旧数据库及旧备份，避免新增字段破坏历史状态比较。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config_groups: Vec<ConfigGroup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub template_order: Vec<String>,
}

fn is_zero(value: &u64) -> bool { *value == 0 }
fn is_false(value: &bool) -> bool { !*value }

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
        // 旧调用仍默认同步；仅保存模板时不触碰任何引用文件。
        #[serde(default = "sync_templates_by_default")]
        sync_bindings: bool,
    },
    DeleteTemplate { id: String },
    SaveConfig {
        id: String,
        // 缺省时沿用原文件名，兼容不包含重命名请求的保存操作。
        name: Option<String>,
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
    // 应用拖拽排序：一份模板显示顺序、一份别名配置显示顺序，均为全量 id 列表。
    ReorderTemplates { kind: Kind, order: Vec<String> },
    ReorderConfigs { order: Vec<String> },
    // 分组操作只提交面板元数据，不改写配置文件或命令入口。
    SaveConfigGroup { id: Option<String>, name: String, kind: Kind },
    DeleteConfigGroup { id: String },
    AssignConfigGroup { config_id: String, group_id: Option<String> },
}

fn sync_templates_by_default() -> bool { true }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRequest {
    pub expected_revision: u64,
    pub expected_layout_revision: u64,
    pub change: Change,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileGuard {
    pub path: PathBuf,
    pub hash: Option<String>,
    pub identity: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ConfigIdentityChange {
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct CreatedFile {
    pub path: PathBuf,
    pub identity: String,
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
    #[serde(default = "legacy_plan_version")]
    pub format_version: u32,
    pub id: String,
    pub label: String,
    pub created_at: String,
    pub before_state: PanelState,
    pub after_state: PanelState,
    pub files: Vec<FileChange>,
    // 只读依赖仅保存哈希与身份，不再重复备份两份完整正文。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guards: Vec<FileGuard>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub identity_changes: Vec<ConfigIdentityChange>,
    // 旧版全量布局撤销不能冒充可与后续布局安全合并的新格式操作。
    #[serde(default, skip_serializing_if = "is_false")]
    pub layout_snapshot: bool,
    pub notices: Vec<String>,
}

fn legacy_plan_version() -> u32 { 1 }

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
    pub legacy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub id: String,
    pub snapshot: Option<Bootstrap>,
    pub warnings: Vec<String>,
    pub refresh_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutOutcome {
    pub layout_revision: u64,
    pub config_order: Vec<String>,
    pub template_order: Vec<String>,
    pub config_groups: Vec<ConfigGroup>,
    // 布局已提交与历史索引可用性分开表达，后续读取失败不能伪装成保存失败。
    pub history: Option<Vec<HistoryEntry>>,
    pub history_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub state: PanelState,
    pub inventory: Inventory,
    pub history: Vec<HistoryEntry>,
    pub history_error: Option<String>,
    pub profile_path: String,
    // 返回实际受管目录，供新建和导入界面显示。
    pub codex_root: String,
    pub claude_root: String,
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
