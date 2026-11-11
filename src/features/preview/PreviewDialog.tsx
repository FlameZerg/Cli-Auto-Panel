import { useState } from "react";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/InlineNotice";
import { CodeDiff, type DiffView } from "./CodeDiff";
import { previewLanguage, type PreviewEditor } from "./previewEditing";
import type { Preview } from "../../types";

interface Props {
  preview: Preview;
  busy: boolean;
  stale: boolean;
  error: string;
  editor: PreviewEditor | null;
  onEdit: (path: string, content: string) => void;
  onRepreview: () => void;
  onCommit: () => void;
  onClose: () => void;
}

export function PreviewDialog({ preview, busy, stale, error, editor, onEdit, onRepreview, onCommit, onClose }: Props) {
  // 一次切换统一作用于全部变更文件，默认双栏，不改变预览内容或提交计划。
  const [view, setView] = useState<DiffView>("split");
  // 编辑值归属当前预览；重新生成后以新计划结果为准，不把旧结果覆盖新预览。
  const [edited, setEdited] = useState<{ id: string; path: string; content: string } | null>(null);
  // 删除预览的提交按钮明确标示危险动作，避免把删除误读为普通保存。
  const deleting = preview.files.some((file) => ["真实删除", "删除模板"].includes(file.action));
  return (
    <Modal wide title={preview.label} onClose={() => !busy && onClose()} footer={
      <><button disabled={busy} onClick={onClose}>返回编辑</button>
        {stale && <button className="primary" disabled={busy} onClick={onRepreview}>重新预览</button>}
        <button className={deleting ? "danger" : "primary"} disabled={busy || stale} onClick={onCommit}>
          {busy ? "正在提交…" : deleting ? "确认删除" : "保存并同步"}
        </button></>
    }>
      <InlineNotice messages={preview.notices} />
      <InlineNotice messages={[error]} tone="error" />
      <InlineNotice messages={[stale ? "内容已修改，请重新预览后保存。" : ""]} />
      {preview.files.length > 0 && <div className="diff-view-toggle" role="group" aria-label="差异显示方式">
        <button aria-pressed={view === "split"} onClick={() => setView("split")}>双栏差异</button>
        <button aria-pressed={view === "unified"} onClick={() => setView("unified")}>单栏差异</button>
      </div>}
      {preview.files.length === 0 && <p className="empty-small">此操作仅修改面板元数据，没有配置文件内容变更。</p>}
      {/* 单文件填满剩余空间；多文件全部保留，由弹窗正文纵向滚动，不提供折叠。 */}
      {preview.files.length > 0 && <div className={`preview-files ${preview.files.length === 1 ? "single-file" : ""}`}>
        {preview.files.map((file) => <CodeDiff key={file.path} before={file.before}
          after={edited?.id === preview.id && edited.path === file.path ? edited.content : file.after}
          label={file.path} action={file.action} view={view}
          kind={editor?.path === file.path ? editor.kind : previewLanguage(file.path)}
          readOnly={busy || editor?.path !== file.path}
          onChange={editor?.path === file.path ? (content) => {
            setEdited({ id: preview.id, path: file.path, content });
            onEdit(file.path, content);
          } : undefined} />)}
      </div>}
    </Modal>
  );
}
