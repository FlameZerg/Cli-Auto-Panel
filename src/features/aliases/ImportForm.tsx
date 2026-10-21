import { useState } from "react";
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
    <p className="muted">只读取你明确指定的文件，不执行 profile，不扫描其他目录，不自动绑定通用配置。</p>
    <p className="notice">仅接受 {`${root}\\${pattern}`}{kind === "claude" && "，不包括 settings.local.json"}。
      默认配置、认证文件和运行时副本不在管理范围内。</p>
    <label>文件绝对路径<input value={path} disabled={disabled} onChange={(e) => { setPath(e.target.value); onDirty(); }} /></label>
    <button className="primary" disabled={disabled || !path.trim()}
      onClick={() => onSubmit({ type: "importConfig", kind, path: path.trim() })}>导入配置</button>
  </div>;
}
