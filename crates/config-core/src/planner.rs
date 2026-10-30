use crate::{
    alias_service, compatibility, discovery, rename_service, state,
    files::{self, Text}, merge_json, merge_toml,
    model::*,
};
use std::path::Path;

pub fn validate(kind: Kind, content: &str) -> Result<()> {
    if content.len() > 4 * 1024 * 1024 { return Err("单份配置不能超过 4 MiB。".into()); }
    match kind {
        Kind::Claude => { merge_json::parse(content)?; }
        Kind::Codex => { merge_toml::parse(content)?; }
    }
    Ok(())
}

// 解绑直接保留原文；预览、保存及同步统一按绑定优先级处理三方合并。
pub fn merge_config(
    kind: Kind, content: &str, binding: Option<&Binding>, selected_content: Option<&str>,
    priority: MergePriority,
) -> Result<(String, Vec<Vec<String>>)> {
    let Some(selected) = selected_content else { return Ok((content.to_owned(), Vec::new())); };
    // 实际语法校验由下方合并器完成，避免每份绑定重复解析同一原文。
    if content.len() > 4 * 1024 * 1024 { return Err("单份配置不能超过 4 MiB。".into()); }
    let previous = binding.map(|binding| binding.applied_content.as_str());
    if previous.is_some_and(|old| old.len() > 4 * 1024 * 1024) || selected.len() > 4 * 1024 * 1024 {
        return Err("单份通用配置不能超过 4 MiB。".into());
    }
    let overrides = binding.map(|binding| binding.overrides.as_slice()).unwrap_or(&[]);
    match kind {
        Kind::Claude => merge_json::sync(content, previous, selected, overrides, priority),
        Kind::Codex => merge_toml::sync(content, previous, selected, overrides, priority),
    }
}

fn config<'a>(inventory: &'a Inventory, id: &str) -> Result<&'a ConfigEntry> {
    inventory.configs.iter().find(|c| c.id == id).ok_or_else(|| "配置不在当前受管清单中。".into())
}

fn template<'a>(state: &'a PanelState, id: &str, kind: Kind) -> Result<&'a Template> {
    let template = state.templates.iter().find(|t| t.id == id).ok_or("通用配置不存在。")?;
    if template.kind != kind { return Err("不能跨 Codex / Claude 应用通用配置。".into()); }
    Ok(template)
}

fn add_guard(plan: &mut ApplyPlan, guard: FileChange) -> Result<()> {
    if let Some(existing) = plan.files.iter().find(|f| f.path == guard.path) {
        if existing.before != guard.before || existing.before_identity != guard.before_identity {
            return Err("准备过程中基础文件发生变化，请重新保存。".into());
        }
    } else {
        plan.files.push(guard);
    }
    Ok(())
}

fn check_output(paths: &Paths, plan: &mut ApplyPlan, kind: Kind, content: &str) -> Result<()> {
    validate(kind, content)?;
    if kind == Kind::Codex {
        if let Some(guard) = compatibility::inspect_codex(paths, content)? { add_guard(plan, guard)?; }
    }
    Ok(())
}

fn replace_binding(
    plan: &mut ApplyPlan, config_id: &str, selected: Option<&Template>, hash: String,
    overrides: Vec<Vec<String>>, merge_priority: MergePriority,
) {
    if let Some(selected) = selected {
        let binding = Binding {
            config_id: config_id.into(), template_id: selected.id.clone(),
            applied_content: selected.content.clone(), applied_revision: selected.revision, last_hash: hash,
            overrides, merge_priority,
        };
        if plan.after_state.bindings.iter().any(|b| b.config_id == config_id) {
            plan.after_state.bindings = plan.after_state.bindings.iter().map(|b| {
                if b.config_id == config_id { binding.clone() } else { b.clone() }
            }).collect();
        } else {
            plan.after_state.bindings.push(binding);
        }
    } else {
        plan.after_state.bindings.retain(|b| b.config_id != config_id);
    }
}

