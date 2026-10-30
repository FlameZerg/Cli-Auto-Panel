use crate::{files, history_store, journal, model::*, state, storage_schema};
use fs2::FileExt;
use rusqlite::{params, Connection};
use std::{fs::{self, File, OpenOptions}, path::Path};

pub struct Store {
    connection: Connection,
    _lock: File,
    legacy: bool,
}

impl Store {
    pub fn open(directory: &Path) -> Result<Self> {
        // 数据目录使用系统默认权限，不再执行额外的 ACL 或 SID 初始化。
        fs::create_dir_all(directory).map_err(|e| format!("无法创建面板数据目录：{e}"))?;
        let metadata = fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
        if !metadata.is_dir() || files::is_reparse(&metadata) {
            return Err("面板数据目录必须是普通目录，拒绝重解析点。".into());
        }
        let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true)
            .open(directory.join("instance.lock")).map_err(|e| e.to_string())?;
        lock.try_lock_exclusive().map_err(|_| "另一个面板实例正在管理配置，请使用已有窗口。")?;
        let database = directory.join("panel.sqlite3");
        if let Ok(metadata) = fs::symlink_metadata(&database) {
            if !metadata.is_file() || files::is_reparse(&metadata) {
                return Err("面板数据库不是普通文件，已停止。".into());
            }
        }
        let mut connection = Connection::open(database).map_err(|e| format!("无法打开面板数据库：{e}"))?;
        let version = storage_schema::version(&connection)?;
        if version != 0 && version != storage_schema::VERSION {
            return Err(format!("不支持数据库版本 {version}，禁止修改其日志模式或状态。"));
        }
        connection.execute_batch(
            "PRAGMA synchronous=FULL;
             PRAGMA journal_mode=DELETE;"
        ).map_err(|e| format!("无法初始化面板数据库：{e}"))?;
        let legacy = storage_schema::initialize(&mut connection, directory)?;
        Ok(Self { connection, _lock: lock, legacy })
    }

    pub fn is_legacy(&self) -> bool { self.legacy }

    pub fn migrate_if_ready(&mut self, directory: &Path) -> Result<()> {
        if self.legacy {
            self.legacy = storage_schema::initialize(&mut self.connection, directory)?;
        }
        Ok(())
    }

    pub fn load(&self) -> Result<PanelState> {
        if !self.connection.is_autocommit() {
            return Err("数据库事务尚未结束，不能把临时状态作为已提交状态读取。".into());
        }
        if self.legacy { storage_schema::load_legacy(&self.connection) }
        else { load_current(&self.connection) }
    }

    pub fn replace(&mut self, expected: &PanelState, next: &PanelState) -> Result<()> {
        if !self.legacy { return Err("新版业务状态只能与操作历史一起提交。".into()); }
        let transaction = self.connection.transaction().map_err(|e| e.to_string())?;
        let (revision, body): (u64, String) = transaction.query_row(
            "SELECT revision, body FROM panel_state WHERE id=1", [],
            |r| Ok((r.get(0)?, r.get(1)?))
        ).map_err(|e| e.to_string())?;
        // 先按当前模型补齐旧版缺省字段，再比较状态，避免序列化格式差异阻断保存或恢复。
        let current: PanelState = serde_json::from_str(&body)
            .map_err(|_| "面板数据库格式无效，不能自动重置或丢弃已有绑定。")?;
        if current.revision != revision {
            return Err("面板数据库版本与内容不一致，已停止写入。".into());
        }
        if serde_json::to_value(&current).map_err(|e| e.to_string())?
            != serde_json::to_value(expected).map_err(|e| e.to_string())? {
            return Err("面板状态已变化，请重新生成操作计划。".into());
        }
        let json = serde_json::to_string(next).map_err(|e| e.to_string())?;
        transaction.execute(
            "UPDATE panel_state SET revision=?1,body=?2 WHERE id=1",
            params![next.revision, json]
        ).map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| format!("无法提交面板状态：{e}"))
    }

    pub fn history(&self, directory: &Path, current: &PanelState) -> Result<Vec<HistoryEntry>> {
        if self.legacy { journal::history(directory, current) }
        else { history_store::list(&self.connection, current) }
    }

    pub fn backup(&self, directory: &Path, id: &str) -> Result<ApplyPlan> {
        if self.legacy { return journal::backup(directory, id); }
        match history_store::read(&self.connection, id)? {
            Some(plan) => {
                if !self.current_operation(id)? {
                    return Err("只能撤销当前业务状态对应的最近操作，禁止恢复旧记录覆盖后续修改。".into());
                }
                Ok(plan)
            }
            None => history_store::legacy_backup(&self.connection, directory, &self.load()?, id),
        }
    }

    pub fn created_identity(&self, operation: &str, path: &Path) -> Result<String> {
        history_store::created_identity(&self.connection, operation, path)
    }

    pub fn current_operation(&self, id: &str) -> Result<bool> {
        if self.legacy { return Ok(false); }
        let head: Option<String> = self.connection.query_row(
            "SELECT last_operation FROM config_state WHERE id=1", [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        Ok(head.as_deref() == Some(id))
    }

    pub fn committed(&self, plan: &ApplyPlan) -> Result<bool> {
        if !self.connection.is_autocommit() {
            return Err("数据库事务尚未结束，无法确认持久化提交，已停止自动恢复。".into());
        }
        let saved = history_store::read(&self.connection, &plan.id)?;
        let Some(saved) = saved else {
            if self.current_operation(&plan.id)? {
                return Err("提交标记存在但历史正文缺失，保留恢复证据并停止写入。".into());
            }
            return Ok(false);
        };
        if !self.current_operation(&plan.id)?
            || history_store::encode(&saved)? != history_store::encode(plan)?
            || !state::same_business(&self.load()?, &plan.after_state)? {
            return Err("操作编号、提交正文或当前业务状态冲突，禁止猜测恢复。".into());
        }
        Ok(true)
    }

    pub fn save_layout(&mut self, expected: &PanelState, next: &PanelState) -> Result<()> {
        if self.legacy { return Err("请先处理旧版未完成操作。".into()); }
        let transaction = self.connection.transaction().map_err(|e| e.to_string())?;
        let current = load_current(&transaction)?;
        ensure_expected(&current, expected)?;
        if !state::same_business(expected, next)? {
            return Err("布局操作试图修改业务状态，已拒绝。".into());
        }
        write_layout(&transaction, next)?;
        transaction.commit().map_err(|e| format!("无法保存布局：{e}"))
    }

    pub fn commit_plan(&mut self, plan: &ApplyPlan, bytes: &[u8], created: &[CreatedFile]) -> Result<()> {
        if self.legacy || plan.format_version != 2 {
            return Err("存储版本不支持此提交，请先完成旧操作恢复。".into());
        }
        if self.committed(plan)? { return Ok(()); }
        let transaction = self.connection.transaction().map_err(|e| e.to_string())?;
        ensure_expected(&load_current(&transaction)?, &plan.before_state)?;
        let body = serde_json::to_string(&state::business(&plan.after_state)).map_err(|e| e.to_string())?;
        transaction.execute(
            "UPDATE config_state SET revision=?1,body=?2,last_operation=?3 WHERE id=1",
            params![plan.after_state.revision, body, plan.id],
        ).map_err(|e| e.to_string())?;
        if !state::same_layout(&plan.before_state, &plan.after_state)? {
            write_layout(&transaction, &plan.after_state)?;
        }
        // 状态、布局联动、历史正文与提交凭据只有一个数据库提交点。
        history_store::insert(&transaction, plan, bytes, created)?;
        transaction.commit().map_err(|e| format!("无法提交业务状态与操作历史：{e}"))
    }
}

fn load_current(connection: &Connection) -> Result<PanelState> {
    let (revision, body): (u64, String) = connection.query_row(
        "SELECT revision,body FROM config_state WHERE id=1", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| format!("无法读取业务状态：{e}"))?;
    let business: PanelState = serde_json::from_str(&body).map_err(|_| "业务状态正文损坏。")?;
    let (layout_revision, layout_body): (u64, String) = connection.query_row(
        "SELECT revision,body FROM panel_layout WHERE id=1", [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|e| format!("无法读取布局状态：{e}"))?;
    let layout: state::LayoutState = serde_json::from_str(&layout_body).map_err(|_| "布局状态正文损坏。")?;
    if business.revision != revision || layout.revision != layout_revision {
        return Err("数据库版本与正文不一致，禁止写入或自动重置。".into());
    }
    if business.layout_revision != 0 || !business.config_order.is_empty()
        || !business.template_order.is_empty() || !business.config_groups.is_empty() {
        return Err("业务正文混入布局数据，禁止静默覆盖或猜测修复。".into());
    }
    Ok(state::compose(&business, &layout))
}

fn ensure_expected(current: &PanelState, expected: &PanelState) -> Result<()> {
    if !state::same_business(current, expected)?
        || current.layout_revision != expected.layout_revision
        || !state::same_layout(current, expected)? {
        return Err("业务或布局状态已变化，请刷新后重新操作。".into());
    }
    Ok(())
}

fn write_layout(connection: &Connection, next: &PanelState) -> Result<()> {
    let layout = state::layout(next);
    let body = serde_json::to_string(&layout).map_err(|e| e.to_string())?;
    connection.execute("UPDATE panel_layout SET revision=?1,body=?2 WHERE id=1",
        params![layout.revision, body]).map_err(|e| format!("无法保存布局正文：{e}"))?;
    Ok(())
}
