import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { translator, type Language } from "./locales";

export const palettes = ["jade", "ocean", "violet", "rose", "amber", "slate", "coral", "cyan"] as const;
export type Palette = typeof palettes[number];
export type ThemeChoice = "light" | "dark";
export const paletteNames = {
  jade: "松石绿", ocean: "海湾蓝", violet: "鸢尾紫", rose: "玫瑰粉",
  amber: "暖琥珀", slate: "雾岩灰", coral: "珊瑚橙", cyan: "冰川青",
} as const;
const prefix = "cli-auto-panel.";

function read(key: string) {
  try { return localStorage.getItem(prefix + key); }
  catch (error) { console.error("读取偏好失败：", error); return null; }
}
export function clampZoom(value: number) {
  return Number.isFinite(value) ? Math.min(2, Math.max(.5, Math.round(value * 10) / 10)) : 1;
}
function initialPalette(): Palette {
  const value = read("palette");
  return palettes.find((palette) => palette === value) ?? "jade";
}
function usePreferencesState() {
  // 保留旧版已保存的明暗选择；首次使用与参考项目一样采用浅色、绿色及中文。
  const [theme, setTheme] = useState<ThemeChoice>(() => read("theme") === "dark" ? "dark" : "light");
  const [palette, setPalette] = useState<Palette>(initialPalette);
  const [language, setLanguage] = useState<Language>(() => read("language") === "en" ? "en" : "zh");
  const [zoom, setZoom] = useState(() => clampZoom(Number(read("zoom") ?? 1)));
  const [autoSortConfigs, setAutoSortConfigs] = useState(() => read("auto-sort-configs") === "true");
  const [storageError, setStorageError] = useState(false);
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.palette = palette;
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [theme, palette, language]);
  useEffect(() => {
    try {
      for (const [key, value] of Object.entries({
        theme, palette, language, zoom: String(zoom), "auto-sort-configs": String(autoSortConfigs),
      })) {
        localStorage.setItem(prefix + key, value);
      }
      setStorageError(false);
    } catch (error) { console.error("保存偏好失败：", error); setStorageError(true); }
  }, [theme, palette, language, zoom, autoSortConfigs]);
  useEffect(() => {
    // 与 Prompt Note 一致，普通滚轮继续滚动；拦截 Ctrl+滚轮以避免双重缩放。
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      setZoom((value) => clampZoom(value + (event.deltaY < 0 ? .1 : -.1)));
    };
    window.addEventListener("wheel", wheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", wheel, { capture: true });
  }, []);
  const t = useMemo(() => translator(language), [language]);
  return { theme, palette, setPalette, language, setLanguage, zoom, setZoom, storageError, t,
    autoSortConfigs, setAutoSortConfigs,
    toggle: () => setTheme((current) => current === "dark" ? "light" : "dark") };
}

const ThemeContext = createContext<ReturnType<typeof usePreferencesState> | null>(null);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const preferences = usePreferencesState();
  return <ThemeContext.Provider value={preferences}>{children}</ThemeContext.Provider>;
}
export function useTheme() {
  const preferences = useContext(ThemeContext);
  if (!preferences) throw new Error("偏好设置提供器未初始化。");
  return preferences;
}
export function useI18n() {
  const { t, language } = useTheme();
  return { t, language };
}
