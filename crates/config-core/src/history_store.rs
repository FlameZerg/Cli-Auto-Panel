use crate::{files, journal, model::{ApplyPlan, CreatedFile, HistoryEntry, PanelState, Result}};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::path::Path;

pub(crate) const MAX_RECORD_BYTES: usize = 256 * 1024 * 1024;
const MAX_HISTORY_BYTES: i64 = 256 * 1024 * 1024;
const MAX_ENTRIES: i64 = 20;

pub(crate) fn encode(plan: &ApplyPlan) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(plan).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err("单次恢复记录超过 256 MiB，未执行写入，请缩小操作范围。".into());
    }
    Ok(bytes)
}

pub(crate) fn read(connection: &Connection, id: &str) -> Result<Option<ApplyPlan>> {
    uuid::Uuid::parse_str(id).map_err(|_| "备份编号无效。")?;
    let entry: Option<(Option<Vec<u8>>, String)> = connection.query_row(
        "SELECT CASE WHEN length(body)<=?2 THEN body ELSE NULL END,digest
         FROM operation_history WHERE id=?1", params![id, MAX_RECORD_BYTES as i64],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional().map_err(|e| format!("无法读取备份正文：{e}"))?;
    let Some((bytes, digest)) = entry else { return Ok(None); };
    let bytes = bytes.ok_or("备份正文超过容量上限，禁止读取或恢复。")?;
    if bytes.len() > MAX_RECORD_BYTES || files::hash(&bytes) != digest {
        return Err("备份正文超限或校验失败，禁止恢复。".into());
    }
    let plan: ApplyPlan = serde_json::from_slice(&bytes).map_err(|_| "数据库备份正文损坏。")?;
    if plan.id != id || plan.format_version != 2 {
        return Err("备份编号或格式版本不一致，禁止恢复。".into());
    }
    Ok(Some(plan))
}

pub(crate) fn insert(
    transaction: &Transaction<'_>, plan: &ApplyPlan, bytes: &[u8], created: &[CreatedFile],
) -> Result<()> {
    // 不使用 REPLACE，操作编号冲突必须失败，不能覆盖原有提交证据。
    transaction.execute(
        "INSERT INTO operation_history(id,label,created_at,revision,digest,body,created_files,layout_revision)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![plan.id, plan.label, plan.created_at, plan.after_state.revision, files::hash(bytes), bytes,
            serde_json::to_string(created).map_err(|e| e.to_string())?,
            if plan.layout_snapshot { Some(plan.after_state.layout_revision) } else { None }],
    ).map_err(|e| format!("无法保存操作历史：{e}"))?;
    transaction.execute(
        "DELETE FROM operation_history WHERE id NOT IN(
            SELECT id FROM operation_history ORDER BY sequence DESC LIMIT ?1
         )", [MAX_ENTRIES],
    ).map_err(|e| format!("无法限制历史条数：{e}"))?;
    loop {
        let total: i64 = transaction.query_row(
            "SELECT COALESCE(SUM(length(body)),0) FROM operation_history", [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if total <= MAX_HISTORY_BYTES { break; }
        let removed = transaction.execute(
            "DELETE FROM operation_history WHERE sequence=(
                SELECT sequence FROM operation_history WHERE id<>?1 ORDER BY sequence LIMIT 1
             )", [&plan.id],
        ).map_err(|e| e.to_string())?;
        if removed != 1 { return Err("本次备份无法满足历史容量上限，已停止提交。".into()); }
    }
    Ok(())
}

pub(crate) fn created_identity(connection: &Connection, operation: &str, path: &Path) -> Result<String> {
    let body: String = connection.query_row(
        "SELECT created_files FROM operation_history WHERE id=?1", [operation], |row| row.get(0),
    ).map_err(|e| format!("无法读取新文件归属凭据：{e}"))?;
    let created: Vec<CreatedFile> = serde_json::from_str(&body).map_err(|_| "新文件归属凭据损坏。")?;
    let matches: Vec<_> = created.iter().filter(|entry| entry.path == path).collect();
    if matches.len() != 1 || matches[0].identity.is_empty() {
        return Err("新文件归属凭据缺失或重复，禁止自动删除。".into());
    }
    Ok(matches[0].identity.clone())
}

pub(crate) fn list(connection: &Connection, state: &PanelState) -> Result<Vec<HistoryEntry>> {
    // 列表只读取索引字段；不加载 BLOB，不扫描历史目录或解析配置全文。
    let mut statement = connection.prepare(
        "SELECT id,label,created_at,revision,
            id=(SELECT last_operation FROM config_state WHERE id=1),layout_revision
         FROM operation_history ORDER BY sequence DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = statement.query_map([MAX_ENTRIES], |row| Ok(HistoryEntry {
        id: row.get(0)?, label: row.get(1)?, created_at: row.get(2)?,
        can_restore: row.get::<_, u64>(3)? == state.revision
            && row.get::<_, Option<bool>>(4)?.unwrap_or(false)
            && row.get::<_, Option<u64>>(5)?.map_or(true, |revision| revision == state.layout_revision),
        legacy: false,
    })).map_err(|e| e.to_string())?;
    let mut result = rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    if result.len() < MAX_ENTRIES as usize {
        let head: Option<String> = connection.query_row(
            "SELECT last_operation FROM config_state WHERE id=1", [], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        let mut statement = connection.prepare(
            "SELECT id,label,created_at,revision,eligible FROM legacy_history
             ORDER BY created_at DESC,id LIMIT ?1"
        ).map_err(|e| e.to_string())?;
        let rows = statement.query_map([MAX_ENTRIES - result.len() as i64], |row| Ok(HistoryEntry {
            id: row.get(0)?, label: row.get(1)?, created_at: row.get(2)?,
            can_restore: head.is_none() && state.layout_revision == 0
                && row.get::<_, u64>(3)? == state.revision && row.get::<_, bool>(4)?,
            legacy: true,
        })).map_err(|e| e.to_string())?;
        result.extend(rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?);
    }
    Ok(result)
}

pub(crate) fn legacy_backup(
    connection: &Connection, directory: &Path, state: &PanelState, id: &str,
) -> Result<ApplyPlan> {
    if !list(connection, state)?.iter().any(|entry| entry.id == id && entry.legacy && entry.can_restore) {
        return Err("此旧版备份已不对应当前状态，禁止覆盖后续修改。".into());
    }
    let plan = journal::backup(directory, id)?;
    if plan.id != id || plan.format_version != 1 {
        return Err("旧备份编号或格式与索引不一致。".into());
    }
    Ok(plan)
}
