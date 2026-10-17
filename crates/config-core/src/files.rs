use crate::{model::{FileChange, Result}, security};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub const MAX_BYTES: u64 = 4 * 1024 * 1024;

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn pack(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn unpack(value: &str) -> Result<Vec<u8>> {
    STANDARD.decode(value).map_err(|_| "备份字节编码损坏，停止恢复。".into())
}

pub fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

pub fn identity(file: &File, path: &Path) -> Result<String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) };
        if ok == 0 {
            return Err(format!("无法确认文件身份：{}", path.display()));
        }
        if info.nNumberOfLinks > 1 {
            return Err(format!("文件存在多个硬链接，原子替换可能拆分引用，已禁止管理：{}", path.display()));
        }
        Ok(format!("{}:{}:{}", info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow))
    }
    #[cfg(not(windows))]
    {
        let _ = file;
        Ok(path.to_string_lossy().to_lowercase())
    }
}

pub fn read(path: &Path) -> Result<Option<(Vec<u8>, String)>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("无法检查文件 {}：{e}", path.display())),
    };
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(format!("目标不是普通文件，拒绝读取或覆盖：{}", path.display()));
    }
    if metadata.len() > MAX_BYTES {
        return Err(format!("文件超过 4 MiB 安全上限：{}", path.display()));
    }
    let mut file = File::open(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    let file_identity = identity(&file, path)?;
    let mut bytes = Vec::new();
    (&mut file).take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("读取过程中配置文件超过大小限制。".into());
    }
    Ok(Some((bytes, file_identity)))
}

pub fn identity_at(path: &Path) -> Result<Option<String>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err("待清理路径已不是普通文件，拒绝清理。".into());
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    identity(&file, path).map(Some)
}

#[derive(Clone, Copy)]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

pub struct Text {
    pub value: String,
    encoding: Encoding,
    crlf: bool,
}

impl Text {
    pub fn decode(bytes: &[u8], profile: bool) -> Result<Self> {
        let (encoding, content) = if bytes.starts_with(&[0xff, 0xfe]) {
            (Encoding::Utf16Le, &bytes[2..])
        } else if bytes.starts_with(&[0xfe, 0xff]) {
            (Encoding::Utf16Be, &bytes[2..])
        } else if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
            (Encoding::Utf8Bom, &bytes[3..])
        } else {
            (Encoding::Utf8, bytes)
        };
        let value = match encoding {
            Encoding::Utf16Le | Encoding::Utf16Be => {
                if !profile || content.len() % 2 != 0 {
                    return Err("配置必须为 UTF-8；profile 的 UTF-16 编码也必须完整。".into());
                }
                let words: Vec<u16> = content.chunks_exact(2).map(|b| {
                    if matches!(encoding, Encoding::Utf16Le) {
                        u16::from_le_bytes([b[0], b[1]])
                    } else {
                        u16::from_be_bytes([b[0], b[1]])
                    }
                }).collect();
                String::from_utf16(&words).map_err(|_| "profile UTF-16 编码无效。")?
            }
            _ => String::from_utf8(content.to_vec())
                .map_err(|_| "文件不是有效 UTF-8；不会猜测编码后覆盖。")?,
        };
        let crlf = value.contains("\r\n");
        Ok(Self { value, encoding, crlf })
    }

    pub fn encode(&self, value: &str) -> Vec<u8> {
        let normalized = value.replace("\r\n", "\n");
        let text = if self.crlf { normalized.replace('\n', "\r\n") } else { normalized };
        self.encode_exact(&text)
    }

    // profile 使用原样编码，避免把未修改区域中的混合换行一并重写。
    pub fn encode_exact(&self, text: &str) -> Vec<u8> {
        match self.encoding {
            Encoding::Utf8 => text.as_bytes().to_vec(),
            Encoding::Utf8Bom => [vec![0xef, 0xbb, 0xbf], text.as_bytes().to_vec()].concat(),
            Encoding::Utf16Le => [vec![0xff, 0xfe], text.encode_utf16().flat_map(u16::to_le_bytes).collect()].concat(),
            Encoding::Utf16Be => [vec![0xfe, 0xff], text.encode_utf16().flat_map(u16::to_be_bytes).collect()].concat(),
        }
    }
}