fn save_config(
    paths: &Paths, inventory: &Inventory, plan: &mut ApplyPlan,
    id: &str, content: &str, template_id: Option<&str>, merge_priority: MergePriority, expected_hash: &str,
) -> Result<()> {
    let entry = config(inventory, id)?;
    if let Some(error) = &entry.error { return Err(error.clone()); }
    let path = discovery::managed_path(paths, Path::new(&entry.path), entry.kind)?;
    let mut change = files::capture(&path, None)?;
    let raw = files::unpack(change.before.as_deref().ok_or("配置源文件不存在。")?)?;
    if files::hash(&raw) != expected_hash {
        return Err("配置在打开编辑器后被外部修改，请重新载入后合并你的改动。".into());
    }
    let old = plan.before_state.bindings.iter().find(|b| b.config_id == id);
    let selected = template_id.map(|id| template(&plan.after_state, id, entry.kind).cloned()).transpose()?;
    let (output, overrides) = merge_config(entry.kind, content, old,
        selected.as_ref().map(|t| t.content.as_str()), merge_priority)?;
    let original = Text::decode(&raw, false)?;
    // 编辑器会规范化换行；未修改正文时复用完整字节，解绑只改变面板绑定状态。
    let unchanged = output.replace("\r\n", "\n") == original.value.replace("\r\n", "\n");
    if !unchanged || selected.is_some() { check_output(paths, plan, entry.kind, &output)?; }
    let bytes = if unchanged { raw } else { original.encode(&output) };
    change.after = Some(files::pack(&bytes));
    replace_binding(plan, id, selected.as_ref(), files::hash(&bytes), overrides, merge_priority);
    plan.files.push(change);
    plan.label = "保存配置及模板绑定".into();
    Ok(())
}

fn save_template(
    paths: &Paths, inventory: &Inventory, plan: &mut ApplyPlan,
    id: Option<String>, name: String, kind: Kind, content: String,
) -> Result<()> {
    // 名称长度按字符而非 UTF-8 字节计数，中文名称与前端限制保持一致。
    if name.trim().is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err("通用配置名称必须为非空且不含控制字符的短名称。".into());
    }
    let content = content.replace("\r\n", "\n");
    if content.len() > 4 * 1024 * 1024 { return Err("单份通用配置不能超过 4 MiB。".into()); }
    if !content.trim().is_empty() { validate(kind, &content)?; }
    let old = id.as_deref().map(|id| template(&plan.before_state, id, kind).cloned()).transpose()?;
    let template_id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if plan.before_state.templates.iter().any(|t| t.kind == kind && t.id != template_id && t.name == name.trim()) {
        return Err("同类型通用配置名称已经存在。".into());
    }
    let next = Template {
        id: template_id.clone(), name: name.trim().into(), kind, content: content.clone(),
        revision: old.as_ref().map_or(1, |t| t.revision + u64::from(t.content != content)),
    };
    if old.is_some() {
        plan.after_state.templates = plan.after_state.templates.iter().map(|t| {
            if t.id == template_id { next.clone() } else { t.clone() }
        }).collect();
    } else {
        plan.after_state.templates.push(next.clone());
    }
    let bindings: Vec<Binding> = plan.before_state.bindings.iter()
        .filter(|b| b.template_id == template_id).cloned().collect();
    let mut updates = std::collections::HashMap::new();
    for binding in bindings {
        // 每次模板保存都同步全部绑定，不再存在模板已更新但引用仍停留旧版的保存入口。
        // 通用优先即使模板正文未变也重新核对文件，确保外部修改的冲突值服从所选策略。
        if binding.applied_content == content && binding.merge_priority == MergePriority::Current {
            // 内容回退至已应用版本时，只更新绑定版本号，避免误报待同步或无意义重写文件。
            if binding.applied_revision != next.revision {
                updates.insert(binding.config_id.clone(),
                    Binding { applied_revision: next.revision, ..binding });
            }
            continue;
        }
        let entry = config(inventory, &binding.config_id)?;
        if let Some(error) = &entry.error { return Err(error.clone()); }
        let path = discovery::managed_path(paths, Path::new(&entry.path), kind)?;
        let mut change = files::capture(&path, None)?;
        let raw = files::unpack(change.before.as_deref().ok_or("绑定文件不存在。")?)?;
        // 手动编辑不是同步错误；只阻止本轮扫描到捕获之间的新改动，提交阶段继续校验守卫。
        if entry.hash.as_deref() != Some(files::hash(&raw).as_str()) {
            return Err("准备同步时绑定文件再次发生外部改动，请重新载入。".into());
        }
        let original = Text::decode(&raw, false)?;
        let (output, overrides) = merge_config(kind, &original.value, Some(&binding), Some(&content),
            binding.merge_priority)?;
        check_output(paths, plan, kind, &output)?;
        let bytes = if output == original.value { raw } else { original.encode(&output) };
        change.after = Some(files::pack(&bytes));
        updates.insert(binding.config_id.clone(), Binding {
            applied_content: content.clone(), applied_revision: next.revision,
            last_hash: files::hash(&bytes), overrides, ..binding
        });
        plan.files.push(change);
    }
    // 批量生成一次新绑定列表，避免每同步一份文件都克隆全部绑定正文。
    plan.after_state.bindings = plan.after_state.bindings.iter().map(|binding| {
        updates.remove(&binding.config_id).unwrap_or_else(|| binding.clone())
    }).collect();
    plan.label = format!("保存通用配置「{}」并同步绑定文件", next.name);
    Ok(())
}

