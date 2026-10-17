use crate::model::Result;
use toml_edit::{DocumentMut, Item, TableLike, Value};

pub fn parse(text: &str) -> Result<DocumentMut> {
    let doc = text.parse::<DocumentMut>().map_err(|e| {
        let offset = e.span().map(|s| s.start).unwrap_or(0).min(text.len());
        let line = text.as_bytes()[..offset].iter().filter(|b| **b == b'\n').count() + 1;
        format!("TOML 格式或重复键校验失败：第 {line} 行附近。")
    })?;
    check_keys(doc.as_table(), 0)?;
    Ok(doc)
}

fn check_keys(table: &dyn TableLike, depth: usize) -> Result<()> {
    if depth > 64 {
        return Err("TOML 嵌套超过 64 层，已停止处理。".into());
    }
    for (key, item) in table.iter() {
        if matches!(key, "__proto__" | "constructor" | "prototype") {
            return Err("TOML 包含禁止的合并键。".into());
        }
        if let Some(child) = item.as_table_like() {
            check_keys(child, depth + 1)?;
        }
        if let Some(tables) = item.as_array_of_tables() {
            for child in tables.iter() {
                check_keys(child, depth + 1)?;
            }
        }
        if let Some(Value::Array(values)) = item.as_value() {
            for value in values.iter() { check_value(value, depth + 1)?; }
        }
    }
    Ok(())
}

fn check_value(value: &Value, depth: usize) -> Result<()> {
    if depth > 64 { return Err("TOML 值嵌套超过 64 层，已停止处理。".into()); }
    match value {
        Value::InlineTable(table) => check_keys(table, depth + 1),
        Value::Array(values) => {
            for value in values.iter() { check_value(value, depth + 1)?; }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn table_subset(target: &dyn TableLike, source: &dyn TableLike) -> bool {
    source.iter().all(|(k, v)| target.get(k).is_some_and(|t| item_subset(t, v)))
}

fn value_subset(target: &Value, source: &Value) -> bool {
    match (target, source) {
        (Value::String(t), Value::String(s)) => t.value() == s.value(),
        (Value::Integer(t), Value::Integer(s)) => t.value() == s.value(),
        (Value::Float(t), Value::Float(s)) => {
            t.value() == s.value() || (t.value().is_nan() && s.value().is_nan())
        }
        (Value::Boolean(t), Value::Boolean(s)) => t.value() == s.value(),
        (Value::Datetime(t), Value::Datetime(s)) => t.value() == s.value(),
        (Value::InlineTable(t), Value::InlineTable(s)) => table_subset(t, s),
        (Value::Array(t), Value::Array(s)) => {
            let mut used = vec![false; t.len()];
            s.iter().all(|v| {
                if let Some(i) = t.iter().enumerate().position(|(i, x)| !used[i] && value_subset(x, v)) {
                    used[i] = true;
                    true
                } else {
                    false
                }
            })
        }
        _ => false,
    }
}

fn item_subset(target: &Item, source: &Item) -> bool {
    if let (Some(t), Some(s)) = (target.as_table_like(), source.as_table_like()) {
        return table_subset(t, s);
    }
    if let (Some(t), Some(s)) = (target.as_array_of_tables(), source.as_array_of_tables()) {
        let mut used = vec![false; t.len()];
        return s.iter().all(|table| {
            if let Some(i) = t.iter().enumerate().position(|(i, x)| !used[i] && table_subset(x, table)) {
                used[i] = true;
                true
            } else { false }
        });
    }
    match (target.as_value(), source.as_value()) {
        (Some(t), Some(s)) => value_subset(t, s),
        _ => false,
    }
}

fn merge_table(target: &mut dyn TableLike, source: &dyn TableLike) {
    for (key, value) in source.iter() {
        match target.get_mut(key) {
            Some(current) => {
                if let (Some(t), Some(s)) = (current.as_table_like_mut(), value.as_table_like()) {
                    merge_table(t, s);
                } else {
                    *current = value.clone();
                }
            }
            None => {
                target.insert(key, value.clone());
            }
        }
    }
}

fn remove_item(target: &mut Item, source: &Item) {
    if let (Some(t), Some(s)) = (target.as_table_like_mut(), source.as_table_like()) {
        remove_table(t, s);
        return;
    }
    // 表数组单独按匹配条目剥离，保留用户额外添加的技能配置。
    if let (Some(t), Some(s)) = (target.as_array_of_tables_mut(), source.as_array_of_tables()) {
        for table in s.iter() {
            let index = t.iter().position(|x| table_subset(x, table));
            if let Some(i) = index {
                t.remove(i);
            }
        }
        return;
    }
    if let (Some(t), Some(s)) = (target.as_array_mut(), source.as_array()) {
        for value in s.iter() {
            let index = t.iter().position(|x| value_subset(x, value));
            if let Some(i) = index {
                t.remove(i);
            }
        }
        return;
    }
    if item_subset(target, source) {
        *target = Item::None;
    }
}

fn remove_table(target: &mut dyn TableLike, source: &dyn TableLike) {
    for (key, value) in source.iter() {
        let delete = if let Some(current) = target.get_mut(key) {
            remove_item(current, value);
            current.is_none()
                || current.as_table_like().is_some_and(|t| t.is_empty())
                || current.as_array().is_some_and(|a| a.is_empty())
                || current.as_array_of_tables().is_some_and(|a| a.is_empty())
        } else {
            false
        };
        if delete {
            target.remove(key);
        }
    }
}

pub fn apply(config: &str, snippet: &str) -> Result<String> {
    let mut target = parse(config)?;
    if !snippet.trim().is_empty() {
        merge_table(target.as_table_mut(), parse(snippet)?.as_table());
    }
    Ok(target.to_string())
}

pub fn strip(config: &str, snippet: &str) -> Result<String> {
    let mut target = parse(config)?;
    if !snippet.trim().is_empty() {
        remove_table(target.as_table_mut(), parse(snippet)?.as_table());
    }
    Ok(target.to_string())
}
