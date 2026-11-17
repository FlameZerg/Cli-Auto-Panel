fn main() {
    // 使用随源码提交的新图标；资源缺失直接报错，不再静默生成旧版图标。
    tauri_build::build()
}
