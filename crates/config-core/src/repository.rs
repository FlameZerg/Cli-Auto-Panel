use crate::{files, model::{PanelState, Result}, powershell, security};
use fs2::FileExt;
use rusqlite::{params, Connection};
use std::{fs::{self, File, OpenOptions}, path::Path};

pub struct Store {
    connection: Connection,
    _lock: File,
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        fs::create_dir_all(directory).map_err(|e| format!("无法创建面板私有目录：{e}"))?;
        let metadata = fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || files::is_reparse(&metadata) {
            return Err("面板数据目录必须是普通目录，拒绝重解析点。".into());
        }
        let identity = powershell::helper(&serde_json::json!({
            "action": "secureDirectory", "path": directory.to_string_lossy()
        })).map_err(|e| format!("无法保护面板备份目录：{e}"))?;
        let sid = identity.get("sid").and_then(|v| v.as_str()).ok_or("无法取得当前用户安全标识。")?;
        security::initialize(sid.into())?;
        let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true)
            .open(directory.join("instance.lock")).map_err(|e| e.to_string())?;
        lock.try_lock_exclusive().map_err(|_| "另一个面板实例正在管理配置，请使用已有窗口。")?;
        let database = directory.join("panel.sqlite3");
        if let Ok(metadata) = fs::symlink_metadata(&database) {
            if !metadata.is_file() || files::is_reparse(&metadata) {
                return Err("面板数据库不是普通文件，已停止。".into());
            }
        }
        let connection = Connection::open(database).map_err(|e| format!("无法打开面板数据库：{e}"))?;
        connection.execute_batch(
            "PRAGMA synchronous=FULL;
             PRAGMA journal_mode=DELETE;
             CREATE TABLE IF NOT EXISTS panel_state(
                 id INTEGER PRIMARY KEY CHECK(id=1),
                 revision INTEGER NOT NULL,
                 body TEXT NOT NULL
             );"
        ).map_err(|e| format!("无法初始化面板数据库：{e}"))?;
        let initial = serde_json::to_string(&PanelState::default()).map_err(|e| e.to_string())?;
        connection.execute("INSERT OR IGNORE INTO panel_state(id,revision,body) VALUES(1,0,?1)", [initial])
            .map_err(|e| e.to_string())?;
        Ok(Self { connection, _lock: lock })
    }

    pub fn load(&self) -> Result<PanelState> {
        let (revision, body): (u64, String) = self.connection.query_row(
            "SELECT revision, body FROM panel_state WHERE id=1", [],
            |r| Ok((r.get(0)?, r.get(1)?))
        ).map_err(|e| format!("无法读取面板状态：{e}"))?;
        let state: PanelState = serde_json::from_str(&body)
            .map_err(|_| "面板数据库格式无效，不能自动重置或丢弃已有绑定。")?;
        if state.revision != revision {
            return Err("面板数据库版本与内容不一致，已停止写入。".into());
        }
        Ok(state)
    }

    pub fn replace(&mut self, expected: &PanelState, next: &PanelState) -> Result<()> {
        let transaction = self.connection.transaction().map_err(|e| e.to_string())?;
        let current: String = transaction.query_row(
            "SELECT body FROM panel_state WHERE id=1", [], |r| r.get(0)
        ).map_err(|e| e.to_string())?;
        let expected_json = serde_json::to_string(expected).map_err(|e| e.to_string())?;
        if current != expected_json {
            return Err("面板状态已变化，请重新生成操作预览。".into());
        }
        let json = serde_json::to_string(next).map_err(|e| e.to_string())?;
        transaction.execute(
            "UPDATE panel_state SET revision=?1,body=?2 WHERE id=1",
            params![next.revision, json]
        ).map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| format!("无法提交面板状态：{e}"))
    }
}
