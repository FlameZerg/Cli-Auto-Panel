use crate::model::Result;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};

// 只运行内嵌的受限辅助逻辑；用户 profile 始终作为文本输入，绝不执行。
pub fn helper(input: &impl Serialize) -> Result<Value> {
    let shell = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .ok_or("找不到 Windows 系统目录，无法执行受限解析。")?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let encoded: Vec<u8> = include_str!("../scripts/profile_ast.ps1")
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect();
    let mut command = Command::new(shell);
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        &STANDARD.encode(encoded),
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动配置解析辅助程序：{e}"))?;
    let payload = serde_json::to_vec(input).map_err(|e| e.to_string())?;
    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开配置解析输入。".to_string())
        .and_then(|mut pipe| pipe.write_all(&payload).map_err(|e| e.to_string()));
    let output = child
        .wait_with_output()
        .map_err(|e| format!("无法读取配置解析结果：{e}"))?;
    write_result?;
    if !output.status.success() {
        // 辅助错误不回显原始输入，避免凭据通过解析错误泄漏。
        return Err("受限 PowerShell 解析或私有目录权限设置失败，已停止操作。".into());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "辅助程序返回了无效结果，未执行配置修改。".into())
}
