import type { ReactNode } from "react";

const paths = {
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  arrow: <path d="M7 17 17 7M7 7h10v10" />,
  // 一个配置源连接两个引用节点，表达通用配置的一对多复用关系。
  sharedConfig: <><rect x="3" y="8" width="6" height="8" rx="1.5" /><path d="M9 12h4M16 6h-3v12h3" /><circle cx="18.5" cy="6" r="2.5" /><circle cx="18.5" cy="18" r="2.5" /></>,
  import: <><path d="M12 3v12m-4-4 4 4 4-4M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5m4-1v5l3 2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5" /></>,
  moon: <path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z" />,
  languages: <><path d="M4 5h12M9 3v2M6 5c0 6 5 10 8 11M14 5c0 6-5 10-11 12m11 4 4-10 4 10m-6.5-3h5" /></>,
  settings: <><path d="m9 3-.7 2.4-2 .9L4 5.7 2 9l1.7 1.8v2.4L2 15l2 3.3 2.3-.6 2 .9L9 21h4l.7-2.4 2-.9 2.3.6 2-3.3-1.7-1.8v-2.4L20 9l-2-3.3-2.3.6-2-.9L13 3Z" /><circle cx="11" cy="12" r="3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
} satisfies Record<string, ReactNode>;

// 侧栏统一采用与参考项目相同的 24px 线性图标网格，不增加图标依赖。
export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
