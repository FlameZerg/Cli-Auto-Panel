use crate::{
    files,
    model::{ApplyPlan, FileChange, HistoryEntry, PanelState, Result},
    repository::Store,
};
use std::{fs::{self, OpenOptions}, io::Write, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};

fn active(directory: &Path) -> PathBuf { directory.join("pending.json") }

#[derive(Serialize, Deserialize)]
struct CreationClaim {
    operation: String,
    target: PathBuf,
    identity: String,
}

fn claim_path(directory: &Path, operation: &str, target: &Path) -> PathBuf {
    directory.join(format!("claim-{operation}-{}.json", files::hash(target.as_os_str().to_string_lossy().as_bytes())))
}

fn record_claim(directory: &Path, operation: &str, change: &FileChange, file: &std::fs::File) -> Result<()> {
    if change.before.is_some() { return Ok(()); }
    let claim = CreationClaim {
        operation: operation.into(), target: change.path.clone(), identity: files::identity(file, &change.path)?,
    };
    let bytes = serde_json::to_vec(&claim).map_err(|e| e.to_string())?;
    let mut output = OpenOptions::new().write(true).create_new(true)
        .open(claim_path(directory, operation, &change.path))
        .map_err(|e| format!("无法记录新建文件归属，未发布配置：{e}"))?;
    output.write_all(&bytes).and_then(|_| output.sync_all()).map_err(|e| e.to_string())
}

fn load_claim(directory: &Path, operation: &str, target: &Path) -> Result<Option<CreationClaim>> {
    let path = claim_path(directory, operation, target);
    let Some((bytes, _)) = files::read(&path)? else { return Ok(None); };
    let claim: CreationClaim = serde_json::from_slice(&bytes).map_err(|_| "新建文件归属记录已损坏。")?;
    if claim.operation != operation || claim.target != target {
        return Err("新建文件归属记录与恢复目标不一致。".into());
    }
    Ok(Some(claim))
}

fn ensure_created_by_plan(directory: &Path, operation: &str, change: &FileChange) -> Result<()> {
    if change.before.is_some() { return Ok(()); }
    let claim = load_claim(directory, operation, &change.path)?
        .ok_or("无法证明新文件由本次操作创建，拒绝删除可能属于其他程序的文件。")?;
    let (_, identity) = files::read(&change.path)?.ok_or("待恢复的新文件不存在。")?;
    if identity != claim.identity {
        return Err(format!("新文件身份不属于本次操作，拒绝删除碰撞文件：{}", change.path.display()));
    }
    Ok(())
}

fn clean_claims(directory: &Path, plan: &ApplyPlan) -> Result<()> {
    for change in &plan.files {
        if change.before.is_none() && load_claim(directory, &plan.id, &change.path)?.is_some() {
            fs::remove_file(claim_path(directory, &plan.id, &change.path))
                .map_err(|e| format!("无法清理新建文件归属记录：{e}"))?;
        }
    }
    Ok(())
}

pub fn pending(directory: &Path) -> bool { active(directory).exists() }

pub fn read_manifest(path: &Path) -> Result<ApplyPlan> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("无法读取恢复记录：{e}"))?;
    if !metadata.is_file() || files::is_reparse(&metadata) || metadata.len() > 256 * 1024 * 1024 {
        return Err("恢复记录类型或大小不合法。".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|_| "恢复记录已损坏，禁止猜测恢复。".into())
}

pub fn pending_plan(directory: &Path) -> Result<ApplyPlan> {
    read_manifest(&active(directory))
}

