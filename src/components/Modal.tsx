import { useEffect, useRef, type ReactNode } from "react";

interface Props { title: string; children: ReactNode; footer: ReactNode; onClose: () => void; wide?: boolean }

export function Modal({ title, children, footer, onClose, wide }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog ref={dialog} className={`modal ${wide ? "wide" : ""}`}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <div className="modal-heading"><h2>{title}</h2><button className="quiet" onClick={onClose} aria-label="关闭对话框">关闭</button></div>
      <div className="modal-content">{children}</div>
      <div className="modal-footer">{footer}</div>
    </dialog>
  );
}