fn create_alias(
    paths: &Paths, ast: &AstResult, profile: &str, inventory: &Inventory, plan: &mut ApplyPlan,
    kind: Kind, launcher: &str, name: &str, content: &str, template_id: Option<&str>,
    merge_priority: MergePriority,
) -> Result<()> {
    validate(kind, content)?;
    let selected = template_id.map(|id| template(&plan.after_state, id, kind).cloned()).transpose()?;
    let (output, overrides) = merge_config(kind, content, None,
        selected.as_ref().map(|template| template.content.as_str()), merge_priority)?;
    check_output(paths, plan, kind, &output)?;
    let id = alias_service::create(paths, plan, ast, profile, kind, launcher, name, &output)?;
    if inventory.configs.iter().any(|c| c.id == id) { return Err("配置目标已在管理清单中。".into()); }
    replace_binding(plan, &id, selected.as_ref(), files::hash(output.as_bytes()), overrides, merge_priority);
    plan.identity_changes.push(ConfigIdentityChange { before: None, after: Some(id) });
    plan.label = "新建配置文件并注册别名".into();
    Ok(())
}

fn restore(plan: &mut ApplyPlan, backup: &ApplyPlan) -> Result<()> {
    if backup.layout_snapshot && (plan.before_state.layout_revision != backup.after_state.layout_revision
        || !state::same_layout(&plan.before_state, &backup.after_state)?) {
        return Err("此操作含旧版全量布局快照，布局已有后续修改，禁止整份覆盖。".into());
    }
    let matches = if backup.format_version == 1 {
        serde_json::to_value(state::legacy(&plan.before_state)).map_err(|e| e.to_string())?
            == serde_json::to_value(&backup.after_state).map_err(|e| e.to_string())?
    } else { state::same_business(&backup.after_state, &plan.before_state)? };
    if !matches {
        return Err("只能撤销当前状态对应的最近一次操作，不能用旧备份覆盖后续修改。".into());
    }
    let mut files = Vec::new();
    for guard in &backup.guards { crate::journal::verify_guard(guard)?; }
    // 撤销按发布顺序的逆序执行：先恢复旧配置，再切回入口，最后删除新配置。
    for old in backup.files.iter().rev() {
        let bytes = old.before.as_deref().map(files::unpack).transpose()?;
        let change = files::capture(&old.path, bytes)?;
        if change.before != old.after {
            return Err(format!("备份后的文件又被修改，禁止自动覆盖：{}", old.path.display()));
        }
        files.push(change);
    }
    plan.files = files;
    plan.guards = backup.guards.clone();
    let layout = if backup.format_version == 1 || backup.layout_snapshot {
        let mut layout = state::layout(&backup.before_state);
        if backup.format_version == 1 {
            layout.template_order = backup.before_state.templates.iter().map(|template| template.id.clone()).collect();
        }
        layout
    } else { state::restore_layout(&plan.before_state, backup) };
    plan.after_state = state::compose(&backup.before_state, &layout);
    plan.after_state.revision = state::next_revision(plan.before_state.revision)?;
    plan.identity_changes = backup.identity_changes.iter().rev().map(|change| ConfigIdentityChange {
        before: change.after.clone(), after: change.before.clone(),
    }).collect();
    plan.layout_snapshot = backup.format_version == 1 || backup.layout_snapshot;
    plan.label = format!("恢复：{}", backup.label);
    plan.notices.push("将撤销对应操作的配置、profile 和绑定状态；已有终端不会被重载。".into());
    plan.notices.push(if plan.layout_snapshot {
        "旧版全量布局按原恢复规则处理；此操作只有在布局未再修改时才能再次撤销。"
    } else {
        "保留后续布局调整；恢复已删除配置时，仅重新加入仍存在的原分组，否则归入未分组。"
    }.into());
    Ok(())
}

