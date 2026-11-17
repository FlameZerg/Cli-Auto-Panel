import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../theme";
import { Icon } from "./Icon";

interface Props { title: string; children: ReactNode; footer?: ReactNode; onClose: () => void; wide?: boolean }

export function Modal({ title, children, footer, onClose, wide }: Props) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog ref={dialog} className={`modal ${wide ? "wide" : ""}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label={t("关闭对话框")}><Icon name="close" /></button></div>
      <div className="modal-content">{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </dialog>
  );
}
