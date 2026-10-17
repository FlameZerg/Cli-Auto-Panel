import type { Kind } from "../types";

interface Props {
  kind: Kind;
  disabled: boolean;
  onApply: (key: string, enabled: boolean) => void;
}

export function Shortcuts({ kind, disabled, onApply }: Props) {
  const choices = kind === "claude"
    ? [
        ["attribution", "隐藏提交署名"], ["teams", "Agent Teams"], ["toolSearch", "工具搜索"],
        ["effort", "最大思考强度"], ["updates", "关闭自动更新"], ["artifact", "关闭 Artifact"],
      ]
    : [["notifications", "终端通知"], ["storage", "禁止响应存储"]];
  return (
    <details className="shortcuts">
      <summary>快捷编辑 <span>只更改草稿，保存时统一校验</span></summary>
      <div className="shortcut-grid">
        {choices.map(([key, label]) => (
          <div key={key}><span>{label}</span><button disabled={disabled} onClick={() => onApply(key, true)}>应用</button>
            <button disabled={disabled} onClick={() => onApply(key, false)}>剥离</button></div>
        ))}
      </div>
      <p className="muted">“剥离”仅删除与快捷片段匹配的值，不清除不同的自定义值。</p>
    </details>
  );
}
