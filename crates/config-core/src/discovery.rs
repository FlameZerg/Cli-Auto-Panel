use crate::{
    files,
    model::{AstResult, ConfigEntry, Inventory, Kind, PanelState, Paths, Result},
};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}};

pub fn normalized(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err("配置路径必须是绝对路径。".into());
    }
    let parent = path.parent().ok_or("配置路径缺少父目录。")?;
    let name = path.file_name().ok_or("配置路径缺少文件名。")?;
    let real_parent = fs::canonicalize(parent)
        .map_err(|e| format!("无法解析配置目录 {}：{e}", parent.display()))?;
    Ok(real_parent.join(name))
}

pub fn key(path: &Path) -> String {
    files::hash(path.to_string_lossy().to_lowercase().as_bytes())
}

pub fn managed_path(paths: &Paths, path: &Path, kind: Kind) -> Result<PathBuf> {
    let resolved = normalized(path)?;
    let root = match kind { Kind::Codex => &paths.codex_root, Kind::Claude => &paths.claude_root };
    let real_root = fs::canonicalize(root)
        .map_err(|e| format!("受管目录不可用 {}：{e}", root.display()))?;
    let name = resolved.file_name().and_then(|n| n.to_str()).ok_or("配置文件名无效。")?;
    let valid_name = match kind {
        Kind::Codex => name.starts_with("config.") && name.ends_with(".toml") && name.len() > 12,
        Kind::Claude => name.starts_with("settings.") && name.ends_with(".json")
            && name != "settings.local.json" && name.len() > 14,
    };
    if resolved.parent() != Some(real_root.as_path()) || !valid_name {
        return Err("配置不在允许的别名配置目录内，或属于默认/本地配置，已禁止管理。".into());
    }
    Ok(resolved)
}

pub fn inventory(paths: &Paths, ast: &AstResult, state: &PanelState) -> Inventory {
    let mut groups: BTreeMap<String, ConfigEntry> = BTreeMap::new();
    let mut warnings = ast.warnings.clone();
    warnings.extend(ast.errors.clone());
    let mut identities: BTreeMap<String, String> = BTreeMap::new();
    let mut hard_links = Vec::new();
    let mut sources: Vec<(String, String, Kind)> = ast.aliases.iter()
        .map(|a| (a.name.clone(), a.path.clone(), a.kind)).collect();
    sources.extend(state.imports.iter().map(|i| (String::new(), i.path.clone(), i.kind)));
    for (name, source_path, kind) in sources {
        let result = managed_path(paths, Path::new(&source_path), kind);
        let (path, error) = match result {
            Ok(path) => (path, None),
            Err(error) => (PathBuf::from(&source_path), Some(error)),
        };
        let id = key(&path);
        let entry = groups.entry(id.clone()).or_insert_with(|| ConfigEntry {
            id: id.clone(), path: path.to_string_lossy().to_string(), kind,
            aliases: Vec::new(), hash: None, error,
        });
        if !name.is_empty() { entry.aliases.push(name); }
        if entry.kind != kind {
            entry.error = Some("同一文件被不同应用类型引用，已禁止修改。".into());
        }
        if entry.error.is_none() {
            match files::read(&path) {
                Ok(Some((bytes, identity))) => {
                    entry.hash = Some(files::hash(&bytes));
                    if let Some(other) = identities.insert(identity, id.clone()) {
                        if other != id {
                            hard_links.extend([other, id]);
                        }
                    }
                }
                Ok(None) => entry.error = Some("配置源文件不存在；可移除失效别名，但不会自动创建猜测内容。".into()),
                Err(e) => entry.error = Some(e),
            }
        }
    }
    for id in hard_links {
        if let Some(entry) = groups.get_mut(&id) {
            entry.error = Some("不同路径指向同一硬链接文件，原子替换会拆分链接，已禁止自动修改。".into());
        }
    }
    Inventory { configs: groups.into_values().collect(), warnings }
}
