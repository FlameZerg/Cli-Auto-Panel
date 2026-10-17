import { useState } from "react";
import { Modal } from "../../components/Modal";
import type { Preview } from "../../types";

interface Props {
  preview: Preview;
  busy: boolean;
  revealed: boolean;
  onReveal: (value: boolean) => void;
  onCommit: () => void;
  onClose: () => void;
}

export function PreviewDialog({ preview, busy, revealed, onReveal, onCommit, onClose }: Props) {
  const [confirmed, setConfirmed] = useState(false);
  const destructive = /删除|移除|恢复/.test(preview.label);
  return (
    <Modal wide title={preview.label} onClose={() => !busy && onClose()} footer={
      <><button disabled={busy} onClick={onClose}>返回编辑</button>
        <button className={destructive ? "danger" : "primary"} disabled={busy || (destructive && !confirmed)} onClick={onCommit}>
          {busy ? "正在提交…" : destructive ? "确认执行此操作" : "保存并同步"}
        </button></>
    }>
      <p className="muted">仅提交以下范围。文件、profile 和模板绑定共用恢复日志；不重载已有终端，不结束会话。</p>
      {preview.notices.map((notice) => <p key={notice} className="notice">{notice}</p>)}
      <label className="check"><input type="checkbox" checked={revealed} disabled={busy}
        onChange={(e) => onReveal(e.target.checked)} />显示明文差异（可能含密钥，勿截图或分享）</label>
      {preview.files.length === 0 && <p className="empty-small">此操作仅修改面板元数据，没有配置文件内容变更。</p>}
      {preview.files.map((file) => (
        <details className="file-diff" key={file.path} open>
          <summary><span className={file.action === "真实删除" ? "danger-text" : "accent"}>{file.action}</span> {file.path}</summary>
          <div className="diff-columns"><div><h4>操作前</h4><pre>{file.before || "（不存在或为空）"}</pre></div>
            <div><h4>操作后</h4><pre>{file.after || "（不存在或为空）"}</pre></div></div>
        </details>
      ))}
      {destructive && <label className="check danger-text"><input type="checkbox" checked={confirmed} disabled={busy}
        onChange={(e) => setConfirmed(e.target.checked)} />我已核对关联别名、文件路径和备份范围，确认执行</label>}
    </Modal>
  );
}
