use crate::{files, model::{FileChange, Paths, Result}};

// 只读基础 config.toml 生成并发守卫；别名配置是独立 Home 的完整副本，
// 省略顶层键时由 Codex 使用内置默认值，不再要求补齐或生成提示。
pub fn inspect_codex(paths: &Paths) -> Result<Option<FileChange>> {
    let Some((bytes, identity)) = files::read(&paths.codex_base)? else {
        return Ok(None);
    };
    let encoded = files::pack(&bytes);
    Ok(Some(FileChange {
        path: paths.codex_base.clone(), before: Some(encoded.clone()), after: Some(encoded),
        before_identity: Some(identity),
    }))
}