pub fn ensure_parent(path: &Path) -> Result<()> {
    let parent = path.parent().ok_or("文件没有有效父目录。")?;
    if !parent.is_dir() {
        return Err(format!("目标目录不存在，请先手动创建：{}", parent.display()));
    }
    Ok(())
}

pub fn capture(path: &Path, after: Option<Vec<u8>>) -> Result<FileChange> {
    ensure_parent(path)?;
    let current = read(path)?;
    Ok(FileChange {
        path: path.to_owned(),
        before: current.as_ref().map(|(b, _)| pack(b)),
        after: after.as_deref().map(pack),
        before_identity: current.map(|(_, identity)| identity),
    })
}

pub fn verify(change: &FileChange) -> Result<()> {
    let current = read(&change.path)?;
    if current.as_ref().map(|(b, _)| pack(b)) != change.before
        || current.as_ref().map(|(_, identity)| identity.clone()) != change.before_identity
    {
        return Err(format!("文件在预览后被外部修改或替换，请重新载入：{}", change.path.display()));
    }
    Ok(())
}

// 原子替换仅覆盖单个文件；跨文件一致性由恢复日志负责，不冒充数据库事务。
pub fn replace(path: &Path, bytes: Option<&[u8]>, expected: Option<&str>) -> Result<()> {
    replace_tracked(path, bytes, expected, |_| Ok(()))
}

pub fn replace_tracked(
    path: &Path, bytes: Option<&[u8]>, expected: Option<&str>,
    on_created: impl FnOnce(&File) -> Result<()>,
) -> Result<()> {
    ensure_parent(path)?;
    if let Some(bytes) = bytes {
        if bytes.len() as u64 > MAX_BYTES { return Err("目标内容超过单文件大小限制。".into()); }
        let parent = path.parent().ok_or("缺少目标目录。")?;
        let stage: PathBuf = parent.join(format!(".cli-panel-{}.tmp", uuid::Uuid::new_v4()));
        let mut owned_identity = None;
        let result = (|| {
            let mut file = security::create_private(&stage)?;
            owned_identity = Some(identity(&file, &stage)?);
            on_created(&file)?;
            file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
            drop(file);
            publish(&stage, path, expected)
        })();
        if result.is_err() {
            if let Some(owned) = owned_identity {
                if let Some(current) = identity_at(&stage)? {
                    if current != owned {
                        return Err(format!("临时路径身份发生变化，拒绝清理碰撞文件：{}", stage.display()));
                    }
                    fs::remove_file(&stage).map_err(|cleanup| {
                        format!("写入失败且私有临时文件无法清理：{}；{cleanup}", stage.display())
                    })?;
                }
            }
        }
        result
    } else {
        if read(path)?.as_ref().map(|(b, _)| pack(b)).as_deref() != expected {
            return Err("删除前文件内容已变化，停止删除。".into());
        }
        fs::remove_file(path).map_err(|e| format!("无法真实删除 {}：{e}", path.display()))
    }
}

fn publish(stage: &Path, target: &Path, expected: Option<&str>) -> Result<()> {
    if read(target)?.as_ref().map(|(b, _)| pack(b)).as_deref() != expected {
        return Err("发布前文件被外部修改，已停止覆盖。".into());
    }
    if expected.is_none() { return rename_new(stage, target); }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
        let src: Vec<u16> = stage.as_os_str().encode_wide().chain(Some(0)).collect();
        let dst: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let result = unsafe {
            ReplaceFileW(dst.as_ptr(), src.as_ptr(), std::ptr::null(), 0,
                std::ptr::null(), std::ptr::null())
        };
        if result == 0 {
            return Err(format!("文件原子发布失败：{}；{}", target.display(), std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(stage, target).map_err(|e| e.to_string())
    }
}

pub fn rename_new(source: &Path, target: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(format!("无覆盖发布失败：{}", std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if target.exists() { return Err("发布目标已存在，拒绝覆盖。".into()); }
        fs::rename(source, target).map_err(|e| e.to_string())
    }
}
