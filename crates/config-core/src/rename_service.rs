use crate::{
    alias_service, config_groups, discovery, files,
    model::{ApplyPlan, AstResult, ConfigEntry, ImportedConfig, Inventory, Kind, PanelState, Paths, Result},
    profile_editor,
};
use std::path::Path;

// 按新路径派生配置身份，保留模板应用快照、导入关系、显示位置及分组归属。
fn renamed_state(
    paths: &Paths, state: &PanelState, entry: &ConfigEntry, target: &Path, id: &str,
) -> Result<PanelState> {
    let bindings = state.bindings.iter().map(|binding| {
        if binding.config_id == entry.id {
            crate::model::Binding { config_id: id.into(), ..binding.clone() }
        } else {
            binding.clone()
        }
    }).collect();
    let imports = state.imports.iter().map(|import| {
        let path = discovery::managed_path(paths, Path::new(&import.path), import.kind)?;
        Ok(if discovery::key(&path) == entry.id {
            ImportedConfig { path: target.to_string_lossy().into(), kind: import.kind }
        } else {
            import.clone()
        })
    }).collect::<Result<Vec<_>>>()?;
    let config_order = state.config_order.iter().map(|current| {
        if current == &entry.id { id.into() } else { current.clone() }
    }).collect();
    let config_groups = config_groups::rekey(state, &entry.id, Some(id));
    Ok(PanelState { bindings, imports, config_order, config_groups, ..state.clone() })
}

pub fn rename(
    paths: &Paths, plan: &mut ApplyPlan, ast: &AstResult, profile: &str,
    inventory: &Inventory, entry: &ConfigEntry, name: &str,
) -> Result<()> {
    if let Some(error) = &entry.error { return Err(error.clone()); }
    let source = discovery::managed_path(paths, Path::new(&entry.path), entry.kind)?;
    let filename = match entry.kind {
        Kind::Codex => format!("config.{name}.toml"),
        Kind::Claude => format!("settings.{name}.json"),
    };
    // 未改名时保持原有保存行为，不因旧文件名称或 profile 状态增加重命名限制。
    if source.file_name().and_then(|value| value.to_str()) == Some(filename.as_str()) {
        return Ok(());
    }
    profile_editor::validate_name(name)?;
    if name.eq_ignore_ascii_case("auto") {
        return Err("auto 名称属于现有启动器管理入口，不能覆盖。".into());
    }
    let target = discovery::managed_path(paths, &source.with_file_name(&filename), entry.kind)?;
    let id = discovery::key(&target);
    if id == entry.id {
        return Err("Windows 不区分路径大小写；仅调整大小写请先改为其他名称，再改为目标名称。".into());
    }
    // 即使目标文件已经缺失，也不能接管其他条目保留的导入路径或命令引用。
    if inventory.configs.iter().any(|config| config.id == id) {
        return Err("目标路径已在管理清单中，请先处理对应文件或失效入口。".into());
    }
    if plan.after_state.bindings.iter().any(|binding| binding.config_id == id) {
        return Err("目标路径仍有模板绑定，请先处理原有绑定，不能通过重命名覆盖。".into());
    }
    let saved = plan.files.iter().find(|change| change.path == source)
        .ok_or("重命名计划缺少已校验的配置保存结果。")?;
    let output = files::unpack(saved.after.as_deref().ok_or("配置保存结果缺失。")?)?;
    let created = files::capture(&target, Some(output))?;
    if created.before.is_some() {
        return Err("目标配置文件已经存在，不能通过重命名覆盖。".into());
    }
    let removed = crate::model::FileChange { after: None, ..saved.clone() };
    let aliases = alias_service::references(paths, ast, entry)?;
    profile_editor::editable(ast, profile)?;
    let updated = profile_editor::rename(profile, ast, &aliases, &target.to_string_lossy(), name)?;
    let state = renamed_state(paths, &plan.after_state, entry, &target, &id)?;
    alias_service::plan_profile(paths, plan, &updated)?;
    // 先发布新文件，再切换命令，最后移除旧文件；现有日志负责失败回滚和备份恢复。
    plan.files = std::iter::once(created)
        .chain(plan.files.iter().filter(|change| change.path != source).cloned())
        .chain(std::iter::once(removed)).collect();
    plan.after_state = state;
    plan.identity_changes.push(crate::model::ConfigIdentityChange {
        before: Some(entry.id.clone()), after: Some(id),
    });
    plan.label = format!("重命名配置为「{filename}」并保存");
    plan.notices.push(format!(
        "配置将从 {} 迁移到 {}，同步更新 {} 个命令入口及模板绑定；未经 profile 声明的外部引用需手动更新。",
        source.display(), target.display(), aliases.len(),
    ));
    Ok(())
}
