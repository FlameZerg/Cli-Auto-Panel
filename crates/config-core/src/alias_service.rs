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
    kind: Kind, name: &str, content: &str,
) -> Result<std::path::PathBuf> {
    profile_editor::validate_name(name)?;
    if name.eq_ignore_ascii_case("auto") {
        return Err("auto 名称属于现有启动器管理入口，不能覆盖。".into());
    }
    let (root, prefix) = match kind {
        Kind::Codex => (&paths.codex_root, "codex"),
        Kind::Claude => (&paths.claude_root, "claude"),
    };
    let logical_path = root.join(discovery::filename(kind, name));
    let path = discovery::managed_path(paths, &logical_path, kind)?;
    let primary = files::capture(&path, Some(content.as_bytes().to_vec()))?;
    if primary.before.is_some() {
        return Err("目标配置文件已经存在，不能通过新建入口覆盖。".into());
    }
    let command = format!("{prefix}-{name}");
    let updated = profile_editor::append(profile_text, ast,
        &[(command.clone(), logical_path.to_string_lossy().into(), kind)])?;
    // 先发布配置，再注册入口，避免正常提交期间出现指向空文件的新命令。
    plan.files.push(primary);
    plan_profile(paths, plan, &updated)?;
    plan.files.sort_by_key(|f| f.path == paths.profile);
    // 新建内容来自完整草稿及模板合并，不再暗示复制过程会过滤凭据。
    plan.notices.push(format!("将新建并注册：{command}。配置内容以草稿及所选通用配置的合并结果为准。"));
    Ok(path)
}

fn matches_path(entry: &ConfigEntry, path: &Path) -> bool {
    discovery::key(path) == entry.id || discovery::normalized(path)
        .is_ok_and(|resolved| discovery::key(&resolved) == entry.id)
}

pub(crate) fn ensure_unmanaged_paths_clear(ast: &AstResult, entry: &ConfigEntry) -> Result<()> {
    if ast.unmanaged_paths.iter().any(|path| matches_path(entry, Path::new(path))) {
        return Err(format!("{} 仍有面板外的 PowerShell 注册引用，请先处理该引用。", entry.path));
    }
    Ok(())
}

// 依据本轮清单识别入口，其他条目的无效路径不会中断当前操作。
pub(crate) fn references(ast: &AstResult, entry: &ConfigEntry) -> Vec<Alias> {
    ast.aliases.iter().filter(|alias| entry.aliases.contains(&alias.name)
        && matches_path(entry, Path::new(&alias.path))).cloned().collect()
}

pub fn delete_config(
    paths: &Paths, plan: &mut ApplyPlan, ast: &AstResult, profile_text: &str,
    entry: &ConfigEntry, expected_hash: &str,
) -> Result<()> {
    if entry.error.is_some() {
        return Err("配置文件有路径、身份或读取错误，请使用移除管理记录。".into());
    }
    ensure_unmanaged_paths_clear(ast, entry)?;
    let path = discovery::managed_path(paths, Path::new(&entry.path), entry.kind)?;
    let change = files::capture(&path, None)?;
    let before = change.before.as_deref().ok_or("配置文件已经不存在。")?;
    if files::hash(&files::unpack(before)?) != expected_hash {
        return Err("配置已被外部修改，请刷新清单并打开配置后再决定是否删除。".into());
    }
    // 即使是手工导入文件，也不在存在未知动态引用时贸然删除。
    profile_editor::editable(ast, profile_text)?;
    let aliases = forget_config(paths, plan, ast, profile_text, entry)?;
    plan.files.push(change);
    plan.notices.push(format!("原路径中的文件将真实删除，并移除 {} 个关联别名。备份可用于恢复。", aliases.len()));
    Ok(())
}

pub(crate) fn forget_config(
    paths: &Paths, plan: &mut ApplyPlan, ast: &AstResult, profile_text: &str, entry: &ConfigEntry,
) -> Result<Vec<Alias>> {
    let aliases = references(ast, entry);
    if !aliases.is_empty() {
        let updated = profile_editor::remove(profile_text, ast, &aliases)?;
        plan_profile(paths, plan, &updated)?;
    }
    // 移除管理记录无需读写源文件，缺失文件或无效导入路径也可清理。
    plan.after_state.bindings.retain(|b| b.config_id != entry.id);
    plan.after_state.imports.retain(|i| !matches_path(entry, Path::new(&i.path)));
    // 真实删除时同步清理组成员；只移除别名入口时仍保留文件的分组关系。
    plan.after_state.config_groups = config_groups::rekey(&plan.after_state, &entry.id, None);
    plan.after_state.config_order = plan.after_state.config_order.iter()
        .filter(|id| *id != &entry.id).cloned().collect();
    plan.identity_changes.push(crate::model::ConfigIdentityChange {
        before: Some(entry.id.clone()), after: None,
    });
    Ok(aliases)
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
