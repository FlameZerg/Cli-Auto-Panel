use crate::model::Result;
use std::{fs::File, path::Path, sync::OnceLock};

static CURRENT_SID: OnceLock<String> = OnceLock::new();

pub fn initialize(sid: String) -> Result<()> {
    if !sid.starts_with("S-1-") || !sid.chars().all(|c| c.is_ascii_digit() || c == 'S' || c == '-') {
        return Err("当前用户安全标识无效，已停止写入。".into());
    }
    if let Some(previous) = CURRENT_SID.get() {
        return if previous == &sid { Ok(()) } else { Err("当前用户安全身份发生变化。".into()) };
    }
    CURRENT_SID.set(sid).map_err(|_| "初始化用户安全身份时发生冲突。".into())
}

// 临时文件在创建的同一时刻设置私有 DACL，避免先写入凭据再收紧权限。
pub fn create_private(path: &Path) -> Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::{ffi::OsStrExt, io::FromRawHandle};
        use windows_sys::Win32::{
            Foundation::{LocalFree, GENERIC_WRITE, INVALID_HANDLE_VALUE},
            Security::{Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES},
            Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_READ_ATTRIBUTES},
        };
        let sid = CURRENT_SID.get().ok_or("用户安全身份尚未初始化。")?;
        let sddl: Vec<u16> = format!("D:P(A;;FA;;;{sid})(A;;FA;;;SY)").encode_utf16().chain(Some(0)).collect();
        let mut descriptor = std::ptr::null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut())
        };
        if ok == 0 { return Err("无法准备私有临时文件权限。".into()); }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let handle = unsafe {
            CreateFileW(name.as_ptr(), GENERIC_WRITE | FILE_READ_ATTRIBUTES, 0, &attributes, CREATE_NEW,
                FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut())
        };
        let create_error = std::io::Error::last_os_error();
        let free_result = unsafe { LocalFree(descriptor) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!("无法创建私有临时文件：{create_error}"));
        }
        let file = unsafe { File::from_raw_handle(handle) };
        if !free_result.is_null() {
            return Err("无法释放临时权限描述符，已停止写入。".into());
        }
        Ok(file)
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
            .map_err(|e| e.to_string())
    }
}
