use crate::model::Result;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperFailure {
    action: String,
    stage: String,
    exception_type: String,
    error_id: String,
    message: String,
    stack_trace: String,
    line: u32,
    hresult: Option<i32>,
    native_code: Option<i32>,
}

fn failure_message(output: &Output) -> String {
    let exit_code = output.status.code().map_or_else(|| "不可用".into(), |code| code.to_string());
    // 正常解析结构化错误；协议之外的错误直接返回完整标准错误。
    let stderr = String::from_utf8_lossy(&output.stderr);
    let metadata = stderr.lines().rev()
        .find_map(|line| line.strip_prefix("CLI_AUTO_PANEL_ERROR:"));
    let Some(metadata) = metadata else {
        return format!("辅助进程失败（退出码 {exit_code}）。\n标准错误：\n{stderr}\n标准输出：\n{}",
            String::from_utf8_lossy(&output.stdout));
    };
    let detail = match serde_json::from_str::<HelperFailure>(metadata) {
        Ok(detail) => detail,
        Err(error) => return format!("辅助进程失败（退出码 {exit_code}），错误元数据解析失败：{error}\n{stderr}"),
    };
    let action = match detail.action.as_str() {
        "parse" => "解析 PowerShell 配置",
        _ => "辅助操作",
    };
    let stage = match detail.stage.as_str() {
        "initialize_io" => "初始化 UTF-8 管道",
        "read_request" => "读取请求",
        "validate_request" => "验证请求",
        "parse_profile" => "解析配置语法",
        "serialize_result" => "返回结果",
        _ => "未知阶段",
    };
    let mut message = format!("{action}失败：阶段={stage}；异常={}；错误标识={}；辅助脚本第 {} 行；退出码={exit_code}",
        detail.exception_type, detail.error_id, detail.line);
    if let Some(code) = detail.hresult { message.push_str(&format!("；HRESULT=0x{:08X}", code as u32)); }
    if let Some(code) = detail.native_code { message.push_str(&format!("；Win32={code}")); }
    message.push_str(&format!("\n{}", detail.message));
    if !detail.stack_trace.is_empty() { message.push_str(&format!("\n{}", detail.stack_trace)); }
    message
}

// 用户 profile 作为解析输入；辅助脚本不执行其中的命令。
pub fn helper(input: &impl Serialize) -> Result<Value> {
    let shell = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .ok_or("找不到 Windows 系统目录，无法解析配置。")?
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
    if !output.status.success() {
        // 优先返回子进程原因，避免断管错误遮住根因。
        return Err(failure_message(&output));
    }
    write_result.map_err(|error| format!("辅助输入传输失败：{error}"))?;
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("辅助结果解析失败：{error}\n标准输出：\n{}",
            String::from_utf8_lossy(&output.stdout)))
}
