import { Component, type ReactNode } from "react";
import { useI18n } from "../theme";
import { Modal } from "./Modal";

// 按需模块加载失败必须可见；不把失败伪装成永久加载，也不自动刷新丢弃草稿。
class Boundary extends Component<{ children: ReactNode; fallback: (error: Error) => ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error("界面模块加载失败：", error); }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}
export function ModuleBoundary({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  const { t } = useI18n();
  const errorContent = (error: Error) => <p role="alert">{t("界面模块加载失败：{error}", { error: error.message })}</p>;
  return <Boundary fallback={(error) => onClose
    ? <Modal title={t("查看差异")} onClose={onClose}>{errorContent(error)}</Modal>
    : <div className="form-section">{errorContent(error)}</div>}>{children}</Boundary>;
}
