use crate::{merge_json, merge_toml, model::{Extraction, Kind, Result}};
use serde_json::Value;

fn account_specific_key(name: &str) -> bool {
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
                if account_specific_key(&key) {
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
        if account_specific_key(&key) {
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
            // 提取时排除账号专属连接字段，避免公共片段改变其他别名的账号。
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
