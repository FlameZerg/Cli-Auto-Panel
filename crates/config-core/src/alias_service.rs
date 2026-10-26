use crate::{
    config_groups, discovery, files::{self, Text},
    model::{Alias, ApplyPlan, AstResult, ConfigEntry, ImportedConfig, Kind, Paths, Result},
    profile_editor,
};
use std::path::Path;

pub fn plan_profile(
    paths: &Paths, plan: &mut ApplyPlan, updated: &str,
) -> Result<()> {
    let change = plan.files.iter_mut().find(|f| f.path == paths.profile)
        .ok_or("操作计划缺少 profile 基线。")?;
    let bytes = change.before.as_deref().ok_or("profile 原始快照缺失。")?;
    let text = Text::decode(&files::unpack(bytes)?, true)?;
    change.after = Some(files::pack(&text.encode_exact(updated)));
    plan.notices.push("别名注册的变更对新开的 PowerShell 终端生效；不自动重载已有终端。".into());
    Ok(())
}

pub fn create(
    paths: &Paths, plan: &mut ApplyPlan, ast: &AstResult, profile_text: &str,
    kind: Kind, launcher: &str, name: &str, content: &str,
) -> Result<String> {
    profile_editor::validate_name(name)?;
    if name.eq_ignore_ascii_case("auto") {
        return Err("auto 名称属于现有启动器管理入口，不能覆盖。".into());
    }
    let (root, filename) = match kind {
        Kind::Codex => (&paths.codex_root, format!("config.{name}.toml")),
        Kind::Claude => (&paths.claude_root, format!("settings.{name}.json")),
    };
    let logical_path = root.join(filename);
    let path = discovery::managed_path(paths, &logical_path, kind)?;
    if files::read(&path)?.is_some() {
        return Err("目标配置文件已经存在，不能通过新建入口覆盖。".into());
    }
    let command_names = match (kind, launcher) {
        (Kind::Codex, "codex") => vec![format!("codex-{name}")],
        (Kind::Codex, "codexnew") => vec![format!("codexnew-{name}")],
        (Kind::Codex, "both") => vec![format!("codex-{name}"), format!("codexnew-{name}")],
        (Kind::Claude, "claude") => vec![format!("claude-{name}")],
        _ => return Err("启动版本与应用类型不匹配。".into()),
    };
    let registrations: Vec<_> = command_names.iter().map(|name| {
        (name.clone(), logical_path.to_string_lossy().to_string(), kind)
    }).collect();
    let updated = profile_editor::append(profile_text, ast, &registrations)?;
    // 先发布配置，再注册入口，避免正常提交期间出现指向空文件的新命令。
    plan.files.push(files::capture(&path, Some(content.as_bytes().to_vec()))?);
    plan_profile(paths, plan, &updated)?;
    plan.files.sort_by_key(|f| f.path == paths.profile);
    // 新建内容来自完整草稿及模板合并，不再暗示复制过程会过滤凭据。
    plan.notices.push(format!("将新建并注册：{}。配置内容以草稿及所选通用配置的合并结果为准。", command_names.join("、")));
    Ok(discovery::key(&path))
}

// 删除和重命名共用引用识别，确保同一文件的全部入口被一致处理。
pub(crate) fn references(paths: &Paths, ast: &AstResult, entry: &ConfigEntry) -> Result<Vec<Alias>> {
    let mut aliases = Vec::new();
    for alias in &ast.aliases {
        let path = discovery::managed_path(paths, Path::new(&alias.path), alias.kind)?;
        if discovery::key(&path) == entry.id { aliases.push(alias.clone()); }
    }
    Ok(aliases)
}

pub fn delete_config(
    paths: &Paths, plan: &mut ApplyPlan, ast: &AstResult, profile_text: &str,
    entry: &ConfigEntry, expected_hash: &str,
) -> Result<()> {
    if entry.error.is_some() {
        return Err("配置文件有路径、身份或读取错误，不能执行真实删除。".into());
    }
    let path = discovery::managed_path(paths, Path::new(&entry.path), entry.kind)?;
    let change = files::capture(&path, None)?;
    let before = change.before.as_deref().ok_or("配置文件已经不存在。")?;
    if files::hash(&files::unpack(before)?) != expected_hash {
        return Err("配置已被外部修改，先重新载入再决定是否删除。".into());
    }
    let aliases = references(paths, ast, entry)?;
    // 即使是手工导入文件，也不在存在未知动态引用时贸然删除。
    profile_editor::editable(ast, profile_text)?;
    let updated = profile_editor::remove(profile_text, ast, &aliases)?;
    plan_profile(paths, plan, &updated)?;
    plan.files.push(change);
    plan.after_state.bindings.retain(|b| b.config_id != entry.id);
    plan.after_state.imports.retain(|i| {
        discovery::managed_path(paths, Path::new(&i.path), i.kind)
            .map(|p| discovery::key(&p) != entry.id).unwrap_or(true)
    });
    // 真实删除时同步清理组成员；只移除别名入口时仍保留文件的分组关系。
    plan.after_state.config_groups = config_groups::rekey(&plan.after_state, &entry.id, None);
    plan.after_state.config_order = plan.after_state.config_order.iter()
        .filter(|id| *id != &entry.id).cloned().collect();
    plan.identity_changes.push(crate::model::ConfigIdentityChange {
        before: Some(entry.id.clone()), after: None,
    });
    plan.notices.push(format!("原路径中的文件将真实删除，并移除 {} 个关联别名：{}。备份可用于恢复。未经 profile 声明的外部引用无法自动发现。",
        aliases.len(), aliases.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join("、")));
    Ok(())
}

pub fn remove_alias(
    paths: &Paths, plan: &mut ApplyPlan, ast: &AstResult, profile_text: &str,
    entry: &ConfigEntry, name: &str,
) -> Result<()> {
    let alias = ast.aliases.iter().find(|a| a.name == name).ok_or("别名不存在。")?;
    let updated = profile_editor::remove(profile_text, ast, std::slice::from_ref(alias))?;
    plan_profile(paths, plan, &updated)?;
    if entry.aliases.len() == 1 && entry.hash.is_some() {
        if !plan.after_state.imports.iter().any(|i| i.path == entry.path) {
            plan.after_state.imports.push(ImportedConfig { path: entry.path.clone(), kind: entry.kind });
        }
    } else if entry.aliases.len() == 1 && entry.hash.is_none() {
        plan.after_state.bindings.retain(|b| b.config_id != entry.id);
    }
    plan.notices.push(format!("仅移除入口 {name}，不会删除配置文件。"));
    Ok(())
}
