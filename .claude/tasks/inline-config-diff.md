# 上下文
文件名：inline-config-diff.md
创建于：2026-10-21
创建者：Codex

# 任务描述
当前配置与应用通用配置的差异不应拆成原文编辑器和独立差异面板，仅保留一个代码编辑器，在编辑器内进行红绿 diff 对比。

# 项目概述
React / TypeScript 前端使用 CodeMirror 6 编辑 JSON / TOML；后端提供实际保存逻辑对应的合并预览。

# 分析
ConfigEditor.tsx 与 CreateAliasForm.tsx 同时渲染 CodeEditor 和 CodeDiff，导致配置编辑与差异预览分离。现有 useMergePreview 已隔离过期请求，lineDiff.ts 已提供逐行差异与末行换行标记，无需修改后端或增加依赖。

# 提议的解决方案
1. 在 src/features/preview/inlineDiff.ts 中增加 CodeMirror 状态字段、差异更新效果及新增行只读块组件，复用 buildLineDiff 的结果。删除行装饰原文，新增行只作预览，不进入草稿。
2. 扩展 src/components/CodeEditor.tsx 的可选 diff 属性，包含 after、label、loading、error；计算差异并更新同一实例的装饰，在同一外框中显示图例及状态。输入变化立即清理过期装饰；切换语言或主题后恢复当前装饰。
3. 修改 src/features/aliases/ConfigEditor.tsx 与 CreateAliasForm.tsx，删除独立 CodeDiff 和 merge-preview 区块，向唯一的 CodeEditor 传入当前合并预览。不修改保存接口、草稿基线及异步预览逻辑。
4. 修改 src/styles.css，补充同框标题、红删绿增行、正负号、末行换行提示样式，移除不再使用的 merge-preview 样式。
5. 静态核对新增、删除、替换、空文件、末行无换行、切换模板及主题重建的路径，更新此记录。不运行测试、类型检查、编译或应用。

# 当前执行步骤："5. 静态审查完成，待用户确认"

# 任务进度
2026-10-21
- 修改：尚未修改实现文件。
- 更改：完成相关组件、差异算法及已安装 CodeMirror 类型声明的只读检查。
- 原因：确定单编辑器方案并保持现有草稿和保存语义。
- 阻碍：无。
- 状态：实施中。

2026-10-21
- 修改：src/features/preview/inlineDiff.ts、src/components/CodeEditor.tsx。
- 更改：新增同一 CodeMirror 实例内的红色删除行和绿色只读新增行；标题、计数、加载及错误提示共用编辑器外框。编辑原文立即清理旧装饰，主题或语言重建后重新应用当前差异。
- 原因：在不改变草稿与保存语义的前提下，将差异直接集成到原编辑器。
- 阻碍：无。
- 状态：实现完成，未运行验证。

2026-10-21
- 修改：src/features/aliases/ConfigEditor.tsx、src/features/aliases/CreateAliasForm.tsx、src/styles.css。
- 更改：两个表单均只保留一个 CodeEditor，移除独立 CodeDiff 和 merge-preview 容器；增加正负标记与深浅主题配色。删除行文本仍可编辑，新增行明确标注为只读预览。
- 原因：消除原文与差异分离的重复代码区域，并统一已有配置和新建配置的交互。
- 阻碍：无。
- 状态：静态审查完成，待用户确认。

# 最终审查
实施完全匹配计划。已静态核对插入、删除、替换、空文件、末尾有无换行的锚点计算；差异仅通过装饰更新，不写入编辑器文档，不触发草稿修改回调。异步结果仍由现有 useMergePreview 隔离，加载与错误状态不展示旧差异。

两个表单各保留一个 CodeEditor，未再引用 CodeDiff；确认提交弹窗原有的单区域差异展示不受本次变更影响。未增加依赖，未修改后端、实际配置文件或已有可执行文件。

git diff --check 未报告补丁空白错误，仅提示已有跟踪文件下次由 Git 处理时将转换 LF / CRLF。按照项目约定，未执行测试、类型检查、编译或应用运行；运行与视觉效果尚未验证。
