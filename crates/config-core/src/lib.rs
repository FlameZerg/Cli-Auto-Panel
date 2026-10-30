mod alias_service;
mod compatibility;
mod config_groups;
mod discovery;
mod extract;
mod files;
mod journal;
mod history_store;
mod layout;
mod launcher_service;
mod merge_json;
mod merge_policy;
mod merge_toml;
pub mod model;
mod planner;
mod powershell;
mod profile_editor;
mod rename_service;
mod repository;
mod state;
mod storage_schema;

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
            history: self.store.history(&self.paths.data, &state)?,
            history_error: None,
            state, inventory,
            profile_path: self.paths.profile.to_string_lossy().into(),
            // 界面提示与后端路径校验共用同一目录来源，避免前端猜测用户路径。
            codex_root: self.paths.codex_root.to_string_lossy().into(),
            claude_root: self.paths.claude_root.to_string_lossy().into(),
            data_path: self.paths.data.to_string_lossy().into(),
            pending_recovery: journal::pending(&self.paths.data)? || self.store.is_legacy(),
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
        // 共享配置的说明不进入编辑页，仅返回真实的语法及兼容性错误。
        if entry.kind == Kind::Codex {
            if let Err(error) = compatibility::inspect_codex(&self.paths, &content) { notices.push(error); }
        }
        Ok(Document { content, hash, notices })
    }

    pub fn extract(&self, kind: Kind, content: &str) -> Result<Extraction> {
        planner::validate(kind, content)?;
        extract::extract(kind, content)
    }

    // 只读预览采用草稿优先级，与保存共用三方合并；取消应用直接返回原文。
    pub fn preview_merge(
        &self, kind: Kind, content: &str, template: Option<&str>, config_id: Option<&str>,
        merge_priority: MergePriority,
    ) -> Result<String> {
        let state = self.store.load()?;
        let binding = config_id.and_then(|id| state.bindings.iter().find(|b| b.config_id == id));
        if let Some(binding) = binding {
            if state.templates.iter().any(|t| t.id == binding.template_id && t.kind != kind) {
                return Err("不能跨 Codex / Claude 预览通用配置。".into());
            }
        }
        planner::merge_config(kind, content, binding, template, merge_priority).map(|(output, _)| output)
    }

    pub fn prepare(&mut self, request: ChangeRequest) -> Result<Preview> {
        self.preview = None;
        if journal::pending(&self.paths.data)? || self.store.is_legacy() {
            return Err("必须先恢复未完成操作并完成存储迁移，再创建新的修改计划。".into());
        }
        if layout::is_change(&request.change) { return Err("列表布局请使用轻量保存入口。".into()); }
        let state = self.store.load()?;
        let backup = if let Change::RestoreBackup { id } = &request.change {
            let backup = self.store.backup(&self.paths.data, id)?;
            self.validate_plan_paths(&backup)?;
            Some(backup)
        } else { None };
        // 删除模板及恢复不依赖配置清单；模板保存始终扫描并同步全部绑定。
        let metadata_only = matches!(&request.change,
            Change::DeleteTemplate { .. } | Change::RestoreBackup { .. });
        let (profile_hash, ast, inventory) = if metadata_only {
            (String::new(), AstResult::default(), Inventory { configs: Vec::new(), warnings: Vec::new() })
        } else {
            let (hash, ast) = self.ast()?;
            let inventory = discovery::inventory(&self.paths, &ast, &state);
            (hash, ast, inventory)
        };
        let plan = planner::prepare(&self.paths, state, &inventory, &ast, &profile_hash, request, backup.as_ref())?;
        self.validate_plan_paths(&plan)?;
        if let Some(backup) = backup.as_ref().filter(|backup| backup.format_version == 2) {
            for change in backup.files.iter().filter(|change| change.before.is_none() && change.after.is_some()) {
                let expected = self.store.created_identity(&backup.id, &change.path)?;
                let captured = plan.files.iter().find(|file| file.path == change.path)
                    .and_then(|file| file.before_identity.as_ref());
                // 与实际准备删除的快照身份比较，避免校验与捕获之间接管同内容的新文件。
                if captured != Some(&expected) {
                    return Err("新建文件已被替换，禁止通过撤销删除不属于本次操作的文件。".into());
                }
            }
        }
        // 差异生成失败时不保留可提交计划，避免失败请求遗留有效写入入口。
        let preview = self.preview(&plan)?;
        self.preview = Some(plan);
        Ok(preview)
    }

    pub fn update_layout(&mut self, request: ChangeRequest) -> Result<LayoutOutcome> {
        if journal::pending(&self.paths.data)? || self.store.is_legacy() {
            return Err("存在未完成操作，禁止保存布局。".into());
        }
        let current = self.store.load()?;
        if current.revision != request.expected_revision
            || current.layout_revision != request.expected_layout_revision {
            return Err("业务或布局版本已变化，请刷新后重试。".into());
        }
        let inventory = if matches!(&request.change,
            Change::ReorderConfigs { .. } | Change::AssignConfigGroup { .. }) {
            let (_, ast) = self.ast()?;
            discovery::inventory(&self.paths, &ast, &current)
        } else { Inventory { configs: Vec::new(), warnings: Vec::new() } };
        let next = layout::prepare(&current, &inventory, request.change)?;
        self.store.save_layout(&current, &next)?;
        // 返回已提交的小份布局投影，不重新扫描配置和历史正文。
        let (history, history_error) = match self.store.history(&self.paths.data, &next) {
            Ok(history) => (Some(history), None),
            Err(error) => (None, Some(format!(
                "布局已保存，但历史索引暂不可用，恢复入口已暂停；请刷新清单，不要重复保存：{error}"
            ))),
        };
        Ok(LayoutOutcome {
            layout_revision: next.layout_revision, config_order: next.config_order,
            template_order: next.template_order, config_groups: next.config_groups, history, history_error,
        })
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
        if !matches!(plan.format_version, 1 | 2) {
            return Err("不支持此恢复记录版本，禁止写入。".into());
        }
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
        for guard in &plan.guards {
            if !seen.insert(discovery::key(&guard.path)) {
                return Err("操作计划的只读依赖与写入目标重复。".into());
            }
            if guard.path == self.paths.profile || guard.path == self.paths.codex_base { continue; }
            let allowed = [Kind::Codex, Kind::Claude].into_iter().any(|kind| {
                discovery::managed_path(&self.paths, &guard.path, kind)
                    .is_ok_and(|resolved| resolved == guard.path)
            });
            if !allowed { return Err("恢复记录包含范围外的只读依赖。".into()); }
        }
        Ok(())
    }

    pub fn commit(&mut self, id: &str) -> Result<CommitOutcome> {
        uuid::Uuid::parse_str(id).map_err(|_| "操作编号无效。")?;
        if !self.preview.as_ref().is_some_and(|plan| plan.id == id) {
            // 响应丢失后的同编号重试只返回提交凭据，不重复改写配置或增加版本。
            if self.store.current_operation(id)? {
                let saved = self.store.backup(&self.paths.data, id)?;
                if !self.store.committed(&saved)? { return Err("提交凭据不完整，禁止重复操作。".into()); }
                let warnings = if journal::pending(&self.paths.data)? {
                    vec!["操作已提交，仍有恢复日志待清理，请使用恢复入口。".into()]
                } else { Vec::new() };
                return Ok(self.commit_outcome(id, warnings));
            }
            return Err("没有对应的可提交计划；请刷新确认真实状态，勿重复执行未知结果的操作。".into());
        }
        let plan = self.preview.take().ok_or("操作计划已失效。")?;
        self.validate_plan_paths(&plan)?;
        let warning = journal::commit(&self.paths.data, &mut self.store, &plan)?;
        self.ast_cache = None;
        Ok(self.commit_outcome(id, warning.into_iter().collect()))
    }

    fn commit_outcome(&mut self, id: &str, warnings: Vec<String>) -> CommitOutcome {
        // 提交成功与刷新成功分开表达，刷新错误不再伪装成保存失败。
        match self.bootstrap() {
            Ok(snapshot) => CommitOutcome { id: id.into(), snapshot: Some(snapshot), warnings, refresh_error: None },
            Err(error) => CommitOutcome { id: id.into(), snapshot: None, warnings, refresh_error: Some(error) },
        }
    }

    pub fn recover(&mut self) -> Result<Bootstrap> {
        self.preview = None;
        if journal::pending(&self.paths.data)? {
            let plan = journal::pending_plan(&self.paths.data)?;
            self.validate_plan_paths(&plan)?;
            journal::recover(&self.paths.data, &mut self.store)?;
        }
        self.store.migrate_if_ready(&self.paths.data)?;
        self.ast_cache = None;
        self.bootstrap()
    }
}
