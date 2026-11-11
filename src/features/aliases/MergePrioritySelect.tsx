import type { MergePriority } from "../../types";

interface Props {
  value: MergePriority;
  disabled: boolean;
  onChange: (value: MergePriority) => void;
}

// 保留原有短标签；合并选择不改变已保存的绑定关系。
export function MergePrioritySelect({ value, disabled, onChange }: Props) {
  const description = value === "current"
    ? "同名字段优先使用当前配置。"
    : "同名字段优先使用通用配置。";
  return <select aria-label="合并优先级" title={description} value={value} disabled={disabled}
    onChange={(event) => onChange(event.target.value as MergePriority)}>
    <option value="current">当前配置优先</option>
    <option value="template">通用配置优先</option>
  </select>;
}
