use crate::{merge_policy::{self, Overrides}, model::{MergePriority, Result}};
use toml_edit::{DocumentMut, Item, TableLike, Value};

pub fn parse(text: &str) -> Result<DocumentMut> {
    let doc = text.parse::<DocumentMut>().map_err(|error| format!("TOML 解析失败：{error}"))?;
    check_table_depth(doc.as_table(), 0)?;
    Ok(doc)
}

fn check_table_depth(table: &dyn TableLike, depth: usize) -> Result<()> {
    if depth > 64 {
        return Err("TOML 嵌套超过 64 层，已停止处理。".into());
    }
    for (_, item) in table.iter() {
        if let Some(child) = item.as_table_like() {
            check_table_depth(child, depth + 1)?;
        }
        if let Some(tables) = item.as_array_of_tables() {
            for child in tables.iter() {
                check_table_depth(child, depth + 1)?;
            }
        }
        if let Some(Value::Array(values)) = item.as_value() {
            for value in values.iter() { check_value_depth(value, depth + 1)?; }
        }
    }
    Ok(())
}

fn check_value_depth(value: &Value, depth: usize) -> Result<()> {
    if depth > 64 { return Err("TOML 值嵌套超过 64 层，已停止处理。".into()); }
    match value {
        Value::InlineTable(table) => check_table_depth(table, depth + 1),
        Value::Array(values) => {
            for value in values.iter() { check_value_depth(value, depth + 1)?; }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn table_equal(target: &dyn TableLike, source: &dyn TableLike) -> bool {
    target.len() == source.len()
        && source.iter().all(|(key, value)| target.get(key).is_some_and(|item| item_equal(item, value)))
}

fn value_equal(target: &Value, source: &Value) -> bool {
    match (target, source) {
        (Value::String(t), Value::String(s)) => t.value() == s.value(),
        (Value::Integer(t), Value::Integer(s)) => t.value() == s.value(),
        (Value::Float(t), Value::Float(s)) => {
            t.value() == s.value() || (t.value().is_nan() && s.value().is_nan())
        }
        (Value::Boolean(t), Value::Boolean(s)) => t.value() == s.value(),
        (Value::Datetime(t), Value::Datetime(s)) => t.value() == s.value(),
        (Value::InlineTable(t), Value::InlineTable(s)) => table_equal(t, s),
        (Value::Array(t), Value::Array(s)) => {
            t.len() == s.len() && t.iter().zip(s.iter()).all(|(t, s)| value_equal(t, s))
        }
        _ => false,
    }
}

fn item_equal(target: &Item, source: &Item) -> bool {
    if let (Some(t), Some(s)) = (target.as_table_like(), source.as_table_like()) {
        return table_equal(t, s);
    }
    if let (Some(t), Some(s)) = (target.as_array_of_tables(), source.as_array_of_tables()) {
        return t.len() == s.len() && t.iter().zip(s.iter()).all(|(t, s)| table_equal(t, s));
    }
    match (target.as_value(), source.as_value()) {
        (Some(t), Some(s)) => value_equal(t, s),
        _ => target.is_none() && source.is_none(),
    }
}

fn merge_table(
    target: &mut dyn TableLike, previous: &dyn TableLike, selected: &dyn TableLike,
    parent: &[String], overrides: &mut Overrides, priority: MergePriority,
) {
    let keys: std::collections::BTreeSet<_> = previous.iter().chain(selected.iter())
        .map(|(key, _)| key.to_owned()).collect();
    for key in keys {
        let path: Vec<_> = parent.iter().cloned().chain(std::iter::once(key.clone())).collect();
        if priority == MergePriority::Current && merge_policy::protected(overrides, &path) { continue; }
        let result = merge_item(target.get(&key), previous.get(&key), selected.get(&key), &path, overrides, priority);
        match result {
            Some(item) => { target.insert(&key, item); }
            None => { target.remove(&key); }
        }
    }
}

fn merge_item(
    current: Option<&Item>, previous: Option<&Item>, selected: Option<&Item>,
    path: &[String], overrides: &mut Overrides, priority: MergePriority,
) -> Option<Item> {
    // 只修改克隆后的表；保留原有注释及格式，不改变输入文档。
    if let Some(current) = current.filter(|item| item.as_table_like().is_some()) {
        if (previous.map_or(true, |item| item.as_table_like().is_some())
            || (priority == MergePriority::Template && selected.is_some()))
            && selected.map_or(true, |item| item.as_table_like().is_some()) {
            let mut result = current.clone();
            let empty = toml_edit::Table::new();
            let table = result.as_table_like_mut()?;
            merge_table(table, previous.and_then(Item::as_table_like).unwrap_or(&empty),
                selected.and_then(Item::as_table_like).unwrap_or(&empty), path, overrides, priority);
            return if table.is_empty() && selected.is_none() { None } else { Some(result) };
        }
    }
    // 通用优先覆盖标量、数组及类型冲突；语义相同时保留当前项的注释与格式。
    if priority == MergePriority::Template {
        if let Some(selected) = selected {
            return Some(current.filter(|item| item_equal(item, selected)).unwrap_or(selected).clone());
        }
    }
    if merge_policy::has_protected_children(overrides, path) {
        merge_policy::preserve(overrides, path);
        return current.cloned();
    }
    let same = |left: Option<&Item>, right: Option<&Item>| match (left, right) {
        (Some(left), Some(right)) => item_equal(left, right),
        (None, None) => true,
        _ => false,
    };
    if same(current, previous) {
        return if same(current, selected) { current.cloned() } else { selected.cloned() };
    }
    if previous.is_none() && same(current, selected) { return current.cloned(); }
    merge_policy::preserve(overrides, path);
    current.cloned()
}

pub fn sync(
    config: &str, previous: Option<&str>, snippet: &str, protected: &[Vec<String>], priority: MergePriority,
) -> Result<(String, Overrides)> {
    let mut result = parse(config)?;
    let original = result.to_string();
    let previous = parse(previous.unwrap_or(""))?;
    let selected = parse(snippet)?;
    // 与 JSON 使用同一优先级规则，切换后不沿用已失效的手动保护路径。
    let mut overrides = if priority == MergePriority::Current { protected.to_vec() } else { Vec::new() };
    merge_table(result.as_table_mut(), previous.as_table(), selected.as_table(), &[], &mut overrides, priority);
    let output = result.to_string();
    Ok((if output == original { config.to_owned() } else { output }, overrides))
}
