mod alias_service;
mod compatibility;
mod config_groups;
mod discovery;
mod extract;
mod files;
mod journal;
mod merge_json;
mod merge_toml;
pub mod model;
mod planner;
mod powershell;
mod profile_editor;
mod rename_service;
mod repository;

use model::*;
use std::path::{Path, PathBuf};

pub struct Engine {
    paths: Paths,
    store: repository::Store,
    ast_cache: Option<(String, AstResult)>,
    preview: Option<ApplyPlan>,
}

// 配置目录遵循各 CLI 的环境变量，未设置时使用当前用户默认目录。
fn config_root(variable: &str, default: PathBuf) -> Result<PathBuf> {
    let root = std::env::var_os(variable).filter(|value| !value.is_empty())
        .map(PathBuf::from).unwrap_or(default);
    if !root.is_absolute() { return Err(format!("{variable} 必须是绝对路径。")); }
    Ok(root)
}

impl Engine {
    pub fn open() -> Result<Self> {
        let user = dirs::home_dir().ok_or("无法确定当前用户目录。")?;
        let local = dirs::data_local_dir().ok_or("无法确定当前用户应用数据目录。")?;
        let codex_home = config_root("CODEX_HOME", user.join(".codex"))?;
        let claude_home = config_root("CLAUDE_CONFIG_DIR", user.join(".claude"))?;
        let paths = Paths {
            profile: user.join("Documents/PowerShell/Microsoft.PowerShell_profile.ps1"),
            // 别名配置直接放在实际配置根目录，不再依赖私有盘符或 ccs 子目录。
            codex_root: codex_home.clone(),
            claude_root: claude_home,
            codex_base: codex_home.join("config.toml"),
            data: local.join("CliAutoPanel"),
        };
        let store = repository::Store::open(&paths.data)?;
        Ok(Self { paths, store, ast_cache: None, preview: None })
    }

    fn ast(&mut self) -> Result<(String, AstResult)> {
        let (text, bytes, _) = profile_editor::read(&self.paths.profile)?;
        let hash = files::hash(&bytes);
        if let Some((previous, ast)) = &self.ast_cache {
            if previous == &hash { return Ok((hash, ast.clone())); }
        }
        let ast = profile_editor::parse(&text.value)?;
        self.ast_cache = Some((hash.clone(), ast.clone()));
        Ok((hash, ast))
    }

    pub fn bootstrap(&mut self) -> Result<Bootstrap> {
        let state = self.store.load()?;
        let ast = match self.ast() {
            Ok((_, ast)) => ast,
            Err(error) => AstResult { warnings: vec![error], ..AstResult::default() },
        };
        let mut inventory = discovery::inventory(&self.paths, &ast, &state);
        for binding in &state.bindings {
            if !inventory.configs.iter().any(|c| c.id == binding.config_id) {
                inventory.warnings.push(format!("存在失去入口的绑定 {}，重新导入原文件后才能同步。", binding.config_id));
            }
        }
        Ok(Bootstrap {
            history: journal::history(&self.paths.data, &state)?,
            state, inventory,
            profile_path: self.paths.profile.to_string_lossy().into(),
            // 界面提示与后端路径校验共用同一目录来源，避免前端猜测用户路径。
            codex_root: self.paths.codex_root.to_string_lossy().into(),
            claude_root: self.paths.claude_root.to_string_lossy().into(),
            data_path: self.paths.data.to_string_lossy().into(),
            pending_recovery: journal::pending(&self.paths.data),
        })
    }

    pub fn read_config(&mut self, id: &str) -> Result<Document> {
        let state = self.store.load()?;
        let (_, ast) = self.ast()?;
        let inventory = discovery::inventory(&self.paths, &ast, &state);
        let entry = inventory.configs.iter().find(|c| c.id == id).ok_or("文件不在受管清单中。")?;
        if let Some(error) = &entry.error { return Err(error.clone()); }
        let path = discovery::managed_path(&self.paths, Path::new(&entry.path), entry.kind)?;
        let (bytes, _) = files::read(&path)?.ok_or("配置文件不存在。")?;
        let content = files::Text::decode(&bytes, false)?.value;
        let hash = files::hash(&bytes);
        let mut notices = Vec::new();
        if let Err(error) = planner::validate(entry.kind, &content) {
            notices.push(format!("{error} 可在编辑器中修复后重新保存。"));
        }
        if let Some(binding) = state.bindings.iter().find(|b| b.config_id == id) {
            if binding.last_hash != hash {
                notices.push("文件已被外部修改；重新载入后保存将以当前文件为基线，不会反向修改公共模板。".into());
            }
        }
        if entry.kind == Kind::Codex {
            match compatibility::inspect_codex(&self.paths, &content) {
                Ok((messages, _)) => notices.extend(messages),
                Err(error) => notices.push(error),
            }
        }
        Ok(Document { content, hash, notices })
    }

    pub fn extract(&self, kind: Kind, content: &str) -> Result<Extraction> {
        planner::validate(kind, content)?;
        extract::extract(kind, content)
    }

    // 只读草稿预览沿用保存逻辑，按实际绑定剥离旧片段，不读取或改写配置文件。
    pub fn preview_merge(
        &self, kind: Kind, content: &str, template: Option<&str>, config_id: Option<&str>,
    ) -> Result<String> {
        let state = self.store.load()?;
        let binding = config_id.and_then(|id| state.bindings.iter().find(|b| b.config_id == id));
        if let Some(binding) = binding {
            if state.templates.iter().any(|t| t.id == binding.template_id && t.kind != kind) {
                return Err("不能跨 Codex / Claude 预览通用配置。".into());
            }
        }
        planner::merge_config(kind, content, binding.map(|b| b.applied_content.as_str()), template)
    }

