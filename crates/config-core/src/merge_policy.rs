// 使用键路径而非点分字符串，避免含点的 JSON/TOML 键被误判为嵌套字段。
pub type Overrides = Vec<Vec<String>>;

pub fn protected(overrides: &[Vec<String>], path: &[String]) -> bool {
    overrides.iter().any(|entry| path.starts_with(entry))
}

pub fn has_protected_children(overrides: &[Vec<String>], path: &[String]) -> bool {
    overrides.iter().any(|entry| entry.starts_with(path))
}

pub fn preserve(overrides: &mut Overrides, path: &[String]) {
    if !protected(overrides, path) {
        overrides.retain(|entry| !entry.starts_with(path));
        overrides.push(path.to_vec());
    }
}
