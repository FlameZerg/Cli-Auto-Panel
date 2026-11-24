use crate::{
    files,
    model::{AstResult, ConfigEntry, Inventory, InventoryWarning, Kind, PanelState, Paths, Result},
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

pub(crate) fn filename(kind: Kind, name: &str) -> String {
    match kind {
        Kind::Codex => format!("config.{name}.toml"),
        Kind::Claude => format!("settings.{name}.json"),
    }
}

pub(crate) fn suffix(kind: Kind, name: &str) -> Option<&str> {
    let (prefix, extension) = match kind {
        Kind::Codex => ("config.", ".toml"),
        Kind::Claude => ("settings.", ".json"),
    };
    name.strip_prefix(prefix)?.strip_suffix(extension).filter(|suffix| !suffix.is_empty())
}

fn in_root(paths: &Paths, resolved: &Path, kind: Kind) -> Result<bool> {
    let root = match kind { Kind::Codex => &paths.codex_root, Kind::Claude => &paths.claude_root };
    let real_root = fs::canonicalize(root)
        .map_err(|e| format!("受管目录不可用 {}：{e}", root.display()))?;
    Ok(resolved.parent() == Some(real_root.as_path()))
}

pub fn managed_path(paths: &Paths, path: &Path, kind: Kind) -> Result<PathBuf> {
    let resolved = normalized(path)?;
    let name = resolved.file_name().and_then(|n| n.to_str()).ok_or("配置文件名无效。")?;
    if !in_root(paths, &resolved, kind)? || suffix(kind, name).is_none()
        || (kind == Kind::Claude && name.eq_ignore_ascii_case("settings.local.json")) {
        return Err("配置不在允许的别名配置目录内，或属于默认/本地配置，已禁止管理。".into());
    }
    Ok(resolved)
}

// 仅允许处理升级前已落盘的恢复日志，避免未完成事务锁住面板。
pub(crate) fn is_retired_recovery_path(paths: &Paths, path: &Path) -> bool {
    path.file_name().and_then(|name| name.to_str()).is_some_and(|name| {
        name.strip_prefix("confignew.").and_then(|name| name.strip_suffix(".toml"))
            .is_some_and(|name| !name.is_empty())
    }) && normalized(path).is_ok_and(|resolved| resolved == path)
        && in_root(paths, path, Kind::Codex).unwrap_or(false)
}

pub fn inventory(paths: &Paths, ast: &AstResult, state: &PanelState) -> Inventory {
    let mut groups: BTreeMap<String, ConfigEntry> = BTreeMap::new();
    let warnings = ast.warnings.iter().chain(&ast.errors).cloned().map(InventoryWarning::new).collect();
    let mut identities: BTreeMap<String, String> = BTreeMap::new();
    let mut hard_links = Vec::new();
    let mut sources: Vec<(String, String, Kind)> = ast.aliases.iter()
        .map(|a| (a.name.clone(), a.path.clone(), a.kind)).collect();
    sources.extend(state.imports.iter().map(|i| (String::new(), i.path.clone(), i.kind)));
    // 只在本轮扫描内复用同路径、同产品的校验结果；下次读取与提交仍重新核验真实路径。
    let mut resolved_sources: BTreeMap<(String, bool), Result<PathBuf>> = BTreeMap::new();
    for (name, source_path, kind) in sources {
        let result = resolved_sources.entry((source_path.clone(), kind == Kind::Codex))
            .or_insert_with(|| managed_path(paths, Path::new(&source_path), kind)).clone();
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
        // 同一轮清单中，指向相同文件的入口共用一次文件读取。
        if entry.error.is_none() && entry.hash.is_none() {
            match files::read(&path) {
                Ok(Some((bytes, identity))) => {
                    entry.hash = Some(files::hash(&bytes));
                    if let Some(other) = identities.insert(identity, id.clone()) {
                        if other != id {
                            hard_links.extend([other, id]);
                        }
                    }
                }
                Ok(None) => entry.error = Some("配置源文件不存在。".into()),
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
