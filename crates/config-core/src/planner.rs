use crate::{
    alias_service, compatibility, discovery, rename_service,
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

// 草稿预览与实际保存共用剥离、合并逻辑；切换模板不能把旧片段遗留在预览中。
pub fn merge_config(
    kind: Kind, content: &str, applied_content: Option<&str>, selected_content: Option<&str>,
) -> Result<String> {
    validate(kind, content)?;
    if applied_content.is_some_and(|old| old.len() > 4 * 1024 * 1024)
        || selected_content.is_some_and(|selected| selected.len() > 4 * 1024 * 1024) {
        return Err("单份通用配置不能超过 4 MiB。".into());
    }
    let individual = applied_content.map(|old| strip(kind, content, old))
        .transpose()?.unwrap_or_else(|| content.to_owned());
    match selected_content {
        Some(selected) => {
            if !selected.trim().is_empty() { validate(kind, selected)?; }
            apply(kind, &individual, selected)
        }
        None => Ok(individual),
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
    let old = plan.before_state.bindings.iter().find(|b| b.config_id == id);
    let selected = template_id.map(|id| template(&plan.after_state, id, entry.kind).cloned()).transpose()?;
    let output = merge_config(entry.kind, content, old.map(|b| b.applied_content.as_str()),
        selected.as_ref().map(|t| t.content.as_str()))?;
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
    id: Option<String>, name: String, kind: Kind, content: String, sync_bindings: bool,
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
    for binding in bindings {
        // 按每份绑定的实际版本判断同步，支持模板先独立保存、稍后再同步。
        if !sync_bindings { continue; }
        if binding.applied_content == content {
            // 内容回退至已应用版本时，只更新绑定版本号，避免误报待同步或无意义重写文件。
            if binding.applied_revision != next.revision {
                replace_binding(plan, &binding.config_id, Some(&next), binding.last_hash.clone());
            }
            continue;
        }
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
    plan.label = if sync_bindings {
        format!("保存通用配置「{}」并同步绑定文件", next.name)
    } else {
        format!("仅保存通用配置「{}」", next.name)
    };
    if sync_bindings {
        plan.notices.push("更新片段会先剥离旧片段，再应用新版；数组中的匹配对象条目按结构子集匹配并整体移除。".into());
    } else {
        plan.notices.push("仅保存模板内容，引用文件保持原样；每份绑定仍保留实际已应用的旧片段，稍后可继续同步。".into());
    }
    if sync_bindings && content.trim().is_empty() {
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
    // 模板库独立保存与删除只改数据库，不让失效文件或不可读 profile 锁死修复入口。
    let metadata_only = matches!(&request.change,
        Change::DeleteTemplate { .. } | Change::SaveTemplate { sync_bindings: false, .. });
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
        id: uuid::Uuid::new_v4().to_string(), label: String::new(),
        created_at: chrono::Utc::now().to_rfc3339(),
        before_state: state.clone(),
        after_state: PanelState { revision: state.revision + 1, ..state },
        files: guards,
        notices: Vec::new(),
    };
    match request.change {
        Change::SaveTemplate { id, name, kind, content, sync_bindings } =>
            save_template(paths, inventory, &mut plan, id, name, kind, content, sync_bindings)?,
        Change::SaveConfig { id, name, content, template_id, expected_hash } => {
            save_config(paths, inventory, &mut plan, &id, &content, template_id.as_deref(), &expected_hash)?;
            // 在同一计划内迁移已生成的配置结果，保证草稿、命令和模板绑定一起提交或恢复。
            if let Some(name) = name {
                rename_service::rename(paths, &mut plan, ast, &profile,
                    inventory, config(inventory, &id)?, &name)?;
            }
        }
        Change::CreateAlias { kind, launcher, name, content, template_id } =>
            create_alias(paths, ast, &profile, inventory, &mut plan, kind, &launcher, &name,
                &content, template_id.as_deref())?,
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
        Change::RestoreBackup { id } => restore(paths, &mut plan, &id)?,
        // 排序仅调整展示元数据，不触碰任何受管文件，也不改变绑定关系。
        Change::ReorderTemplates { kind, order } => {
            // 依据重排前的既有列表校验，保证传入顺序是当前集合的完整重排（快速失败，不做静默修补）。
            let current: Vec<String> = plan.before_state.templates.iter()
                .filter(|t| t.kind == kind).map(|t| t.id.clone()).collect();
            let mut sorted = order.clone();
            sorted.sort();
            let mut expected = current.clone();
            expected.sort();
            if sorted != expected {
                return Err("通用配置列表已变化，请刷新后重新排序。".into());
            }
            let rank: std::collections::HashMap<&str, usize> = order.iter()
                .enumerate().map(|(index, id)| (id.as_str(), index)).collect();
            let key = |t: &Template| rank.get(t.id.as_str()).copied().unwrap_or(usize::MAX);
            let mut next: Vec<Template> = plan.after_state.templates.iter().filter(|t| t.kind == kind)
                .cloned().collect();
            next.sort_by_key(&key);
            // 只替换同类型条目的槽位，其他产品页签中的模板相对顺序保持原状。
            let position: Vec<usize> = plan.after_state.templates.iter().enumerate()
                .filter(|(_, t)| t.kind == kind).map(|(index, _)| index).collect();
            for (slot, template) in position.into_iter().zip(next) {
                plan.after_state.templates[slot] = template;
            }
            let changed = serde_json::to_string(&plan.after_state.templates).map_err(|e| e.to_string())?
                != serde_json::to_string(&plan.before_state.templates).map_err(|e| e.to_string())?;
            if !changed { return Err("没有需要保存的变化。".into()); }
            plan.label = "调整通用配置显示顺序".into();
            plan.notices.push("仅调整侧栏显示顺序，不影响任何已保存内容或文件绑定。".into());
        }
        Change::ReorderConfigs { order } => {
            if order.is_empty() {
                return Err("显示顺序不能为空。".into());
            }
            // 前端只提交当前产品页签的完整 id 集合（与 ReorderTemplates 的 kind 过滤语义一致）。
            // 校验：order 中每个 id 都在清单里且同属一种类型，且恰好覆盖该类型的全部文件。
            let mut kind_of: Option<Kind> = None;
            for id in &order {
                let entry = inventory.configs.iter().find(|c| &c.id == id)
                    .ok_or("配置文件清单已变化，请刷新后重新排序。")?;
                match kind_of {
                    None => kind_of = Some(entry.kind),
                    Some(k) if k != entry.kind => return Err("排序顺序混入了不同应用类型的文件。".into()),
                    _ => {}
                }
            }
            // 不使用 .into()：错误类型 E 由 ? 自动从 &str 转换为 Result 的 String，避免类型参数歧义。
            let kind = kind_of.ok_or("显示顺序不能为空。")?;
            let mut sorted = order.clone();
            sorted.sort();
            let mut expected: Vec<String> = inventory.configs.iter()
                .filter(|c| c.kind == kind).map(|c| c.id.clone()).collect();
            expected.sort();
            if sorted != expected {
                return Err("配置文件清单已变化，请刷新后重新排序。".into());
            }
            // 合并：本次类型使用最新顺序；其他类型的既有顺序原样保留在队尾，
            // 未登记过的新文件按清单默认顺序追加，保证全局 configOrder 始终完整。
            let mut merged = order.clone();
            for id in &plan.before_state.config_order {
                if !merged.iter().any(|m| m == id)
                    && inventory.configs.iter().any(|c| &c.id == id && c.kind != kind) {
                    merged.push(id.clone());
                }
            }
            for entry in &inventory.configs {
                if !merged.iter().any(|m| m == &entry.id) {
                    merged.push(entry.id.clone());
                }
            }
            plan.after_state.config_order = merged;
            plan.label = "调整别名的配置文件显示顺序".into();
            plan.notices.push("仅调整卡片显示顺序，不影响文件本身及模板绑定。".into());
        }
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
