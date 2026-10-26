use crate::{
    files, history_store, state,
    model::{ApplyPlan, CreatedFile, FileChange, FileGuard, HistoryEntry, PanelState, Result},
    repository::Store,
};
use std::{fs::{self, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}};
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

// 只有明确的 NotFound 才表示没有日志；权限和 IO 错误必须阻止迁移及新写入。
pub fn pending(directory: &Path) -> Result<bool> {
    match fs::symlink_metadata(active(directory)) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法确认未完成操作日志是否存在，已停止写入：{error}")),
    }
}

pub fn read_manifest(path: &Path) -> Result<ApplyPlan> {
    serde_json::from_slice(&manifest_bytes(path)?)
        .map_err(|_| "恢复记录已损坏，禁止猜测恢复。".into())
}

fn manifest_bytes(path: &Path) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("无法读取恢复记录：{e}"))?;
    if !metadata.is_file() || files::is_reparse(&metadata)
        || metadata.len() > history_store::MAX_RECORD_BYTES as u64 {
        return Err("恢复记录类型或大小不合法。".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|e| e.to_string())?
        .take(history_store::MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() > history_store::MAX_RECORD_BYTES {
        return Err("读取过程中恢复记录超过容量上限。".into());
    }
    Ok(bytes)
}

pub fn pending_plan(directory: &Path) -> Result<ApplyPlan> {
    read_manifest(&active(directory))
}

pub fn history(directory: &Path, state: &PanelState) -> Result<Vec<HistoryEntry>> {
    let history_dir = directory.join("history");
    let metadata = match fs::symlink_metadata(&history_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法检查旧备份目录，禁止将读取失败视为空历史：{error}")),
    };
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
        if plan.format_version != 1 {
            return Err("旧备份目录含有不支持的记录格式，禁止猜测迁移。".into());
        }
        uuid::Uuid::parse_str(&plan.id).map_err(|_| "历史备份编号不合法。")?;
        if path.file_stem().and_then(|name| name.to_str()) != Some(plan.id.as_str()) {
            return Err("历史备份的文件名与操作编号不一致，停止索引。".into());
        }
        result.push(HistoryEntry {
            id: plan.id, label: plan.label, created_at: plan.created_at,
            can_restore: serde_json::to_string(&plan.after_state).map_err(|e| e.to_string())?
                == serde_json::to_string(state).map_err(|e| e.to_string())?,
            legacy: true,
        });
    }
    result.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(result)
}

pub fn backup(directory: &Path, id: &str) -> Result<ApplyPlan> {
    let valid = uuid::Uuid::parse_str(id).map_err(|_| "备份编号无效。")?;
    read_manifest(&directory.join("history").join(format!("{valid}.json")))
}

