import { useEffect, useId, useRef, useState } from "react";
import type { DragEvent, MouseEvent, PointerEvent } from "react";
import { startDragAutoScroll, type DragPointer } from "./dragAutoScroll";
import { startPointerDrag } from "./pointerDrag";

// 轻量列表拖拽排序：共用 Pointer Events 手势，不引入第三方库。
// 交互模型：
//   拖动中 → 预览顺序（preview）即时重排，其他卡片通过 CSS transform 平滑让位；
//   落手   → 冻结预览顺序（frozen，乐观更新）并静默提交，杜绝"弹回旧序再跳新序"的闪烁与延迟感；
//   成功   → 提交返回的 items 顺序对齐后自动解冻；
//   失败   → 由调用方调用 cancel() 立即回弹到状态库权威顺序。
// 所有关键跨事件状态（dragging/over）一律以 ref 为准，state 只做渲染镜像：
//   指针、滚轮与滚动是独立事件序列，ref 保证卡片重渲染后提交不丢失。
export function useDragSort<T>(
  items: T[],
  keyOf: (item: T) => string,
  enabled: boolean,
  commit: (order: string[]) => void,
) {
  const [render, setRender] = useState<{ dragging: string | null; over: string | null }>({ dragging: null, over: null });
  const [frozen, setFrozen] = useState<string[] | null>(null);
  // 每个嵌套列表独占命中范围，不将组内卡片的手势识别为整组拖拽。
  const scope = useId();
  const listRef = useRef<HTMLElement | null>(null);
  const gestureRef = useRef<(() => void) | null>(null);
  // 松手仅提交一次，事件闭包也可能跨渲染存活。
  const doneRef = useRef(true);
  // 状态镜像：事件处理器内部读取 ref，避免旧闭包覆盖最近一次悬停。
  const latestRef = useRef<{ dragging: string | null; over: string | null }>({ dragging: null, over: null });
  const autoScrollRef = useRef<ReturnType<typeof startDragAutoScroll>>(null);

  const keys = items.map(keyOf);
  const joined = keys.join("\u0000");

  // 状态库权威顺序一旦变化（提交成功对齐 / 任何外部刷新），一律解除乐观冻结。
  useEffect(() => {
    setFrozen(null);
    if (gestureRef.current) reset();
  }, [joined]);
  // 禁用或卸载时释放拖拽监听与动画帧，避免残留滚动影响后续操作。
  useEffect(() => {
    if (!enabled && gestureRef.current) reset();
    return disposeGesture;
  }, [enabled]);

  // 拖拽预览：以当前列表为基准，把被拖项移动到最后悬停项的位置。
  // preview 只在渲染期间从 state 镜像推导；事件写入走 ref，再由 setRender 触发重渲染。
  const dragging = render.dragging;
  const over = render.over;
  const preview = (() => {
    if (!dragging || !over || dragging === over) return null;
    const from = keys.indexOf(dragging);
    const to = keys.indexOf(over);
    if (from < 0 || to < 0) return null;
    const next = keys.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  })();

  const order = preview ?? frozen ?? keys;
  const rank = new Map(order.map((key, index) => [key, index] as const));
  const ordered = items.slice().sort((a, b) =>
    (rank.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER));

  function sync(next: { dragging: string | null; over: string | null }) {
    latestRef.current = next;
    setRender(next);
  }

  function reset() {
    disposeGesture();
    doneRef.current = true;
    sync({ dragging: null, over: null });
  }

  function disposeGesture() {
    gestureRef.current?.();
    gestureRef.current = null;
    autoScrollRef.current?.stop();
    autoScrollRef.current = null;
  }

  function cancel() {
    // 提交失败回滚：立即放弃乐观顺序。
    setFrozen(null);
    reset();
  }

  function drop(point: DragPointer) {
    if (!targetInList(point)) { reset(); return; }
    hover(point);
    const current = latestRef.current;
    if (!current.dragging) return;
    if (doneRef.current) return;
    doneRef.current = true;
    const overKey = current.over ?? current.dragging;
    const from = keys.indexOf(current.dragging);
    const to = keys.indexOf(overKey);
    let finalOrder = keys;
    if (from >= 0 && to >= 0 && from !== to) {
      finalOrder = keys.slice();
      const [moved] = finalOrder.splice(from, 1);
      finalOrder.splice(to, 0, moved);
    }
    const changed = finalOrder.some((key, index) => key !== keys[index]);
    reset();
    if (changed) {
      setFrozen(finalOrder);
      commit(finalOrder);
    }
  }

  function card(key: string, onClick?: (event: MouseEvent) => void) {
    return {
      // 有未落盘的乐观顺序时暂停新一轮拖拽，避免并发提交触发 revision 冲突。
      draggable: enabled && !frozen,
      "data-drag-sort-scope": scope,
      "data-drag-sort-key": key,
      onPointerDown: (event: PointerEvent) => {
        if (event.defaultPrevented || !enabled || frozen || event.button !== 0
          || !event.isPrimary || event.pointerType !== "mouse" || !keys.includes(key)) return;
        const source = event.currentTarget as HTMLElement;
        // 只接受最近的排序卡片，交互控件与内层卡片不启动外层手势。
        if (!(event.target instanceof Element)
          || event.target.closest("[data-drag-sort-key]") !== source) return;
        const control = event.target.closest("button, input, select, textarea, a, label");
        if (control && control !== source) return;
        event.stopPropagation();
        disposeGesture();
        gestureRef.current = startPointerDrag(source, event.nativeEvent, {
          start: (point) => {
            doneRef.current = false;
            sync({ dragging: key, over: null });
            autoScrollRef.current = startDragAutoScroll(source, point, hover);
          },
          move: (point) => { hover(point); autoScrollRef.current?.move(point); },
          drop,
          cancel: reset,
        });
      },
      onClick: (event: MouseEvent) => {
        // 手势层统一拦截拖拽后的 click；正常点击继续通过原有业务入口。
        if (event.defaultPrevented) {
          event.preventDefault(); event.stopPropagation(); return;
        }
        onClick?.(event);
      },
      onDragStart: (event: DragEvent) => {
        // 属性仅保留既有样式条件，禁止进入会屏蔽滚轮的原生 DnD。
        event.preventDefault();
        event.stopPropagation();
      },
    };
  }

  function targetInList(point: DragPointer) {
    const list = listRef.current;
    if (!list) return null;
    // 实际命中必须位于本列表内，避免长分组越过滚动区后误把固定标题当成落点。
    const target = list.ownerDocument.elementFromPoint(point.x, point.y);
    return target && list.contains(target) ? target : null;
  }

  function hover(point: DragPointer) {
    const current = latestRef.current;
    const list = listRef.current;
    const target = targetInList(point);
    if (!current.dragging || !list || !target) return;
    const hit = target.closest(`[data-drag-sort-scope="${scope}"]`)?.getAttribute("data-drag-sort-key");
    if (hit && keys.includes(hit)) {
      if (hit !== current.dragging && current.over !== hit) sync({ ...current, over: hit });
      return;
    }
    // 空白首尾落点只在真实边界生效，滚动过程中不会跳到未显示的首尾卡片。
    const rect = list.getBoundingClientRect();
    const ratio = (point.y - rect.top) / Math.max(rect.height, 1);
    if (!keys.length) return;
    // 可视区边缘用于自动滚动，只有滚动已到真实首尾时才锚定列表首尾项。
    if (ratio < 0.12 && list.scrollTop <= 0) {
      if (current.over !== keys[0]) sync({ ...current, over: keys[0] });
      return;
    }
    if (ratio > 0.88 && list.scrollTop + list.clientHeight >= list.scrollHeight - 1) {
      if (current.over !== keys[keys.length - 1]) sync({ ...current, over: keys[keys.length - 1] });
      return;
    }
    // 中部空隙：维持最后悬停的卡片不做跳变。
  }

  const container = {
    ref: (element: HTMLElement | null) => { listRef.current = element; },
  };

  return { dragging, over, ordered, card, container, cancel };
}