pub fn history(directory: &Path, state: &PanelState) -> Result<Vec<HistoryEntry>> {
    let history_dir = directory.join("history");
    if !history_dir.exists() { return Ok(Vec::new()); }
    let metadata = fs::symlink_metadata(&history_dir).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || files::is_reparse(&metadata) {
        return Err("备份目录不是普通目录，拒绝读取其他位置的记录。".into());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(history_dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || files::is_reparse(&metadata) {
            return Err("备份目录中发现非普通文件，停止自动读取。".into());
        }
        candidates.push((metadata.modified().map_err(|e| e.to_string())?, path));
    }
    // 先按元数据截取最近记录，避免每次刷新都读取全部历史配置正文。
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let mut result = Vec::new();
    for (_, path) in candidates.into_iter().take(20) {
        let plan = read_manifest(&path)?;
        result.push(HistoryEntry {
            id: plan.id, label: plan.label, created_at: plan.created_at,
            can_restore: serde_json::to_string(&plan.after_state).map_err(|e| e.to_string())?
                == serde_json::to_string(state).map_err(|e| e.to_string())?,
        });
    }
    result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(result)
}

pub fn backup(directory: &Path, id: &str) -> Result<ApplyPlan> {
    let valid = uuid::Uuid::parse_str(id).map_err(|_| "备份编号无效。")?;
    read_manifest(&directory.join("history").join(format!("{valid}.json")))
}

fn write_pending(directory: &Path, plan: &ApplyPlan) -> Result<()> {
    let bytes = serde_json::to_vec(plan).map_err(|e| e.to_string())?;
    if bytes.len() > 256 * 1024 * 1024 { return Err("单次操作的恢复记录超过安全上限，请缩小操作范围。".into()); }
    let stage = directory.join(format!(".pending-{}.tmp", uuid::Uuid::new_v4()));
    let mut owned_identity = None;
    let result: Result<()> = (|| {
        let mut file = OpenOptions::new().read(true).write(true).create_new(true).open(&stage)
            .map_err(|e| e.to_string())?;
        owned_identity = Some(files::identity(&file, &stage)?);
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        drop(file);
        if active(directory).exists() {
            return Err("发现未完成操作，不能覆盖恢复日志。".into());
        }
        files::rename_new(&stage, &active(directory))
    })();
    if result.is_err() {
        if let Some(owned) = owned_identity {
            if let Some(current) = files::identity_at(&stage)? {
                if current != owned { return Err("日志准备路径已被替换，拒绝删除碰撞文件。".into()); }
                fs::remove_file(&stage).map_err(|e| format!("无法清理日志准备文件：{e}"))?;
            }
        }
    }
    result
}

fn finish(directory: &Path, plan: &ApplyPlan) -> Result<()> {
    let history_dir = directory.join("history");
    fs::create_dir_all(&history_dir).map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(&history_dir).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || files::is_reparse(&metadata) {
        return Err("备份归档目录不是普通目录，保留待恢复记录。".into());
    }
    let target = history_dir.join(format!("{}.json", plan.id));
    if target.exists() { return Err("备份编号冲突，保留恢复记录。".into()); }
    files::rename_new(&active(directory), &target).map_err(|e| format!("无法归档备份，保留恢复状态：{e}"))
}

fn current_content(change: &FileChange) -> Result<Option<String>> {
    Ok(files::read(&change.path)?.map(|(bytes, _)| files::pack(&bytes)))
}

fn apply(directory: &Path, operation: &str, change: &FileChange) -> Result<()> {
    files::verify(change)?;
    if change.before == change.after { return Ok(()); }
    let bytes = change.after.as_deref().map(files::unpack).transpose()?;
    files::replace_tracked(&change.path, bytes.as_deref(), change.before.as_deref(),
        |file| record_claim(directory, operation, change, file))?;
    if current_content(change)? != change.after {
        return Err(format!("落盘后校验失败：{}", change.path.display()));
    }
    Ok(())
}

fn rollback(directory: &Path, store: &mut Store, plan: &ApplyPlan) -> Result<()> {
    // 先检查全部目标；任何未知内容都会阻止回滚，防止覆盖用户新改动。
    for change in &plan.files {
        let current = current_content(change)?;
        if current != change.before && current != change.after {
            return Err(format!("恢复遇到外部改动，必须先人工处理：{}", change.path.display()));
        }
        if current != change.before { ensure_created_by_plan(directory, &plan.id, change)?; }
    }
    let current_state = store.load()?;
    let state_json = serde_json::to_value(&current_state).map_err(|e| e.to_string())?;
    if state_json != serde_json::to_value(&plan.before_state).map_err(|e| e.to_string())?
        && state_json != serde_json::to_value(&plan.after_state).map_err(|e| e.to_string())? {
        return Err("数据库含有未知新状态，停止回滚。".into());
    }
    for change in plan.files.iter().rev() {
        let current = current_content(change)?;
        if current == change.before { continue; }
        if current != change.after { return Err("恢复过程中出现新的外部改动，停止覆盖。".into()); }
        ensure_created_by_plan(directory, &plan.id, change)?;
        let bytes = change.before.as_deref().map(files::unpack).transpose()?;
        files::replace(&change.path, bytes.as_deref(), change.after.as_deref())?;
        if current_content(change)? != change.before {
            return Err("恢复后文件校验失败，保留恢复记录。".into());
        }
    }
    store.replace(&current_state, &plan.before_state)
}

pub fn commit(directory: &Path, store: &mut Store, plan: &ApplyPlan) -> Result<()> {
    if pending(directory) { return Err("请先恢复未完成的操作。".into()); }
    if serde_json::to_value(store.load()?).map_err(|e| e.to_string())?
        != serde_json::to_value(&plan.before_state).map_err(|e| e.to_string())? {
        return Err("面板版本已变化，请重新预览。".into());
    }
    for change in &plan.files { files::verify(change)?; }
    write_pending(directory, plan)?;
    let result: Result<()> = (|| {
        for change in &plan.files { apply(directory, &plan.id, change)?; }
        for change in &plan.files {
            if current_content(change)? != change.after {
                return Err("提交前发现文件再次变化，停止提交。".into());
            }
        }
        store.replace(&plan.before_state, &plan.after_state)?;
        Ok(())
    })();
    if let Err(error) = result {
        return match rollback(directory, store, plan) {
            Ok(()) => {
                clean_claims(directory, plan)?;
                fs::remove_file(active(directory)).map_err(|e| format!("{error}；已回滚，但日志无法清理：{e}"))?;
                Err(format!("{error}；本次操作已回滚。"))
            }
            Err(recovery_error) => Err(format!("{error}；恢复未完成：{recovery_error}")),
        };
    }
    finish(directory, plan)?;
    clean_claims(directory, plan)
}

pub fn recover(directory: &Path, store: &mut Store) -> Result<()> {
    let plan = pending_plan(directory)?;
    let current = store.load()?;
    let committed = serde_json::to_value(&current).map_err(|e| e.to_string())?
        == serde_json::to_value(&plan.after_state).map_err(|e| e.to_string())?;
    let all_after = plan.files.iter().map(current_content)
        .collect::<Result<Vec<_>>>()?.iter().zip(&plan.files).all(|(now, change)| now == &change.after);
    if committed && all_after {
        finish(directory, &plan)?;
        return clean_claims(directory, &plan);
    }
    rollback(directory, store, &plan)?;
    clean_claims(directory, &plan)?;
    fs::remove_file(active(directory)).map_err(|e| format!("恢复成功，但日志无法移除：{e}"))
}
