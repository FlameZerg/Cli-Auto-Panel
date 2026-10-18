import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

// 主题仅是前端呈现关注点：以 html[data-theme] 驱动 styles.css 的两套变量，
// 偏好持久化在 localStorage，与后端配置读写链路完全无关。
export type ThemeChoice = "light" | "dark";

const STORAGE_KEY = "cli-auto-panel.theme";

interface ThemeContextValue {
  theme: ThemeChoice;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: "dark", toggle: () => {} });

// 读取已保存的偏好；存储不可用时仅退回默认深色，不阻断面板初始化。
function initialTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // 读取失败（如禁用存储）不视为错误，仍可使用本次会话的默认主题。
  }
  return "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeChoice>(initialTheme);

  // 主题变化时同步到文档根节点；同一属性也由 index.html 的内联脚本提前设置，
  // 这里是唯一负责维护它的运行时入口，避免两处状态分叉。
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // 持久化失败只影响下次启动的默认值，不弹错误打扰当前会话。
    }
  }, [theme]);

  const toggle = () => setTheme((current) => (current === "dark" ? "light" : "dark"));
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
