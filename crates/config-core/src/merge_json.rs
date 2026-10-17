use crate::model::Result;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value};
use std::fmt;

struct StrictValue(Value);

// 同时拒绝重复键和原型污染键，避免解析器或前后端采用不同的解释。
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
                    if matches!(key.as_str(), "__proto__" | "constructor" | "prototype") {
                        return Err(de::Error::custom("配置包含禁止的合并键"));
                    }
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("配置包含重复键"));
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
        .map_err(|e| format!("JSON 格式、重复键或安全键校验失败：第 {} 行，第 {} 列。", e.line(), e.column()))?;
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

fn merge(target: &mut Value, source: &Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (key, value) in source {
            match target.get_mut(key) {
                Some(current) => merge(current, value),
                None => {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
    } else {
        *target = source.clone();
    }
}

fn subset(target: &Value, source: &Value) -> bool {
    match (target, source) {
        (Value::Object(target), Value::Object(source)) => source
            .iter()
            .all(|(key, value)| target.get(key).is_some_and(|v| subset(v, value))),
        (Value::Array(target), Value::Array(source)) => {
            let mut matched = vec![false; target.len()];
            source.iter().all(|value| {
                let found = target.iter().enumerate().position(|(i, v)| !matched[i] && subset(v, value));
                if let Some(i) = found {
                    matched[i] = true;
                    true
                } else {
                    false
                }
            })
        }
        _ => target == source,
    }
}

fn remove(target: &mut Value, source: &Value) {
    let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) else {
        return;
    };
    for (key, value) in source {
        let delete = match target.get_mut(key) {
            Some(current) if current.is_object() && value.is_object() => {
                remove(current, value);
                current.as_object().is_some_and(Map::is_empty)
            }
            Some(Value::Array(current)) if value.is_array() => {
                for item in value.as_array().into_iter().flatten() {
                    if let Some(i) = current.iter().position(|v| subset(v, item)) {
                        current.remove(i);
                    }
                }
                current.is_empty()
            }
            Some(current) => subset(current, value),
            None => false,
        };
        if delete {
            target.remove(key);
        }
    }
}

pub fn apply(config: &str, snippet: &str) -> Result<String> {
    let mut target = parse(config)?;
    if !snippet.trim().is_empty() {
        merge(&mut target, &parse(snippet)?);
    }
    render(&target)
}

pub fn strip(config: &str, snippet: &str) -> Result<String> {
    let mut target = parse(config)?;
    if !snippet.trim().is_empty() {
        remove(&mut target, &parse(snippet)?);
    }
    render(&target)
}
