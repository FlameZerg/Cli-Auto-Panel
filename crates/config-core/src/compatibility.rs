use crate::{files::{self, Text}, merge_toml, model::{FileChange, Paths, Result}};

pub fn inspect_codex(paths: &Paths, content: &str) -> Result<(Vec<String>, Option<FileChange>)> {
    let config = merge_toml::parse(content)?;
    let Some((bytes, identity)) = files::read(&paths.codex_base)? else {
        return Ok((vec!["没有基础 config.toml，当前文件将由现有包装器作为完整快照使用。".into()], None));
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
    let mut notices = vec!["此处是源文件合并结果；项目层、命令行和运行时策略仍可能覆盖它。".into()];
    if let Some(servers) = base.get("mcp_servers").and_then(|i| i.as_table_like()) {
        let absent = servers.iter().filter(|(key, _)| {
            config.get("mcp_servers").and_then(|i| i.as_table_like())
                .and_then(|t| t.get(key)).is_none()
        }).count();
        if absent > 0 {
            notices.push(format!("基础层有 {absent} 个本文件未声明的 MCP；现有包装器会在会话快照中显式禁用它们。"));
        }
    }
    let encoded = files::pack(&bytes);
    Ok((notices, Some(FileChange {
        path: paths.codex_base.clone(), before: Some(encoded.clone()), after: Some(encoded),
        before_identity: Some(identity),
    })))
}
