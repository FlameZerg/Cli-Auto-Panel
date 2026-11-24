import { useState } from "react";
import { Modal } from "../../components/Modal";
import { InlineNotice } from "../../components/InlineNotice";
import { CodeDiff, type DiffView } from "./CodeDiff";
import { previewLanguage, type PreviewEditor } from "./previewEditing";
import type { Preview } from "../../types";
import { useI18n } from "../../theme";

interface Props {
  preview: Preview;
  busy: boolean;
  error: string;
  deleting: boolean;
  editor: PreviewEditor | null;
  onEdit: (path: string, content: string) => void;
  onCommit: () => void;
  onClose: () => void;
}

export function PreviewDialog({ preview, busy, error, editor, deleting, onEdit, onCommit, onClose }: Props) {
  const { t } = useI18n();
  // 一次切换统一作用于全部变更文件，默认双栏，不改变预览内容或提交计划。
  const [view, setView] = useState<DiffView>("split");
  // 编辑值归属当前预览，切换视图时仍保留右侧草稿。
  const [edited, setEdited] = useState<{ id: string; path: string; content: string } | null>(null);
  return (
    <Modal wide title={preview.label} onClose={() => !busy && onClose()} footer={
      <><button disabled={busy} onClick={onClose}>{t("返回编辑")}</button>
        <button className={deleting ? "danger" : "primary"} disabled={busy} onClick={onCommit}>
          {t(busy ? "正在提交…" : deleting ? "确认删除" : "保存并同步")}
        </button></>
    }>
      <InlineNotice messages={preview.notices} />
      <InlineNotice messages={[error]} tone="error" />
      {preview.files.length > 0 && <div className="diff-view-toggle" role="group" aria-label={t("差异显示方式")}>
        <button aria-pressed={view === "split"} onClick={() => setView("split")}>{t("双栏差异")}</button>
        <button aria-pressed={view === "unified"} onClick={() => setView("unified")}>{t("单栏差异")}</button>
      </div>}
      {preview.files.length === 0 && <p className="empty-small">{t("此操作仅修改面板元数据，没有配置文件内容变更。")}</p>}
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