    pub fn prepare(&mut self, request: ChangeRequest) -> Result<Preview> {
        self.preview = None;
        if journal::pending(&self.paths.data) { return Err("必须先恢复未完成操作，再创建新的修改计划。".into()); }
        let state = self.store.load()?;
        // 独立模板及分组容器管理不依赖配置文件，失效入口不应阻断元数据维护。
        let metadata_only = matches!(&request.change,
            Change::DeleteTemplate { .. } | Change::SaveTemplate { sync_bindings: false, .. }
            | Change::SaveConfigGroup { .. } | Change::DeleteConfigGroup { .. });
        let (profile_hash, ast, inventory) = if metadata_only {
            (String::new(), AstResult::default(), Inventory { configs: Vec::new(), warnings: Vec::new() })
        } else {
            let (hash, ast) = self.ast()?;
            let inventory = discovery::inventory(&self.paths, &ast, &state);
            (hash, ast, inventory)
        };
        let plan = planner::prepare(&self.paths, state, &inventory, &ast, &profile_hash, request)?;
        self.validate_plan_paths(&plan)?;
        // 差异生成失败时不保留可提交计划，避免失败请求遗留有效写入入口。
        let preview = self.preview(&plan)?;
        self.preview = Some(plan);
        Ok(preview)
    }

    fn preview(&self, plan: &ApplyPlan) -> Result<Preview> {
        let mut files = Vec::new();
        for change in &plan.files {
            if change.before == change.after { continue; }
            let before = change.before.as_deref().map(|b| self.preview_text(b, &change.path))
                .transpose()?.unwrap_or_default();
            let after = change.after.as_deref().map(|b| self.preview_text(b, &change.path))
                .transpose()?.unwrap_or_default();
            files.push(PreviewFile {
                path: change.path.to_string_lossy().into(),
                action: match (&change.before, &change.after) {
                    (None, Some(_)) => "新建", (Some(_), None) => "真实删除", _ => "更新",
                }.into(),
                before, after,
            });
        }
        for next in &plan.after_state.templates {
            let old = plan.before_state.templates.iter().find(|t| t.id == next.id);
            if old.is_some_and(|t| t.content == next.content && t.name == next.name) { continue; }
            files.push(PreviewFile {
                path: format!("通用配置库 / {}", next.name), action: "元数据".into(),
                before: old.map(|t| t.content.clone()).unwrap_or_default(),
                after: next.content.clone(),
            });
        }
        // 模板删除及撤销新建模板也需要展示被移除的内容，不能显示为空差异。
        for old in &plan.before_state.templates {
            if plan.after_state.templates.iter().any(|t| t.id == old.id) { continue; }
            files.push(PreviewFile {
                path: format!("通用配置库 / {}", old.name), action: "删除模板".into(),
                before: old.content.clone(), after: String::new(),
            });
        }
        Ok(Preview { id: plan.id.clone(), label: plan.label.clone(), files, notices: plan.notices.clone() })
    }

    fn preview_text(&self, encoded: &str, path: &Path) -> Result<String> {
        let bytes = files::unpack(encoded)?;
        Ok(files::Text::decode(&bytes, path == self.paths.profile)?.value)
    }

    fn validate_plan_paths(&self, plan: &ApplyPlan) -> Result<()> {
        uuid::Uuid::parse_str(&plan.id).map_err(|_| "操作日志编号不合法，禁止恢复。")?;
        let mut seen = std::collections::HashSet::new();
        for change in &plan.files {
            for encoded in [&change.before, &change.after].into_iter().flatten() {
                if files::unpack(encoded)?.len() as u64 > files::MAX_BYTES {
                    return Err("操作结果超过单文件大小限制，未执行写入。".into());
                }
            }
            if !seen.insert(discovery::key(&change.path)) {
                return Err("操作计划重复写入同一路径，已停止。".into());
            }
            if change.path == self.paths.profile { continue; }
            if change.path == self.paths.codex_base && change.before == change.after { continue; }
            let codex = discovery::managed_path(&self.paths, &change.path, Kind::Codex)
                .is_ok_and(|resolved| resolved == change.path);
            let claude = discovery::managed_path(&self.paths, &change.path, Kind::Claude)
                .is_ok_and(|resolved| resolved == change.path);
            if !codex && !claude {
                return Err("操作计划含有范围外文件，已禁止提交。".into());
            }
        }
        Ok(())
    }

    pub fn commit(&mut self, id: &str) -> Result<Bootstrap> {
        let plan = self.preview.take().ok_or("没有可以提交的操作计划。")?;
        if plan.id != id { return Err("操作编号已过期，请重新保存。".into()); }
        self.validate_plan_paths(&plan)?;
        journal::commit(&self.paths.data, &mut self.store, &plan)?;
        self.ast_cache = None;
        self.bootstrap()
    }

    pub fn recover(&mut self) -> Result<Bootstrap> {
        self.preview = None;
        let plan = journal::pending_plan(&self.paths.data)?;
        self.validate_plan_paths(&plan)?;
        journal::recover(&self.paths.data, &mut self.store)?;
        self.ast_cache = None;
        self.bootstrap()
    }
}
