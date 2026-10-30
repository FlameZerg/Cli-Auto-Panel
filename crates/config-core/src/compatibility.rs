use crate::{files::{self, Text}, merge_toml, model::{FileChange, Paths, Result}};

// 只执行实际兼容性校验并返回文件守卫，不生成共享配置的说明性提示。
pub fn inspect_codex(paths: &Paths, content: &str) -> Result<Option<FileChange>> {
    let config = merge_toml::parse(content)?;
    let Some((bytes, identity)) = files::read(&paths.codex_base)? else {
        return Ok(None);
    };
    let base = merge_toml::parse(&Text::decode(&bytes, false)?.value)?;
    let missing: Vec<String> = base.iter().filter(|(key, item)| {
        item.as_value().is_some()
            && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
            && !config.get(key).is_some_and(|v| v.as_value().is_some())
    }).map(|(key, _)| key.to_owned()).collect();
    if !missing.is_empty() {
        return Err(format!("现有 Codex 包装器要求别名补齐基础 config.toml 的顶层键：{}。请保留这些个别配置。", missing.join("、")));
    }
    let encoded = files::pack(&bytes);
    Ok(Some(FileChange {
        path: paths.codex_base.clone(), before: Some(encoded.clone()), after: Some(encoded),
        before_identity: Some(identity),
    }))
}
