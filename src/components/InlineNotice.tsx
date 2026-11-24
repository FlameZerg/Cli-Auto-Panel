import type { ReactNode } from "react";

// 保留诊断原有换行，多条提示逐项展示。
export function InlineNotice({ messages, tone = "notice", actions }: {
  messages: (string | null | undefined)[];
  tone?: "notice" | "error" | "success";
  actions?: ReactNode;
}) {
  const items = [...new Set(messages.map((message) => message?.trim() ?? "").filter(Boolean))];
  if (!items.length) return null;
  return <div className={`inline-notice inline-notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
    {items.length === 1 ? <span className="inline-notice-text">{items[0]}</span>
      : <ul className="inline-notice-text">{items.map((item) => <li key={item}>{item}</li>)}</ul>}
    {actions}
  </div>;
}
