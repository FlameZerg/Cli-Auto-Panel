import { useState } from "react";
import { InlineNotice } from "../../components/InlineNotice";
import type { Bootstrap, Change, Kind } from "../../types";

export function ImportForm({ kind, data, disabled, onSubmit, onDirty }: {
  kind: Kind; data: Bootstrap; disabled: boolean; onSubmit: (change: Change) => void; onDirty: () => void;
}) {
  const [path, setPath] = useState("");
  // 与新建入口及后端受管范围保持一致，不再展示固定 E 盘路径。
  const root = (kind === "codex" ? data.codexRoot : data.claudeRoot).replace(/[\\/]+$/, "");
  const pattern = kind === "codex" ? "config.*.toml" : "settings.*.json";
  return <div className="form-section">
    <span className="eyebrow">IMPORT EXISTING FILE</span><h2>手动导入已有配置</h2>
    <InlineNotice messages={[`仅接受 ${root}\\${pattern}${kind === "claude" ? "，不包括 settings.local.json" : ""}。`]} />
    <label>文件绝对路径<input value={path} disabled={disabled} onChange={(e) => { setPath(e.target.value); onDirty(); }} /></label>
    <button className="primary" disabled={disabled || !path.trim()}
      onClick={() => onSubmit({ type: "importConfig", kind, path: path.trim() })}>导入配置</button>
  </div>;
}