pub fn prepare(
    paths: &Paths, state: PanelState, inventory: &Inventory, ast: &AstResult,
    profile_hash: &str, request: ChangeRequest, backup: Option<&ApplyPlan>,
) -> Result<ApplyPlan> {
    if request.expected_revision != state.revision { return Err("界面状态已过期，请先刷新。".into()); }
    if request.expected_layout_revision != state.layout_revision {
        return Err("界面布局已过期，请先刷新。".into());
    }
    // 模板保存必须检查全部绑定；删除及恢复仍沿用独立元数据入口。
    let metadata_only = matches!(&request.change,
        Change::DeleteTemplate { .. } | Change::RestoreBackup { .. });
    let (profile, guards) = if metadata_only {
        (String::new(), Vec::new())
    } else {
        let (profile, bytes, identity) = crate::profile_editor::read(&paths.profile)?;
        if files::hash(&bytes) != profile_hash {
            return Err("准备过程中 profile 已变化，请重新载入。".into());
        }
        let encoded = files::pack(&bytes);
        (profile.value, vec![FileChange {
            path: paths.profile.clone(), before: Some(encoded.clone()), after: Some(encoded),
            before_identity: Some(identity),
        }])
    };
    let mut plan = ApplyPlan {
        format_version: 2,
        id: uuid::Uuid::new_v4().to_string(), label: String::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        before_state: state.clone(),
        after_state: PanelState { revision: state::next_revision(state.revision)?, ..state },
        files: guards,
        guards: Vec::new(),
        identity_changes: Vec::new(),
        layout_snapshot: false,
        notices: Vec::new(),
    };
    match request.change {
        Change::SaveTemplate { id, name, kind, content } =>
            save_template(paths, inventory, &mut plan, id, name, kind, content)?,
        Change::SaveConfig { id, name, content, template_id, merge_priority, expected_hash } => {
            save_config(paths, inventory, &mut plan, &id, &content, template_id.as_deref(), merge_priority, &expected_hash)?;
            // 在同一计划内迁移已生成的配置结果，保证草稿、命令和模板绑定一起提交或恢复。
            if let Some(name) = name {
                rename_service::rename(paths, &mut plan, ast, &profile,
                    inventory, config(inventory, &id)?, &name)?;
            }
        }
        Change::CreateAlias { kind, launcher, name, content, template_id, merge_priority } =>
            create_alias(paths, ast, &profile, inventory, &mut plan, kind, &launcher, &name,
                &content, template_id.as_deref(), merge_priority)?,
        Change::DeleteTemplate { id } => {
            let target = plan.after_state.templates.iter().find(|t| t.id == id).ok_or("模板不存在。")?;
            plan.label = format!("删除通用配置「{}」", target.name);
            let count = plan.before_state.bindings.iter().filter(|b| b.template_id == id).count();
            // 一次提交移除模板及全部引用，包括清单外的历史失效绑定；不误删别名源文件。
            plan.after_state.templates = plan.after_state.templates.iter()
                .filter(|t| t.id != id).cloned().collect();
            plan.after_state.bindings = plan.after_state.bindings.iter()
                .filter(|b| b.template_id != id).cloned().collect();
            plan.notices.push(format!("从通用配置库删除模板，并清理 {count} 份绑定（含失效引用）；别名源文件及现有内容保持原样，不再同步此模板。备份仍可用于恢复。"));
        }
        Change::RemoveAlias { name } => {
            let entry = inventory.configs.iter().find(|c| c.aliases.contains(&name)).ok_or("别名不存在。")?;
            alias_service::remove_alias(paths, &mut plan, ast, &profile, entry, &name)?;
            plan.label = format!("移除别名入口 {name}");
        }
        Change::SetCodexLauncher { id, launcher, expected_hash } => {
            crate::launcher_service::set_launcher(paths, &mut plan, ast, &profile,
                config(inventory, &id)?, &launcher, &expected_hash)?;
        }
        Change::DeleteConfig { id, expected_hash } => {
            alias_service::delete_config(paths, &mut plan, ast, &profile,
                config(inventory, &id)?, &expected_hash)?;
            plan.label = "真实删除配置文件及全部关联别名".into();
        }
        Change::ImportConfig { path, kind } => {
            let resolved = discovery::managed_path(paths, Path::new(&path), kind)?;
            let id = discovery::key(&resolved);
            if inventory.configs.iter().any(|c| c.id == id) { return Err("此文件已在管理清单中。".into()); }
            let change = files::capture(&resolved, None)?;
            let original = change.before.clone().ok_or("导入文件不存在。")?;
            validate(kind, &Text::decode(&files::unpack(&original)?, false)?.value)?;
            plan.files.push(FileChange { after: Some(original), ..change });
            plan.after_state.imports.push(ImportedConfig { path: resolved.to_string_lossy().into(), kind });
            plan.label = "手动导入已有配置（不自动绑定模板）".into();
        }
        Change::RestoreBackup { id } => {
            let backup = backup.filter(|backup| backup.id == id).ok_or("恢复计划缺少已校验的备份。")?;
            restore(&mut plan, backup)?;
        }
        Change::ReorderTemplates { .. } | Change::ReorderConfigs { .. }
        | Change::SaveConfigGroup { .. } | Change::DeleteConfigGroup { .. }
        | Change::AssignConfigGroup { .. } => return Err("布局操作必须使用轻量保存入口。".into()),
    }
    plan.after_state = state::finish_layout(&plan.before_state, &plan.after_state)?;
    plan.notices.sort();
    plan.notices.dedup();
    let mut comparable = plan.after_state.clone();
    comparable.revision = plan.before_state.revision;
    let same_state = serde_json::to_string(&comparable).map_err(|e| e.to_string())?
        == serde_json::to_string(&plan.before_state).map_err(|e| e.to_string())?;
    if same_state && plan.files.iter().all(|f| f.before == f.after) {
        return Err("没有需要保存的变化。".into());
    }
    compact_guards(plan)
}

fn compact_guards(mut plan: ApplyPlan) -> Result<ApplyPlan> {
    // 计划生成后才压缩只读守卫，避免破坏别名编辑所需的 profile 原始上下文。
    let mut writes = Vec::new();
    for change in plan.files {
        if change.before == change.after {
            plan.guards.push(FileGuard {
                path: change.path,
                hash: change.before.as_deref().map(files::unpack).transpose()?.map(|bytes| files::hash(&bytes)),
                identity: change.before_identity,
            });
        } else { writes.push(change); }
    }
    plan.files = writes;
    Ok(plan)
}
