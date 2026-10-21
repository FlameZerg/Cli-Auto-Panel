import { useEffect, useRef, useState } from "react";
import type { DragEvent, MouseEvent } from "react";

// 轻量列表拖拽排序：仅依赖原生 HTML5 Drag & Drop，不引入第三方库。
// 交互模型：
//   拖动中 → 预览顺序（preview）即时重排，其他卡片通过 CSS transform 平滑让位；
//   落手   → 冻结预览顺序（frozen，乐观更新）并静默提交，杜绝"弹回旧序再跳新序"的闪烁与延迟感；
//   成功   → 提交返回的 items 顺序对齐后自动解冻；
//   失败   → 由调用方调用 cancel() 立即回弹到状态库权威顺序。
// 所有关键跨事件状态（dragging/over）一律以 ref 为准，state 只做渲染镜像：
//   drop/dragover 是异步事件序列，卡片重渲染随时可能清空 state，ref 保证提交不丢失。
export function useDragSort<T>(
  items: T[],
  keyOf: (item: T) => string,
  enabled: boolean,
  commit: (order: string[]) => void,
) {
  const [render, setRender] = useState<{ dragging: string | null; over: string | null }>({ dragging: null, over: null });
  const [frozen, setFrozen] = useState<string[] | null>(null);
  // 状态镜像：事件处理器内部一律读取 ref，避免 state 闭包过期。
  const renderRef = useRef(render);
  renderRef.current = render;
  // 拦截卡片 drop 冒泡到容器后造成的重复提交；drop 闭包也可能跨渲染存活。
  const doneRef = useRef(true);
  // drop 后抑制源元素 click：防止松手瞬间误触打开编辑器/导航打断乐观冻结。
  const suppressClickRef = useRef(false);
  // 最近一次拖拽的键用 ref 保存：dragend 时 state 可能已被 drop 清空。
  const latestRef = useRef<{ dragging: string | null; over: string | null }>({ dragging: null, over: null });

  const keys = items.map(keyOf);
  const joined = keys.join("\u0000");

  // 状态库权威顺序一旦变化（提交成功对齐 / 任何外部刷新），一律解除乐观冻结。
  useEffect(() => { setFrozen(null); }, [joined]);

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
    renderRef.current = next;
    setRender(next);
  }

  function reset() {
    doneRef.current = true;
    sync({ dragging: null, over: null });
  }

  function cancel() {
    // 提交失败回滚：立即放弃乐观顺序。
    setFrozen(null);
    reset();
  }

  function drop(event: DragEvent) {
    const current = latestRef.current;
    if (!current.dragging) return;
    event.preventDefault();
    // 阻断后续 click 派发：HTML5 DnD 规范里 drop 后浏览器仍可能对源元素派发
    // click（尤其零位移/短位移场景）。不拦的话配置卡片会打开编辑器并触发 busy，
    // 干扰乐观冻结状态；模板卡片则会被导航打断。全局 snap 标记由 click 消费。
    suppressClickRef.current = true;
    setTimeout(() => { suppressClickRef.current = false; }, 0);
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
      onClick: (event: MouseEvent) => {
        // 拖拽手势结束后的 click 是浏览器派发的噪声事件，统一吞掉；
        // 业务 onClick 必须经由本包装调用（JSX 里展开顺序会覆盖同名属性）。
        if (suppressClickRef.current) { event.preventDefault(); return; }
        onClick?.(event);
      },
      onDragStart: (event: DragEvent) => {
        event.dataTransfer.effectAllowed = "move";
        // Chromium 在没有 setData 时不会真正启动拖拽动作。
        event.dataTransfer.setData("text/plain", key);
        doneRef.current = false;
        sync({ dragging: key, over: null });
      },
      onDragOver: (event: DragEvent) => {
        const current = renderRef.current;
        if (!current.dragging || key === current.dragging) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (current.over !== key) sync({ ...current, over: key });
      },
      onDrop: drop,
      onDragEnd: reset,
    };
  }

  function containerDragOver(event: DragEvent) {
    const current = renderRef.current;
    if (!current.dragging) return;
    event.preventDefault();
    // 边缘放置支持：光标在列表几何范围的首/尾区间时，直接锚定到边界卡片，
    // 使"拖到最前 / 最后"成为合法落点（中间区间由卡片级 dragOver 覆盖）。
    const list = event.currentTarget as HTMLElement;
    const rect = list.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
    if (!keys.length) return;
    if (ratio < 0.12) { if (current.over !== keys[0]) sync({ ...current, over: keys[0] }); return; }
    if (ratio > 0.88) { if (current.over !== keys[keys.length - 1]) sync({ ...current, over: keys[keys.length - 1] }); return; }
    // 中部空隙：维持最后悬停的卡片不做跳变。
  }

  const container = {
    onDragOver: containerDragOver,
    onDrop: drop,
  };

  return { dragging, over, ordered, card, container, cancel };
}
