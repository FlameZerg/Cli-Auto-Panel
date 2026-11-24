use crate::{
    alias_service, config_groups, discovery, files,
    model::{ApplyPlan, AstResult, ConfigEntry, ConfigIdentityChange, FileChange, ImportedConfig, Inventory, Paths, Result},
    profile_editor,
};
use std::path::Path;

pub(crate) fn relocate(
    paths: &Paths, plan: &mut ApplyPlan, ast: &AstResult, profile: &str, inventory: &Inventory,
    entry: &ConfigEntry, requested_name: Option<&str>,
) -> Result<()> {
    let Some(name) = requested_name else { return Ok(()); };
    let source = discovery::managed_path(paths, Path::new(&entry.path), entry.kind)?;
    let original_filename = source.file_name().and_then(|name| name.to_str()).ok_or("配置文件名无效。")?;
    if discovery::suffix(entry.kind, original_filename) == Some(name) { return Ok(()); }
    profile_editor::validate_name(name)?;
    if name.eq_ignore_ascii_case("auto") {
        return Err("auto 名称属于现有启动器管理入口，不能覆盖。".into());
    }
    let filename = discovery::filename(entry.kind, name);
    let target = discovery::managed_path(paths, &source.with_file_name(&filename), entry.kind)?;
    alias_service::ensure_unmanaged_paths_clear(ast, entry)?;
    let aliases = alias_service::references(ast, entry);
    profile_editor::editable(ast, profile)?;
    let target_text = target.to_string_lossy();
    let updated = profile_editor::relocate(profile, ast, &aliases, name, &target_text)?;
    if updated != profile { alias_service::plan_profile(paths, plan, &updated)?; }
    let (created, removed) = move_document(paths, plan, inventory, entry, &source, &target)?;
    let id = discovery::key(&target);
    plan.after_state.config_groups = config_groups::rekey(&plan.after_state, &entry.id, Some(&id));
    plan.after_state.config_order = plan.after_state.config_order.iter()
        .map(|current| if current == &entry.id { id.clone() } else { current.clone() }).collect();
    plan.identity_changes.push(ConfigIdentityChange { before: Some(entry.id.clone()), after: Some(id) });
    // 先发布目标文件，再切换命令，最后移除已被替代的文件。
    let mut remaining = std::mem::take(&mut plan.files);
    remaining.sort_by_key(|change| change.path == paths.profile);
    plan.files = std::iter::once(created).chain(remaining).chain(std::iter::once(removed)).collect();
    plan.label = format!("重命名配置为「{filename}」并保存");
    plan.notices.push(format!(
        "配置迁移：{} → {}。同步更新相关命令入口与模板绑定；未经 profile 声明的外部引用需手动更新。",
        entry.path, target.display(),
    ));
    Ok(())
}

fn move_document(
    paths: &Paths, plan: &mut ApplyPlan, inventory: &Inventory, entry: &ConfigEntry, source: &Path, target: &Path,
) -> Result<(FileChange, FileChange)> {
    let id = discovery::key(target);
    if id == entry.id {
        return Err("Windows 不区分路径大小写；仅调整大小写请先改为其他名称，再改为目标名称。".into());
    }
    if inventory.configs.iter().any(|config| config.id == id)
        || plan.after_state.bindings.iter().any(|binding| binding.config_id == id) {
        return Err("目标路径已在管理清单中或有绑定，不能通过重命名覆盖。".into());
    }
    let index = plan.files.iter().position(|change| change.path == source)
        .ok_or("操作计划缺少待重命名的配置。")?;
    let saved = plan.files.remove(index);
    let output = files::unpack(saved.after.as_deref().ok_or("待重命名的配置结果缺失。")?)?;
    let created = files::capture(target, Some(output))?;
    if created.before.is_some() { return Err("目标配置文件已经存在，不能通过重命名覆盖。".into()); }
    plan.after_state.bindings = plan.after_state.bindings.iter().map(|binding| {
        if binding.config_id == entry.id {
            crate::model::Binding {
                config_id: id.clone(), config_path: Some(target.to_string_lossy().into()), ..binding.clone()
            }
        } else { binding.clone() }
    }).collect();
    for import in &mut plan.after_state.imports {
        if discovery::managed_path(paths, Path::new(&import.path), import.kind).is_ok_and(|path| path == source) {
            *import = ImportedConfig { path: target.to_string_lossy().into(), kind: import.kind };
        }
    }
    Ok((created, FileChange { after: None, ..saved }))
}
