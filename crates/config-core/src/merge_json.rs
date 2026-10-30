use crate::{merge_policy::{self, Overrides}, model::{MergePriority, Result}};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value};
use std::fmt;

struct StrictValue(Value);

// 重复键会使覆盖结果含糊，解析时保留这项格式检查。
impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct JsonVisitor;
        impl<'de> Visitor<'de> for JsonVisitor {
            type Value = StrictValue;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("合法的 JSON 值")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(Value::Number(v.into())))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(Value::Number(v.into())))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Self::Value, E> {
                Number::from_f64(v)
                    .map(|n| StrictValue(Value::Number(n)))
                    .ok_or_else(|| E::custom("不支持非有限数字"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(Value::String(v.to_owned())))
            }
            fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(Value::String(v)))
            }
            fn visit_unit<E: de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(StrictValue(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(v) = a.next_element::<StrictValue>()? {
                    values.push(v.0);
                }
                Ok(StrictValue(Value::Array(values)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Map::new();
                while let Some(key) = a.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom(format!("配置包含重复键：{key}")));
                    }
                    values.insert(key, a.next_value::<StrictValue>()?.0);
                }
                Ok(StrictValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(JsonVisitor)
    }
}

pub fn parse(text: &str) -> Result<Value> {
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let result = StrictValue::deserialize(&mut deserializer)
        .and_then(|value| deserializer.end().map(|_| value.0))
        .map_err(|error| format!("JSON 解析失败：{error}"))?;
    if !result.is_object() {
        return Err("Claude 配置与通用配置必须是 JSON 对象。".into());
    }
    Ok(result)
}

pub fn render(value: &Value) -> Result<String> {
    serde_json::to_string_pretty(value)
        .map(|s| format!("{s}\n"))
        .map_err(|_| "JSON 序列化失败。".into())
}

fn merge_object(
    current: &Map<String, Value>, previous: &Map<String, Value>, selected: &Map<String, Value>,
    parent: &[String], overrides: &mut Overrides, priority: MergePriority,
) -> Map<String, Value> {
    let mut result = current.clone();
    let keys: std::collections::BTreeSet<_> = previous.keys().chain(selected.keys()).collect();
    for key in keys {
        let path: Vec<_> = parent.iter().cloned().chain(std::iter::once(key.clone())).collect();
        if priority == MergePriority::Current && merge_policy::protected(overrides, &path) { continue; }
        let value = merge_value(current.get(key), previous.get(key), selected.get(key), &path, overrides, priority);
        match value {
            Some(value) => { result.insert(key.clone(), value); }
            None => { result.remove(key); }
        }
    }
    result
}

fn merge_value(
    current: Option<&Value>, previous: Option<&Value>, selected: Option<&Value>,
    path: &[String], overrides: &mut Overrides, priority: MergePriority,
) -> Option<Value> {
    // 对象逐键同步；数组视为完整用户值，绝不按子集删除数组中的对象。
    if let Some(current_object) = current.and_then(Value::as_object) {
        if (previous.map_or(true, Value::is_object) || (priority == MergePriority::Template && selected.is_some()))
            && selected.map_or(true, Value::is_object) {
            let empty = Map::new();
            let object = merge_object(current_object,
                previous.and_then(Value::as_object).unwrap_or(&empty),
                selected.and_then(Value::as_object).unwrap_or(&empty), path, overrides, priority);
            return if object.is_empty() && selected.is_none() { None } else { Some(Value::Object(object)) };
        }
    }
    // 通用优先只覆盖模板仍定义的冲突值；对象已逐键处理，数组及类型冲突整体取通用值。
    if priority == MergePriority::Template && selected.is_some() { return selected.cloned(); }
    if merge_policy::has_protected_children(overrides, path) {
        merge_policy::preserve(overrides, path);
        return current.cloned();
    }
    if current == previous {
        return if current == selected { current.cloned() } else { selected.cloned() };
    }
    if previous.is_none() && current == selected { return current.cloned(); }
    // 记录旧字段的手动删除，供当前配置优先模式持续保护。
    merge_policy::preserve(overrides, path);
    current.cloned()
}

pub fn sync(
    config: &str, previous: Option<&str>, snippet: &str, protected: &[Vec<String>], priority: MergePriority,
) -> Result<(String, Overrides)> {
    let current = parse(config)?;
    let previous = previous.filter(|text| !text.trim().is_empty()).map(parse).transpose()?
        .unwrap_or_else(|| Value::Object(Map::new()));
    let selected = if snippet.trim().is_empty() { Value::Object(Map::new()) } else { parse(snippet)? };
    // 通用优先重新计算保护路径，不保留已被通用值覆盖的旧手动记录。
    let mut overrides = if priority == MergePriority::Current { protected.to_vec() } else { Vec::new() };
    let (Value::Object(current_object), Value::Object(previous), Value::Object(selected)) =
        (&current, previous, selected) else { return Err("配置必须是 JSON 对象。".into()); };
    let result = Value::Object(merge_object(current_object, &previous, &selected, &[], &mut overrides, priority));
    // 无语义变化时保留缩进、换行及末尾空白，避免仅切换绑定就重写文件。
    let output = if result == current { config.to_owned() } else { render(&result)? };
    Ok((output, overrides))
}
