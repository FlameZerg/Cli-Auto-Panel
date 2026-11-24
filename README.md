# CLI Auto Panel

适用于 Codex／Claude 的配置管理工作台。通过通用配置、独立文件和 PowerShell 别名管理多套配置，支持差异预览、绑定同步、分组、排序及备份恢复。

## 界面与偏好

- 左上角保留原有 CLI 标识；Codex／Claude 切换位于“别名配置文件”上方，左栏以参数滑块图标表示通用配置，不使用文件夹图标。
- 导入文件与备份恢复固定排列在左栏下方，其后依次提供浅／暗主题、中英文和偏好设置，各入口的图标及文字对齐。
- 偏好设置与 Prompt Note 使用相同的八组配色：松石绿、海湾蓝、鸢尾紫、玫瑰粉、暖琥珀、雾岩灰、珊瑚橙、冰川青。配色在浅色和暗色模式下均可使用。
- Ctrl＋鼠标滚轮以 10% 为步长缩放，范围 50–200%；底部提供缩小、百分比重置及放大按钮。普通滚轮继续滚动内容。

## 数据保护

配置根目录遵循 `CODEX_HOME`／`CLAUDE_CONFIG_DIR`；未设置时使用当前用户默认目录。实际受管范围以界面提示和后端路径校验为准，不接受默认配置或 Claude 的 `settings.local.json`。

PowerShell profile 仅作为语法解析输入，不执行其中的命令。配置写入、备份和恢复继续经过事务计划、文件身份和哈希检查；写入或恢复中须等待结果返回再关闭窗口。已有终端与会话不会被自动重载或终止。

Codex 使用 `config.名称.toml` 并注册 `codex-名称`，Claude 使用 `settings.名称.json` 并注册 `claude-名称`。每张卡片对应一个配置文件。

搜索期间可在组内拖动命中的卡片，也可聚焦卡片后按 Alt＋↑ 或 Alt＋↓ 移动。搜索隐藏的卡片保留原槽位。

保存通用配置时可继续同步有效的绑定文件，跳过的文件会列在操作提示中。在通用配置页可移除失去入口的绑定，在文件详情可移除读取失败的管理记录并保留原文件。

## 开发与构建

使用仓库现有 npm 锁文件，不需要更换包管理器。

```powershell
npm ci
npm run dev
```

前端构建为 `npm run build:renderer`，桌面构建为 `npm run build -- --no-bundle`，后者仅生成直接运行的 EXE，不生成安装包。原生 Windows 构建需要 Rust、MSVC、Windows SDK 及 WebView2。

```powershell
npm run tauri -- icon public/app-icon.svg --output src-tauri/icons
```
