#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use config_core::{Engine, model::*};
use std::sync::Mutex;
use tauri::Manager;

struct Backend(Mutex<Option<Engine>>);

// 阻塞文件操作放入后台线程，不让解析 PowerShell 或磁盘同步冻结窗口。
async fn access<T, F>(app: tauri::AppHandle, action: F) -> std::result::Result<T, String>
where T: Send + 'static, F: FnOnce(&mut Engine) -> std::result::Result<T, String> + Send + 'static {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Backend>();
        let mut guard = state.inner().0.lock().map_err(|_| "后端状态锁异常，请关闭面板后重新打开。")?;
        // 初始化失败不缓存为永久错误，用户修复环境后可以从界面重试。
        if guard.is_none() { *guard = Some(Engine::open()?); }
        let engine = guard.as_mut().ok_or("后端初始化未完成。")?;
        action(engine)
    }).await.map_err(|_| "后端操作异常中断；如已开始写入，请使用恢复入口。".to_string())?
}

#[tauri::command]
async fn bootstrap(app: tauri::AppHandle) -> std::result::Result<Bootstrap, String> {
    access(app, |engine| engine.bootstrap()).await
}

#[tauri::command]
async fn read_config(app: tauri::AppHandle, id: String) -> std::result::Result<Document, String> {
    access(app, move |engine| engine.read_config(&id)).await
}

#[tauri::command]
async fn extract_common(app: tauri::AppHandle, kind: Kind, content: String) -> std::result::Result<Extraction, String> {
    access(app, move |engine| engine.extract(kind, &content)).await
}

#[tauri::command]
async fn apply_shortcut(
    app: tauri::AppHandle, kind: Kind, content: String, key: String, enabled: bool,
) -> std::result::Result<String, String> {
    access(app, move |engine| engine.shortcut(kind, &content, &key, enabled)).await
}

#[tauri::command]
async fn prepare_change(app: tauri::AppHandle, request: ChangeRequest) -> std::result::Result<Preview, String> {
    access(app, move |engine| engine.prepare(request)).await
}

#[tauri::command]
async fn preview_change(app: tauri::AppHandle, show_secrets: bool) -> std::result::Result<Preview, String> {
    access(app, move |engine| engine.preview(show_secrets)).await
}

#[tauri::command]
async fn commit_change(app: tauri::AppHandle, id: String) -> std::result::Result<Bootstrap, String> {
    access(app, move |engine| engine.commit(&id)).await
}

#[tauri::command]
async fn recover_pending(app: tauri::AppHandle) -> std::result::Result<Bootstrap, String> {
    access(app, |engine| engine.recover()).await
}

fn main() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.show() { eprintln!("无法显示已有面板窗口：{error}"); }
                if let Err(error) = window.set_focus() { eprintln!("无法聚焦已有面板窗口：{error}"); }
            }
        }))
        .setup(|app| {
            app.manage(Backend(Mutex::new(None)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap, read_config, extract_common, prepare_change,
            preview_change, commit_change, recover_pending, apply_shortcut
        ])
        .build(tauri::generate_context!());
    if let Err(error) = application.and_then(|app| {
        app.run(|_, _| {});
        Ok(())
    }) {
        // 启动错误只报告程序框架错误，不输出配置内容。
        eprintln!("面板启动失败：{error}");
        std::process::exit(1);
    }
}
