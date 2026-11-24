use crate::{discovery, model::{AstResult, Inventory, OrphanedBinding, PanelState, Paths}};
use std::{collections::{HashMap, HashSet}, fs, path::Path};

pub(crate) fn filename(path: impl AsRef<Path>) -> Option<String> {
    path.as_ref().file_name().map(|name| name.to_string_lossy().into_owned())
}

fn match_path(path: &Path, unknown: &mut HashSet<String>, names: &mut HashMap<String, String>) {
    let Some(name) = filename(path) else { return; };
    // 优先匹配记录原样路径；父目录已移除时，仍可匹配历史中保存的规范路径。
    let direct_id = discovery::key(path);
    if unknown.remove(&direct_id) { names.insert(direct_id, name.clone()); }
    if !unknown.is_empty() {
        if let Ok(resolved) = discovery::normalized(path) {
            let id = discovery::key(&resolved);
            if unknown.remove(&id) { names.insert(id, name); }
        }
    }
}

pub(crate) fn orphaned(
    paths: &Paths, state: &PanelState, ast: &AstResult, inventory: &Inventory,
) -> Vec<OrphanedBinding> {
    let managed: HashSet<_> = inventory.configs.iter().map(|entry| entry.id.as_str()).collect();
    let mut missing: Vec<_> = state.bindings.iter().filter(|binding| !managed.contains(binding.config_id.as_str()))
        .map(|binding| OrphanedBinding {
            config_id: binding.config_id.clone(),
            template_id: binding.template_id.clone(),
            filename: binding.config_path.as_deref().and_then(filename),
        }).collect();
    let mut unknown: HashSet<_> = missing.iter().filter(|binding| binding.filename.is_none())
        .map(|binding| binding.config_id.clone()).collect();
    if unknown.is_empty() { return missing; }

    let mut names = HashMap::new();
    // 老绑定只保存路径哈希，可从已有注册和配置目录反查文件名；文件内容无需读取。
    for path in &ast.unmanaged_paths {
        match_path(Path::new(path), &mut unknown, &mut names);
        if unknown.is_empty() { break; }
    }
    'roots: for root in [&paths.codex_root, &paths.claude_root] {
        if unknown.is_empty() { break; }
        let Ok(directory) = fs::canonicalize(root) else { continue; };
        let Ok(entries) = fs::read_dir(&directory) else { continue; };
        for entry in entries.flatten() {
            let id = discovery::key(&directory.join(entry.file_name()));
            if unknown.remove(&id) {
                names.insert(id, entry.file_name().to_string_lossy().into_owned());
            }
            if unknown.is_empty() { break 'roots; }
        }
    }
    for binding in &mut missing {
        if binding.filename.is_none() { binding.filename = names.get(&binding.config_id).cloned(); }
    }
    missing
}

pub(crate) fn fill_from_history(bindings: &mut [OrphanedBinding], paths: &[String]) {
    let mut unknown: HashSet<_> = bindings.iter().filter(|binding| binding.filename.is_none())
        .map(|binding| binding.config_id.clone()).collect();
    let mut names = HashMap::new();
    for path in paths {
        if unknown.is_empty() { break; }
        match_path(Path::new(path), &mut unknown, &mut names);
    }
    for binding in bindings {
        if binding.filename.is_none() { binding.filename = names.get(&binding.config_id).cloned(); }
    }
}
