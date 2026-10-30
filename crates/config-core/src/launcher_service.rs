use crate::{
    alias_service, discovery, files,
    model::{ApplyPlan, AstResult, ConfigEntry, Kind, Paths, Result},
    profile_editor,
};
use std::{collections::BTreeSet, path::Path};

// 即时切换只修改入口注册，文件正文、模板绑定、分组和未保存草稿都不参与。
pub fn set_launcher(
    paths: &Paths, plan: &mut ApplyPlan, ast: &AstResult, profile: &str,
    entry: &ConfigEntry, launcher: &str, expected_hash: &str,
) -> Result<()> {
    if entry.kind != Kind::Codex { return Err("只有 Codex 配置支持启动版本切换。".into()); }
    if let Some(error) = &entry.error { return Err(error.clone()); }
    let path = discovery::managed_path(paths, Path::new(&entry.path), Kind::Codex)?;
    let captured = files::capture(&path, None)?;
    let before = captured.before.as_deref().ok_or("配置源文件不存在。")?;
    if files::hash(&files::unpack(before)?) != expected_hash {
        return Err("配置已被外部修改，请重新载入后切换启动版本。".into());
    }
    let aliases = alias_service::references(paths, ast, entry)?;
    let suffixes = if aliases.is_empty() {
        let filename = path.file_name().and_then(|name| name.to_str()).ok_or("配置文件名无效。")?;
        BTreeSet::from([filename[7..filename.len() - 5].to_owned()])
    } else {
        aliases.iter().map(|alias| {
            alias.name.split_once('-').map(|(_, suffix)| suffix.to_owned())
                .ok_or_else(|| "别名缺少名称后缀，无法切换启动版本。".to_owned())
        }).collect::<Result<BTreeSet<_>>>()?
    };
    let mut commands = BTreeSet::new();
    let mut registrations = Vec::new();
    for suffix in suffixes {
        profile_editor::validate_name(&suffix)?;
        // 管理入口不能由手动导入文件绕过新建时的保护。
        if suffix.eq_ignore_ascii_case("auto") {
            return Err("auto 名称属于现有启动器管理入口，不能覆盖。".into());
        }
        for command in alias_service::codex_commands(launcher, &suffix)? {
            if commands.insert(command.to_lowercase()) {
                registrations.push((command, entry.path.clone(), Kind::Codex));
            }
        }
    }
    let existing: BTreeSet<_> = aliases.iter().map(|alias| alias.name.to_lowercase()).collect();
    if existing == commands { return Err("当前配置已使用所选启动版本。".into()); }
    // 移除和追加共用已有 AST 安全校验，目标命令被其他文件占用时直接拒绝。
    let removed = profile_editor::remove(profile, ast, &aliases)?;
    let remaining = profile_editor::parse(&removed)?;
    let updated = profile_editor::append(&removed, &remaining, &registrations)?;
    alias_service::plan_profile(paths, plan, &updated)?;
    plan.files.push(crate::model::FileChange { after: captured.before.clone(), ..captured });
    plan.label = "切换 Codex 启动版本".into();
    // 成功路径显式返回结果，与函数声明的 Result<()> 保持一致。
    Ok(())
}
