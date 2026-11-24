import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "../theme";

export function StatusNotices({ summary, tone, children }: {
  summary: string;
  tone: "notice" | "error" | "success";
  children: ReactNode;
}) {
  const { t } = useI18n();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);

  useEffect(() => {
    function dismissWithEscape(event: KeyboardEvent) {
      const element = disclosure.current;
      if (event.key !== "Escape" || !element?.open) return;
      if (element.contains(document.activeElement)) {
        event.preventDefault();
        trigger.current?.focus();
      }
      element.open = false;
    }

    function dismissOutside(event: PointerEvent) {
      const element = disclosure.current;
      if (element?.open && event.target instanceof Node && !element.contains(event.target)) {
        element.open = false;
      }
    }

    document.addEventListener("keydown", dismissWithEscape);
    document.addEventListener("pointerdown", dismissOutside);
    return () => {
      document.removeEventListener("keydown", dismissWithEscape);
      document.removeEventListener("pointerdown", dismissOutside);
    };
  }, []);

  // 使用原生展开控件，触屏可点击；悬浮和键盘聚焦无需额外操作。
  return <details className="status-bar" ref={disclosure}
    onPointerEnter={(event) => { if (event.pointerType !== "touch") event.currentTarget.open = true; }}
    onPointerLeave={(event) => {
      if (!event.currentTarget.querySelector(":focus-visible")) event.currentTarget.open = false;
    }}
    onBlur={(event) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node && event.currentTarget.contains(next)) && !event.currentTarget.matches(":hover")) {
        event.currentTarget.open = false;
      }
    }}>
    <summary className={`status-summary inline-notice-${tone}`} ref={trigger}
      onFocus={(event) => {
        if (event.currentTarget.matches(":focus-visible") && disclosure.current) disclosure.current.open = true;
      }}>
      <span role={tone === "error" ? "alert" : "status"}>{summary}</span>
    </summary>
    <div className="status-detail" tabIndex={0} role="region" aria-label={t("操作与绑定提示")}>
      {children}
    </div>
  </details>;
}
