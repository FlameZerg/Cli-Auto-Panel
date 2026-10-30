import type { MergePriority } from "../../types";

interface Props {
  value: MergePriority;
  disabled: boolean;
  onChange: (value: MergePriority) => void;
}

// 编辑与新建共用选项和行为说明；选择只更新草稿，保存时才应用到文件。
export function MergePrioritySelect({ value, disabled, onChange }: Props) {
  const description = value === "current"
    ? "优先保留手动修改与删除；未手动改动的通用字段继续同步。"
    : "同名字段采用通用值；保存会覆盖冲突值，切回当前配置优先不会自动还原。";
  return <select aria-label="合并优先级" title={description} value={value} disabled={disabled}
    onChange={(event) => onChange(event.target.value as MergePriority)}>
    <option value="current">当前配置优先</option>
    <option value="template">通用配置优先</option>
  </select>;
}
