fn main() {
    // 图标由用户构建时生成，不额外引入图像工具或外部资源。
    let icon = std::path::Path::new("icons/icon.ico");
    if !icon.exists() {
        std::fs::create_dir_all("icons").expect("无法创建构建图标目录");
        std::fs::write(icon, icon_bytes()).expect("无法生成 Windows 图标");
    }
    tauri_build::build()
}

fn icon_bytes() -> Vec<u8> {
    let mut bytes = Vec::new();
    for value in [0u16, 1, 1] { bytes.extend(value.to_le_bytes()); }
    bytes.extend([32, 32, 0, 0]);
    for value in [1u16, 32] { bytes.extend(value.to_le_bytes()); }
    bytes.extend(4264u32.to_le_bytes());
    bytes.extend(22u32.to_le_bytes());
    for value in [40u32, 32, 64] { bytes.extend(value.to_le_bytes()); }
    for value in [1u16, 32] { bytes.extend(value.to_le_bytes()); }
    for value in [0u32, 4224, 0, 0, 0, 0] { bytes.extend(value.to_le_bytes()); }
    for y in (0..32).rev() {
        for x in 0..32 {
            let foreground = (7..25).contains(&x)
                && ((8..11).contains(&y) || (15..18).contains(&y) || (22..25).contains(&y));
            bytes.extend(if foreground { [255, 182, 168, 255] } else { [37, 28, 26, 255] });
        }
    }
    bytes.extend([0; 128]);
    bytes
}
