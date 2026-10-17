use crate::{
    files::{self, Text},
    model::{Alias, AstResult, Kind, Result},
    powershell,
};
use std::path::Path;

const BEGIN: &str = "# >>> CLI 通用配置面板管理的别名";
const END: &str = "# <<< CLI 通用配置面板管理的别名";

pub fn parse(text: &str) -> Result<AstResult> {
    let result = powershell::helper(&serde_json::json!({ "action": "parse", "text": text }))
        .map_err(|e| format!("无法解析 profile 语法结构：{e}"))?;
    serde_json::from_value(result).map_err(|error| format!("profile 语法结构解析失败：{error}"))
}

pub fn read(path: &Path) -> Result<(Text, Vec<u8>, String)> {
    let (bytes, identity) = files::read(path)?.ok_or("指定的 PowerShell profile 不存在。")?;
    let text = Text::decode(&bytes, true)?;
    Ok((text, bytes, identity))
}

pub fn editable(ast: &AstResult, text: &str) -> Result<()> {
    if !ast.errors.is_empty() || !ast.warnings.is_empty() {
        return Err("profile 存在语法错误、动态注册或重复别名，已阻止自动修改；请先手动处理。".into());
    }
    if text.contains("# SIG # Begin signature block") {
        return Err("profile 带有数字签名，自动修改会破坏签名，已停止。".into());
    }
    Ok(())
}

pub fn validate_name(kind: Kind, name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.len() <= 80
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.contains("..")
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')
                || (kind == Kind::Claude && c.is_alphanumeric())
        });
    if !valid {
        return Err("名称须为 1～80 字节的字母、数字、点、短横线或下划线；Claude 也支持中文，不允许连续点或首尾点。".into());
    }
    Ok(())
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn append(text: &str, ast: &AstResult, aliases: &[(String, String, Kind)]) -> Result<String> {
    editable(ast, text)?;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines = Vec::new();
    for (name, path, kind) in aliases {
        if ast.aliases.iter().any(|a| a.name.eq_ignore_ascii_case(name)) {
            return Err(format!("别名已存在，拒绝覆盖：{name}"));
        }
        let line = match kind {
            Kind::Codex => format!("Register-CodexCommand {name} {}", quote(path)),
            Kind::Claude => format!("function {name} {{ claude --settings {} @args }}", quote(path)),
        };
        lines.push(line);
    }
    let block = format!("{}{newline}", lines.join(newline));
    let begin_count = text.matches(BEGIN).count();
    let end_count = text.matches(END).count();
    let updated = match (begin_count, end_count) {
        (0, 0) => format!("{text}{newline}{newline}{BEGIN}{newline}{block}{END}{newline}"),
        (1, 1) => {
            let start = text.find(BEGIN).ok_or("管理区域缺少开始标记。")?;
            let end = text.find(END).ok_or("管理区域缺少结束标记。")?;
            if start >= end || !text[..end].ends_with('\n') {
                return Err("profile 管理区域边界无效，请先手动检查。".into());
            }
            format!("{}{block}{}", &text[..end], &text[end..])
        }
        _ => return Err("profile 存在重复或不完整的管理区域标记。".into()),
    };
    let after = ensure_valid(&updated)?;
    for (name, path, kind) in aliases {
        if !after.aliases.iter().any(|a| &a.name == name && &a.path == path && &a.kind == kind) {
            return Err("新注册未出现在顶层语法结构中，可能存在无效的管理标记，已停止。".into());
        }
    }
    for original in &ast.aliases {
        if !after.aliases.iter().any(|a| a.name == original.name && a.path == original.path && a.kind == original.kind) {
            return Err("生成注册时影响了其他别名，已停止。".into());
        }
    }
    Ok(updated)
}

// PowerShell 的偏移为 UTF-16 码元；转换后再修改 Rust UTF-8 字符串，避免中文错位。
fn byte_offset(text: &str, offset: usize) -> Result<usize> {
    let mut units = 0;
    for (i, c) in text.char_indices() {
        if units == offset {
            return Ok(i);
        }
        units += c.len_utf16();
    }
    if units == offset { Ok(text.len()) } else { Err("profile 字符偏移不合法。".into()) }
}

pub fn remove(text: &str, ast: &AstResult, aliases: &[Alias]) -> Result<String> {
    editable(ast, text)?;
    let mut ranges: Vec<(usize, usize)> = aliases.iter().map(|a| {
        Ok((byte_offset(text, a.start)?, byte_offset(text, a.end)?))
    }).collect::<Result<_>>()?;
    ranges.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    let mut updated = text.to_owned();
    let mut last_start = text.len();
    for (start, end) in ranges {
        if start > end || end > last_start {
            return Err("profile 注册范围重叠，已停止删除。".into());
        }
        updated.replace_range(start..end, "");
        last_start = start;
    }
    let after = ensure_valid(&updated)?;
    if aliases.iter().any(|removed| after.aliases.iter().any(|a| a.name == removed.name)) {
        return Err("别名删除后仍存在对应顶层注册，已停止。".into());
    }
    Ok(updated)
}

fn ensure_valid(text: &str) -> Result<AstResult> {
    let result = parse(text)?;
    if !result.errors.is_empty() || !result.warnings.is_empty() {
        return Err("更新后的 profile 未通过受限语法检查，未写入文件。".into());
    }
    Ok(result)
}
