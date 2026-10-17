use crate::{merge_json, merge_toml, model::{Extraction, Kind, Result}};
use serde_json::Value;

pub fn sensitive(name: &str) -> bool {
    let upper = name.to_ascii_uppercase().replace('-', "_");
    let suffixes = ["_KEY", "_KEY_ID", "_APIKEY", "_ACCESSKEY", "_SECRETKEY", "_APITOKEN",
        "_TOKEN", "_PAT", "_PWD", "_PASS", "_PASSPHRASE", "_CREDS"];
    ["APIKEY", "API_KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIALS", "AUTHORIZATION",
        "EXPERIMENTAL_BEARER_TOKEN"].contains(&upper.as_str())
        || suffixes.iter().any(|s| upper.ends_with(s))
        || ["SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE_KEY", "BEARER_TOKEN"]
            .iter().any(|s| upper.contains(s))
}

fn scrub_json(value: &mut Value, prefix: &str, excluded: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            let keys: Vec<String> = map.keys().cloned().collect();
            for key in keys {
                let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
                if sensitive(&key) {
                    map.remove(&key);
                    excluded.push(path);
                } else if let Some(value) = map.get_mut(&key) {
                    scrub_json(value, &path, excluded);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                scrub_json(value, prefix, excluded);
            }
        }
        _ => {}
    }
}

fn scrub_toml(table: &mut dyn toml_edit::TableLike, prefix: &str, excluded: &mut Vec<String>) {
    let keys: Vec<String> = table.iter().map(|(k, _)| k.to_owned()).collect();
    for key in keys {
        let path = if prefix.is_empty() { key.clone() } else { format!("{prefix}.{key}") };
        if sensitive(&key) {
            table.remove(&key);
            excluded.push(path);
        } else if let Some(item) = table.get_mut(&key) {
            if let Some(child) = item.as_table_like_mut() {
                scrub_toml(child, &path, excluded);
            }
            if let Some(children) = item.as_array_of_tables_mut() {
                for child in children.iter_mut() {
                    scrub_toml(child, &path, excluded);
                }
            }
            if let Some(toml_edit::Value::Array(values)) = item.as_value_mut() {
                for value in values.iter_mut() { scrub_toml_value(value, &path, excluded); }
            }
        }
    }
}

fn scrub_toml_value(value: &mut toml_edit::Value, prefix: &str, excluded: &mut Vec<String>) {
    match value {
        toml_edit::Value::InlineTable(table) => scrub_toml(table, prefix, excluded),
        toml_edit::Value::Array(values) => {
            for value in values.iter_mut() { scrub_toml_value(value, prefix, excluded); }
        }
        _ => {}
    }
}

pub fn extract(kind: Kind, content: &str) -> Result<Extraction> {
    let mut excluded = Vec::new();
    let content = match kind {
        Kind::Claude => {
            let mut config = merge_json::parse(content)?;
            let excluded_env = [
                "ANTHROPIC_MODEL", "ANTHROPIC_REASONING_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
                "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "ANTHROPIC_BASE_URL",
            ];
            if let Some(env) = config.get_mut("env").and_then(Value::as_object_mut) {
                let keys: Vec<String> = env.keys().filter(|k| {
                    excluded_env.contains(&k.as_str()) || k.starts_with("ANTHROPIC_DEFAULT_")
                }).cloned().collect();
                for key in keys {
                    env.remove(&key);
                    excluded.push(format!("env.{key}"));
                }
            }
            if let Some(map) = config.as_object_mut() {
                for key in ["apiBaseUrl", "primaryModel", "smallFastModel"] {
                    if map.remove(key).is_some() { excluded.push(key.into()); }
                }
            }
            // 比参考提取更保守地检查嵌套凭据，排除项在界面逐项展示，不静默处理。
            scrub_json(&mut config, "", &mut excluded);
            if config.get("env").and_then(Value::as_object).is_some_and(|m| m.is_empty()) {
                config.as_object_mut().ok_or("配置根节点无效。")?.remove("env");
            }
            merge_json::render(&config)?
        }
        Kind::Codex => {
            let mut config = merge_toml::parse(content)?;
            for key in ["model", "model_provider", "base_url", "wire_api", "model_providers",
                "mcp_servers", "experimental_bearer_token", "model_catalog_json"] {
                if config.remove(key).is_some() { excluded.push(key.into()); }
            }
            if let Some(mcp) = config.get_mut("mcp").and_then(|i| i.as_table_like_mut()) {
                if mcp.remove("servers").is_some() { excluded.push("mcp.servers".into()); }
            }
            if config.get("mcp").and_then(|i| i.as_table_like()).is_some_and(|m| m.is_empty()) {
                config.remove("mcp");
            }
            if config.get("web_search").and_then(|i| i.as_str()) == Some("disabled") {
                config.remove("web_search");
                excluded.push("web_search（参考项目禁用哨兵）".into());
            }
            scrub_toml(config.as_table_mut(), "", &mut excluded);
            config.to_string()
        }
    };
    Ok(Extraction { content, excluded })
}

pub fn risk_notices(kind: Kind, content: &str) -> Result<Vec<String>> {
    if content.trim().is_empty() { return Ok(Vec::new()); }
    let extraction = extract(kind, content)?;
    let mut notices = Vec::new();
    if !extraction.excluded.is_empty() {
        notices.push(format!("片段包含凭据、供应商、模型或路由等专属内容，应用前请核对：{}。", extraction.excluded.join("、")));
    }
    if content.contains("hooks") || content.contains("permissions") || content.contains("mcp_servers") {
        notices.push("片段涉及 Hook、权限或 MCP；这些设置可能改变命令执行、授权或联网行为。".into());
    }
    Ok(notices)
}
