import type { ReactNode } from "react";

// 提示固定单行，长内容保留在原生悬停提示中，不覆盖配置编辑区。
export function InlineNotice({ messages, tone = "notice", actions }: {
  messages: (string | null | undefined)[];
  tone?: "notice" | "error" | "success";
  actions?: ReactNode;
}) {
  const text = [...new Set(messages.filter((message): message is string => !!message))]
    .join("；").replace(/\s+/g, " ");
  if (!text) return null;
  return <div className={`inline-notice inline-notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
    <span className="inline-notice-text" title={text}>{text}</span>{actions}
  </div>;
}