fn write_pending(directory: &Path, bytes: &[u8]) -> Result<()> {
    let stage = directory.join(format!(".pending-{}.tmp", uuid::Uuid::new_v4()));
    let mut owned_identity = None;
    let result: Result<()> = (|| {
        let mut file = OpenOptions::new().read(true).write(true).create_new(true).open(&stage)
            .map_err(|e| e.to_string())?;
        owned_identity = Some(files::identity(&file, &stage)?);
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
        drop(file);
        if pending(directory)? {
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

pub(crate) fn verify_guard(guard: &FileGuard) -> Result<()> {
    let current = files::read(&guard.path)?;
    if current.as_ref().map(|(bytes, _)| files::hash(bytes)) != guard.hash
        || current.as_ref().map(|(_, identity)| identity.clone()) != guard.identity {
        return Err(format!("只读依赖已被外部修改或替换，请刷新：{}", guard.path.display()));
    }
    Ok(())
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
    let before_json = serde_json::to_value(&plan.before_state).map_err(|e| e.to_string())?;
    let after_json = serde_json::to_value(&plan.after_state).map_err(|e| e.to_string())?;
    if (!store.is_legacy() && state_json != before_json)
        || (store.is_legacy() && state_json != before_json && state_json != after_json) {
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
    if store.is_legacy() {
        store.replace(&current_state, &plan.before_state)
    } else if state::same_business(&current_state, &plan.before_state)?
        && state::same_layout(&current_state, &plan.before_state)? {
        // 新版数据库提交前失败时状态尚未改变，不再制造一次无意义的数据库重写。
        Ok(())
    } else { Err("业务状态不是本次操作的提交前状态，禁止回退未知修改。".into()) }
}

pub fn commit(directory: &Path, store: &mut Store, plan: &ApplyPlan) -> Result<Option<String>> {
    if pending(directory)? { return Err("请先恢复未完成的操作。".into()); }
    if serde_json::to_value(store.load()?).map_err(|e| e.to_string())?
        != serde_json::to_value(&plan.before_state).map_err(|e| e.to_string())? {
        return Err("面板版本已变化，请重新生成操作计划。".into());
    }
    for change in &plan.files { files::verify(change)?; }
    for guard in &plan.guards { verify_guard(guard)?; }
    // 容量与序列化在真实文件发生变化前验证，不能写完配置才发现历史无法保存。
    let bytes = history_store::encode(plan)?;
    if plan.files.is_empty() {
        return match store.commit_plan(plan, &bytes, &[]) {
            Ok(()) => Ok(None),
            Err(error) => match store.committed(plan) {
                Ok(true) => Ok(Some(format!("操作已提交，数据库返回异常：{error}"))),
                Ok(false) => Err(error),
                Err(check) => Err(format!("{error}；提交结果无法确认，操作编号 {}：{check}", plan.id)),
            },
        };
    }
    write_pending(directory, &bytes)?;
    let result: Result<()> = (|| {
        for change in &plan.files { apply(directory, &plan.id, change)?; }
        for change in &plan.files {
            if current_content(change)? != change.after {
                return Err("提交前发现文件再次变化，停止提交。".into());
            }
        }
        for guard in &plan.guards { verify_guard(guard)?; }
        let mut created = Vec::new();
        for change in &plan.files {
            if change.before.is_none() && change.after.is_some() {
                ensure_created_by_plan(directory, &plan.id, change)?;
                let claim = load_claim(directory, &plan.id, &change.path)?
                    .ok_or("新文件归属凭据缺失，已停止提交。")?;
                created.push(CreatedFile { path: claim.target, identity: claim.identity });
            }
        }
        store.commit_plan(plan, &bytes, &created)?;
        Ok(())
    })();
    if let Err(error) = result {
        // COMMIT 报错不等于确定未提交；必须先读取持久凭据，再决定是否允许回滚。
        match store.committed(plan) {
            Ok(true) => return Ok(Some(format!("操作已提交，保留恢复日志供清理：{error}"))),
            Ok(false) => {}
            Err(check) => return Err(format!("{error}；提交结果无法确认，保留恢复日志：{check}")),
        }
        return match rollback(directory, store, plan) {
            Ok(()) => {
                clean_completed(directory, plan)
                    .map_err(|e| format!("{error}；已回滚，但日志无法清理：{e}"))?;
                Err(format!("{error}；本次操作已回滚。"))
            }
            Err(recovery_error) => Err(format!("{error}；恢复未完成：{recovery_error}")),
        };
    }
    Ok(clean_completed(directory, plan).err())
}

fn clean_completed(directory: &Path, plan: &ApplyPlan) -> Result<()> {
    // 新版日志使用同一份序列化字节写入，清理时无需再解析整份配置正文。
    if manifest_bytes(&active(directory))? != history_store::encode(plan)? {
        return Err("待清理日志已被替换，拒绝删除其他操作的记录。".into());
    }
    // 校验日志后先清理归属旁证，最后清理 pending；失败仍可再次执行同一清理。
    clean_claims(directory, plan)?;
    fs::remove_file(active(directory)).map_err(|e| format!("操作已处理，但恢复日志清理失败：{e}"))
}

pub fn recover(directory: &Path, store: &mut Store) -> Result<()> {
    let plan = pending_plan(directory)?;
    if plan.format_version == 1 && store.is_legacy() { return recover_legacy(directory, store); }
    if plan.format_version != 2 || store.is_legacy() {
        return Err("恢复日志与数据库版本不匹配，禁止猜测恢复。".into());
    }
    if store.committed(&plan)? {
        for change in &plan.files {
            if current_content(change)? != change.after {
                return Err("操作已提交，但文件出现外部改动；保留日志，禁止自动回滚或覆盖。".into());
            }
        }
        return clean_completed(directory, &plan);
    }
    rollback(directory, store, &plan)?;
    clean_completed(directory, &plan)
}

fn recover_legacy(directory: &Path, store: &mut Store) -> Result<()> {
    let plan = pending_plan(directory)?;
    let current = store.load()?;
    let committed = serde_json::to_value(&current).map_err(|e| e.to_string())?
        == serde_json::to_value(&plan.after_state).map_err(|e| e.to_string())?;
    let all_after = plan.files.iter().map(current_content)
        .collect::<Result<Vec<_>>>()?.iter().zip(&plan.files).all(|(now, change)| now == &change.after);
    // 旧格式也以已提交状态为界：文件后续变化只能报冲突，不能回滚其他已提交文件。
    if committed {
        if !all_after {
            return Err("旧版操作已提交，但文件出现外部改动；保留日志，禁止自动回滚或覆盖。".into());
        }
        finish(directory, &plan)?;
        return clean_claims(directory, &plan);
    }
    rollback(directory, store, &plan)?;
    clean_claims(directory, &plan)?;
    fs::remove_file(active(directory)).map_err(|e| format!("恢复成功，但日志无法移除：{e}"))
}
