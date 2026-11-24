import { useEffect } from "react";

const SCROLLBAR_IDLE_MS = 650;

export function useScrollingScrollbar() {
  useEffect(() => {
    const timers = new Map<HTMLElement, number>();

    function onScroll(event: Event) {
      const element = event.target === document ? document.documentElement : event.target;
      if (!(element instanceof HTMLElement)) return;
      const previous = timers.get(element);
      if (previous === undefined) element.dataset.scrolling = "";
      else window.clearTimeout(previous);
      // 每个区域独立计时，编辑器联动滚动时分别显示对应的滑块。
      timers.set(element, window.setTimeout(() => {
        delete element.dataset.scrolling;
        timers.delete(element);
      }, SCROLLBAR_IDLE_MS));
    }

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      for (const [element, timer] of timers) {
        window.clearTimeout(timer);
        delete element.dataset.scrolling;
      }
    };
  }, []);
}
