use crate::{journal, model::{PanelState, Result}, state};
use rusqlite::{params, Connection};
use std::path::Path;

pub(crate) const VERSION: u32 = 2;

pub(crate) fn version(connection: &Connection) -> Result<u32> {
    connection.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| format!("无法读取数据库版本：{e}"))
}

pub(crate) fn load_legacy(connection: &Connection) -> Result<PanelState> {
    let (revision, body): (u64, String) = connection.query_row(
        "SELECT revision,body FROM panel_state WHERE id=1", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| format!("无法读取旧面板状态：{e}"))?;
    let state: PanelState = serde_json::from_str(&body)
        .map_err(|_| "旧数据库内容损坏，禁止自动迁移或重置。")?;
    if state.revision != revision { return Err("旧数据库版本与正文不一致。".into()); }
    Ok(state)
}

pub(crate) fn initialize(connection: &mut Connection, directory: &Path) -> Result<bool> {
    let version = version(connection)?;
    if version == VERSION {
        let objects: u32 = connection.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE
             (type='table' AND name IN(
                'panel_state','config_state','panel_layout','operation_history','legacy_history'
             )) OR (type='trigger' AND name IN(
                'panel_state_frozen_insert','panel_state_frozen_update','panel_state_frozen_delete'
             ))", [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if objects != 8 { return Err("新版存储结构或旧版写入门禁缺失，禁止继续使用。".into()); }
        return Ok(false);
    }
    if version != 0 { return Err(format!("不支持数据库版本 {version}，禁止降级或猜测迁移。")); }
    let has_pending = journal::pending(directory)?;
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='panel_state')",
        [], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if !exists {
        if has_pending {
            return Err("存在未完成操作但旧状态表缺失，禁止创建空状态或猜测恢复。".into());
        }
        let occupied: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%')",
            [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if occupied { return Err("数据库含有未知结构，禁止创建空状态覆盖已有数据。".into()); }
        let initial = serde_json::to_string(&PanelState::default()).map_err(|e| e.to_string())?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        transaction.execute_batch(
            "CREATE TABLE panel_state(
                id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL
             );"
        ).map_err(|e| format!("无法初始化旧状态入口：{e}"))?;
        transaction.execute("INSERT INTO panel_state VALUES(1,0,?1)", [initial])
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
    }
    let previous = load_legacy(connection)?;
    // 未完成的旧操作必须先用旧状态和旧日志恢复，不能在恢复中途拆分状态。
    if has_pending { return Ok(true); }
    let history = journal::history(directory, &previous)?;
    let layout = state::LayoutState {
        template_order: previous.templates.iter().map(|template| template.id.clone()).collect(),
        ..state::layout(&previous)
    };
    let business = serde_json::to_string(&state::business(&previous)).map_err(|e| e.to_string())?;
    let layout_body = serde_json::to_string(&layout).map_err(|e| e.to_string())?;
    let transaction = connection.transaction().map_err(|e| e.to_string())?;
    transaction.execute_batch(
        "CREATE TABLE config_state(
            id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,
            body TEXT NOT NULL,last_operation TEXT
         );
         CREATE TABLE panel_layout(
            id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL
         );
         CREATE TABLE operation_history(
            sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,label TEXT NOT NULL,
            created_at TEXT NOT NULL,revision INTEGER NOT NULL,
            digest TEXT NOT NULL,body BLOB NOT NULL,created_files TEXT NOT NULL,layout_revision INTEGER
         );
         CREATE TABLE legacy_history(
            id TEXT PRIMARY KEY,label TEXT NOT NULL,created_at TEXT NOT NULL,
            revision INTEGER NOT NULL,eligible INTEGER NOT NULL
         );
         CREATE TRIGGER panel_state_frozen_insert BEFORE INSERT ON panel_state
         BEGIN SELECT RAISE(ABORT,'数据库已升级，请使用新版面板'); END;
         CREATE TRIGGER panel_state_frozen_update BEFORE UPDATE ON panel_state
         BEGIN SELECT RAISE(ABORT,'数据库已升级，请使用新版面板'); END;
         CREATE TRIGGER panel_state_frozen_delete BEFORE DELETE ON panel_state
         BEGIN SELECT RAISE(ABORT,'数据库已升级，请使用新版面板'); END;"
    ).map_err(|e| format!("无法建立新版存储结构，迁移已取消：{e}"))?;
    transaction.execute("INSERT INTO config_state VALUES(1,?1,?2,NULL)",
        params![previous.revision, business]).map_err(|e| e.to_string())?;
    transaction.execute("INSERT INTO panel_layout VALUES(1,?1,?2)",
        params![layout.revision, layout_body]).map_err(|e| e.to_string())?;
    for entry in history {
        // 旧正文留在原目录，只建立一次索引；只保留原先确实可恢复的资格。
        transaction.execute("INSERT INTO legacy_history VALUES(?1,?2,?3,?4,?5)",
            params![entry.id, entry.label, entry.created_at, previous.revision, entry.can_restore])
            .map_err(|e| format!("无法索引旧备份，迁移已取消：{e}"))?;
    }
    transaction.pragma_update(None, "user_version", VERSION).map_err(|e| e.to_string())?;
    // 旧 panel_state 完整保留并冻结；迁移失败时整个结构事务回滚。
    transaction.commit().map_err(|e| format!("无法提交数据库迁移：{e}"))?;
    Ok(false)
}
