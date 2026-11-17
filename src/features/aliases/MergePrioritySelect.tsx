import type { MergePriority } from "../../types";
import { useI18n } from "../../theme";

interface Props {
  value: MergePriority;
  disabled: boolean;
  onChange: (value: MergePriority) => void;
}

// 保留原有短标签；合并选择不改变已保存的绑定关系。
export function MergePrioritySelect({ value, disabled, onChange }: Props) {
  const { t } = useI18n();
  const description = t(value === "current"
    ? "同名字段优先使用当前配置。"
    : "同名字段优先使用通用配置。");
  return <select aria-label={t("合并优先级")} title={description} value={value} disabled={disabled}
    onChange={(event) => onChange(event.target.value as MergePriority)}>
    <option value="current">{t("当前配置优先")}</option>
    <option value="template">{t("通用配置优先")}</option>
  </select>;
}
