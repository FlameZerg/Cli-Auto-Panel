import { Modal } from "../../components/Modal";
import { CodeDiff } from "./CodeDiff";
import type { Preview } from "../../types";

interface Props {
  preview: Preview;
  busy: boolean;
  onCommit: () => void;
  onClose: () => void;
}

export function PreviewDialog({ preview, busy, onCommit, onClose }: Props) {
  // 删除预览的提交按钮明确标示危险动作，避免把删除误读为普通保存。
  const deleting = preview.files.some((file) => ["真实删除", "删除模板"].includes(file.action));
  return (
    <Modal wide title={preview.label} onClose={() => !busy && onClose()} footer={
      <><button disabled={busy} onClick={onClose}>返回编辑</button>
        <button className={deleting ? "danger" : "primary"} disabled={busy} onClick={onCommit}>
          {busy ? "正在提交…" : deleting ? "确认删除" : "保存并同步"}
        </button></>
    }>
      <p className="muted">仅提交以下范围。文件、profile 和模板绑定共用恢复日志；不重载已有终端，不结束会话。</p>
      {preview.notices.map((notice) => <p key={notice} className="notice">{notice}</p>)}
      {preview.files.length === 0 && <p className="empty-small">此操作仅修改面板元数据，没有配置文件内容变更。</p>}
      {preview.files.map((file) => (
        <details className="file-diff" key={file.path} open>
          {/* 文件删除与模板删除使用相同提示色，保持差异动作展示一致。 */}
          <summary><span className={["真实删除", "删除模板"].includes(file.action) ? "danger-text" : "accent"}>{file.action}</span> {file.path}</summary>
          <CodeDiff before={file.before} after={file.after} label="操作前 → 操作后" />
        </details>
      ))}
    </Modal>
  );
}
