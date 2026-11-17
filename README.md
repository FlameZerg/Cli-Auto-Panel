# CLI Auto Panel

本地优先的 Codex／Claude 配置工作台。通过通用配置、独立文件和 PowerShell 别名管理多套配置，支持差异预览、绑定同步、分组、排序及备份恢复。

## 界面与偏好

- 左上角保留原有 CLI 标识；Codex／Claude 切换位于“别名配置文件”上方，左栏以参数滑块图标表示通用配置，不使用文件夹图标。
- 导入文件与备份恢复固定排列在左栏下方，其后依次提供浅／暗主题、中英文和偏好设置，各入口的图标及文字对齐。
- 偏好设置与 Prompt Note 使用相同的八组配色：松石绿、海湾蓝、鸢尾紫、玫瑰粉、暖琥珀、雾岩灰、珊瑚橙、冰川青。配色在浅色和暗色模式下均可使用。
- Ctrl＋鼠标滚轮以 10% 为步长缩放，范围 50–200%；底部提供缩小、百分比重置及放大按钮。普通滚轮继续滚动内容。
- 语言、配色、明暗和缩放只保存在本机前端偏好中，不改写 CLI 配置。用户名称、路径、配置正文和后端原始诊断不参与翻译。

## 数据保护

配置根目录遵循 `CODEX_HOME`／`CLAUDE_CONFIG_DIR`；未设置时使用当前用户默认目录。实际受管范围以界面提示和后端路径校验为准，不接受默认配置或 Claude 的 `settings.local.json`。

PowerShell profile 仅作为语法解析输入，不执行其中的命令。配置写入、备份和恢复继续经过事务计划、文件身份和哈希检查；写入或恢复中须等待结果返回再关闭窗口。已有终端与会话不会被自动重载或终止。

## 开发与构建

使用仓库现有 npm 锁文件，不需要更换包管理器。

```powershell
npm ci
npm run dev
```

前端构建为 `npm run build:renderer`，桌面构建为 `npm run build -- --no-bundle`，后者仅生成直接运行的 EXE，不生成安装包。原生 Windows 构建需要 Rust、MSVC、Windows SDK 及 WebView2。

`.github/workflows/build-windows.yml` 在每次推送到 GitHub 后自动构建 Windows EXE，同时保留手动触发。成功后可从该次 Actions 运行下载 `cli-auto-panel-windows-x64` 产物，解压后运行其中的 EXE。工作流不启动应用、不生成安装包，也不创建 Release；未推送的本地文件修改不会触发云端构建。

应用图标使用独立的“终端路由”造型，采用石墨灰、冷白和电蓝，不跟随工作区主题。源文件为 `public/app-icon.svg`，PNG 预览为 `src-tauri/icons/icon.png`，Windows 图标为 `src-tauri/icons/icon.ico`；左上角 CLI 标识保持独立。修改 SVG 后可通过已安装的 Tauri CLI 更新原生资源：

```powershell
npm run tauri -- icon public/app-icon.svg --output src-tauri/icons
```

## 加载策略

首页优先加载导航及配置清单，编辑器和差异界面按需加载。并发中的清单读取共用一次后端扫描，完成即释放，写入前后隔离在途快照。单轮扫描复用同路径、同产品的路径校验结果，下一轮仍重新校验；不跳过文件身份、硬链接、哈希或恢复检查。实际启动及扫描耗时应在目标 Windows 环境测量。
