use crate::{
    alias_service, compatibility, discovery,
    files::{self, Text}, journal, merge_json, merge_toml,
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

pub fn apply(kind: Kind, config: &str, snippet: &str) -> Result<String> {
    match kind {
        Kind::Claude => merge_json::apply(config, snippet),
        Kind::Codex => merge_toml::apply(config, snippet),
    }
}

fn strip(kind: Kind, config: &str, snippet: &str) -> Result<String> {
    match kind {
        Kind::Claude => merge_json::strip(config, snippet),
        Kind::Codex => merge_toml::strip(config, snippet),
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
        let (notices, guard) = compatibility::inspect_codex(paths, content)?;
        plan.notices.extend(notices);
        if let Some(guard) = guard { add_guard(plan, guard)?; }
    } else {
        plan.notices.push("Claude 的其他设置来源及现有过滤包装器仍参与运行时合并；建议新开会话。".into());
    }
    Ok(())
}

fn replace_binding(plan: &mut ApplyPlan, config_id: &str, selected: Option<&Template>, hash: String) {
    if let Some(selected) = selected {
        let binding = Binding {
            config_id: config_id.into(), template_id: selected.id.clone(),
            applied_content: selected.content.clone(), applied_revision: selected.revision, last_hash: hash,
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
    id: &str, content: &str, template_id: Option<&str>, expected_hash: &str,
) -> Result<()> {
    let entry = config(inventory, id)?;
    if let Some(error) = &entry.error { return Err(error.clone()); }
    let path = discovery::managed_path(paths, Path::new(&entry.path), entry.kind)?;
    let mut change = files::capture(&path, None)?;
    let raw = files::unpack(change.before.as_deref().ok_or("配置源文件不存在。")?)?;
    if files::hash(&raw) != expected_hash {
        return Err("配置在打开编辑器后被外部修改，请重新载入后合并你的改动。".into());
    }
    validate(entry.kind, content)?;
    let old = plan.before_state.bindings.iter().find(|b| b.config_id == id);
    let individual = if let Some(old) = old { strip(entry.kind, content, &old.applied_content)? } else { content.into() };
    let selected = template_id.map(|id| template(&plan.after_state, id, entry.kind).cloned()).transpose()?;
    let output = match &selected {
        Some(t) => apply(entry.kind, &individual, &t.content)?,
        None => individual,
    };
    check_output(paths, plan, entry.kind, &output)?;
    let bytes = Text::decode(&raw, false)?.encode(&output);
    change.after = Some(files::pack(&bytes));
    replace_binding(plan, id, selected.as_ref(), files::hash(&bytes));
    plan.files.push(change);
    plan.label = "保存配置及模板绑定".into();
    plan.notices.push("取消应用只剥离与旧片段匹配的内容，不自动恢复以前被覆盖的值；恢复原值请使用备份。".into());
    plan.notices.push("数组剥离按后端结构子集匹配：匹配的对象条目整体移除，额外独立条目保留；请核对明文差异。".into());
    Ok(())
}

fn save_template(
    paths: &Paths, inventory: &Inventory, plan: &mut ApplyPlan,
    id: Option<String>, name: String, kind: Kind, content: String,
) -> Result<()> {
    if name.trim().is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
        return Err("通用配置名称必须为非空且不含控制字符的短名称。".into());
    }
    let content = content.replace("\r\n", "\n");
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
    // 仅重命名不重新合并所有文件，避免无意义重写和格式变化。
    let content_changed = old.as_ref().is_none_or(|t| t.content != content);
    for binding in bindings {
        if !content_changed { continue; }
        let entry = config(inventory, &binding.config_id)?;
        if let Some(error) = &entry.error { return Err(error.clone()); }
        if entry.hash.as_deref() != Some(binding.last_hash.as_str()) {
            return Err(format!("绑定文件被外部修改、丢失或替换，请先打开并保存后再同步：{}", entry.path));
        }
        let path = discovery::managed_path(paths, Path::new(&entry.path), kind)?;
        let mut change = files::capture(&path, None)?;
        let raw = files::unpack(change.before.as_deref().ok_or("绑定文件不存在。")?)?;
        if files::hash(&raw) != binding.last_hash {
            return Err("准备同步时绑定文件再次发生外部改动，请重新载入。".into());
        }
        let original = Text::decode(&raw, false)?;
        let individual = strip(kind, &original.value, &binding.applied_content)?;
        let output = apply(kind, &individual, &content)?;
        check_output(paths, plan, kind, &output)?;
        let bytes = original.encode(&output);
        change.after = Some(files::pack(&bytes));
        replace_binding(plan, &binding.config_id, Some(&next), files::hash(&bytes));
        plan.files.push(change);
    }
    plan.label = format!("保存通用配置「{}」并同步绑定文件", next.name);
    plan.notices.push("更新片段会先剥离旧片段，再应用新版；数组中的匹配对象条目按结构子集匹配并整体移除。".into());
    if content.trim().is_empty() {
        plan.notices.push("此模板已显式清空；保留引用但不自动重新提取，旧匹配片段将从绑定文件剥离。".into());
    }
    Ok(())
}

fn create_alias(
    paths: &Paths, ast: &AstResult, profile: &str, inventory: &Inventory, plan: &mut ApplyPlan,
    kind: Kind, launcher: &str, name: &str, content: &str, template_id: Option<&str>,
) -> Result<()> {
    validate(kind, content)?;
    let selected = template_id.map(|id| template(&plan.after_state, id, kind).cloned()).transpose()?;
    let output = match &selected { Some(t) => apply(kind, content, &t.content)?, None => content.into() };
    check_output(paths, plan, kind, &output)?;
    let id = alias_service::create(paths, plan, ast, profile, kind, launcher, name, &output)?;
    if inventory.configs.iter().any(|c| c.id == id) { return Err("配置目标已在管理清单中。".into()); }
    replace_binding(plan, &id, selected.as_ref(), files::hash(output.as_bytes()));
    plan.label = "新建配置文件并注册别名".into();
    Ok(())
}

fn restore(paths: &Paths, plan: &mut ApplyPlan, id: &str) -> Result<()> {
    let backup = journal::backup(&paths.data, id)?;
    if serde_json::to_value(&backup.after_state).map_err(|e| e.to_string())?
        != serde_json::to_value(&plan.before_state).map_err(|e| e.to_string())? {
        return Err("只能撤销当前状态对应的最近一次操作，不能用旧备份覆盖后续修改。".into());
    }
    let mut files = Vec::new();
    for old in backup.files {
        let bytes = old.before.as_deref().map(files::unpack).transpose()?;
        let change = files::capture(&old.path, bytes)?;
        if change.before != old.after {
            return Err(format!("备份后的文件又被修改，禁止自动覆盖：{}", old.path.display()));
        }
        files.push(change);
    }
    plan.files = files;
    plan.after_state = backup.before_state;
    plan.after_state.revision = plan.before_state.revision + 1;
    plan.label = format!("恢复：{}", backup.label);
    plan.notices.push("将撤销对应操作的配置、profile 和绑定状态；已有终端不会被重载。".into());
    Ok(())
}

pub fn prepare(
    paths: &Paths, state: PanelState, inventory: &Inventory, ast: &AstResult,
    profile_hash: &str, request: ChangeRequest,
) -> Result<ApplyPlan> {
    if request.expected_revision != state.revision { return Err("界面状态已过期，请先刷新。".into()); }
    let (profile, bytes, identity) = crate::profile_editor::read(&paths.profile)?;
    if files::hash(&bytes) != profile_hash {
        return Err("准备过程中 profile 已变化，请重新载入。".into());
    }
    let encoded = files::pack(&bytes);
    let mut plan = ApplyPlan {
        id: uuid::Uuid::new_v4().to_string(), label: String::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        before_state: state.clone(),
        after_state: PanelState { revision: state.revision + 1, ..state },
        files: vec![FileChange {
            path: paths.profile.clone(), before: Some(encoded.clone()), after: Some(encoded),
            before_identity: Some(identity),
        }],
        notices: Vec::new(),
    };
    match request.change {
        Change::SaveTemplate { id, name, kind, content } =>
            save_template(paths, inventory, &mut plan, id, name, kind, content)?,
        Change::SaveConfig { id, content, template_id, expected_hash } =>
            save_config(paths, inventory, &mut plan, &id, &content, template_id.as_deref(), &expected_hash)?,
        Change::CreateAlias { kind, launcher, name, content, template_id } =>
            create_alias(paths, ast, &profile.value, inventory, &mut plan, kind, &launcher, &name,
                &content, template_id.as_deref())?,
        Change::DeleteTemplate { id } => {
            let target = plan.after_state.templates.iter().find(|t| t.id == id).ok_or("模板不存在。")?;
            plan.label = format!("删除通用配置「{}」", target.name);
            if plan.after_state.bindings.iter().any(|b| b.template_id == id) {
                return Err("该模板仍被引用，请先在所有关联文件中解绑或切换模板。".into());
            }
            plan.after_state.templates.retain(|t| t.id != id);
        }
        Change::RemoveAlias { name } => {
            let entry = inventory.configs.iter().find(|c| c.aliases.contains(&name)).ok_or("别名不存在。")?;
            alias_service::remove_alias(paths, &mut plan, ast, &profile.value, entry, &name)?;
            plan.label = format!("移除别名入口 {name}");
        }
        Change::DeleteConfig { id, expected_hash } => {
            alias_service::delete_config(paths, &mut plan, ast, &profile.value,
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
        Change::RestoreBackup { id } => restore(paths, &mut plan, &id)?,
    }
    plan.notices.sort();
    plan.notices.dedup();
    let mut comparable = plan.after_state.clone();
    comparable.revision = plan.before_state.revision;
    let same_state = serde_json::to_string(&comparable).map_err(|e| e.to_string())?
        == serde_json::to_string(&plan.before_state).map_err(|e| e.to_string())?;
    if same_state && plan.files.iter().all(|f| f.before == f.after) {
        return Err("没有需要保存的变化。".into());
    }
    Ok(plan)
}
