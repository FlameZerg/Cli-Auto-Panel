import { useState } from "react";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/InlineNotice";
import type { ConfigGroup, ConfigGroupChange, Kind } from "../../types";

export type GroupAction =
  | { type: "create" }
  | { type: "rename"; group: ConfigGroup }
  | { type: "delete"; group: ConfigGroup };

// 分组编辑与危险操作共用弹窗；删除确认明确限定为容器，不涉及真实文件。
export function ConfigGroupDialog({ action, kind, groups, disabled, saving, error, onSubmit, onClose }: {
  action: GroupAction; kind: Kind; groups: ConfigGroup[]; disabled: boolean; saving: boolean; error: string;
  onSubmit: (change: ConfigGroupChange, onSaved?: () => void) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(action.type === "rename" ? action.group.name : "");
  const [submitted, setSubmitted] = useState(false);
  const deleting = action.type === "delete";
  const trimmed = name.trim();
  const currentId = action.type === "create" ? null : action.group.id;
  const validation = deleting ? "" : !trimmed ? "请输入分组名称。"
    : Array.from(trimmed).length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)
      ? "名称不能超过 120 个字符或包含控制字符。"
      : trimmed === "未分组" ? "“未分组”是系统保留名称。"
        : groups.some((group) => group.id !== currentId && group.name === trimmed)
          ? "当前产品已有同名分组。" : "";
  const unchanged = action.type === "rename" && trimmed === action.group.name;
  const title = deleting ? "删除分组" : action.type === "create" ? "新建分组" : "重命名分组";

  function submit() {
    if (disabled || validation || unchanged) return;
    setSubmitted(true);
    onSubmit(action.type === "delete"
      ? { type: "deleteConfigGroup", id: action.group.id }
      : { type: "saveConfigGroup", id: currentId, name: trimmed, kind }, onClose);
  }

  // 写入期间禁止关闭；失败进入待恢复状态后仍可退出弹窗，访问主界面的恢复入口。
  return <Modal title={title} onClose={() => { if (!saving) onClose(); }}
    footer={<>
      <button disabled={saving} onClick={onClose}>取消</button>
      <button className={deleting ? "danger" : "primary"} disabled={disabled || !!validation || unchanged}
        onClick={submit}>{saving ? "正在保存…" : deleting ? "仅删除分组" : "保存分组"}</button>
    </>}>
    {action.type === "delete"
      ? <p>确定删除分组“{action.group.name}”吗？组内配置将回到“未分组”，不会删除任何配置文件、
        别名入口或通用配置绑定。</p>
      : <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <label>分组名称<input autoFocus value={name} disabled={disabled} placeholder="例如：工作项目、个人项目"
          onChange={(event) => setName(event.target.value)} /></label>
        {validation && <p className="group-validation" title={validation}>{validation}</p>}
      </form>}
    {/* 失败信息直接展示在弹窗内，避免被遮罩挡住；重新打开时不展示上次遗留的错误。 */}
    <InlineNotice tone="error" messages={[submitted ? error : ""]} />
  </Modal>;
}
