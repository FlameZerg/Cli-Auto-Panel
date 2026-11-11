import type { DragPointer } from "./dragAutoScroll";

interface DragCallbacks {
  start: (point: DragPointer) => void;
  move: (point: DragPointer) => void;
  drop: (point: DragPointer) => void;
  cancel: () => void;
}

// 浮层只提供拖动反馈，不参与命中、键盘导航或真实列表布局。
function dragFeedback(source: HTMLElement, initial: DragPointer) {
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.draggable = false;
  Object.assign(ghost.style, {
    position: "fixed", width: `${rect.width}px`, maxHeight: "50vh", overflow: "hidden",
    margin: "0", pointerEvents: "none", opacity: ".8", zIndex: "10000", boxSizing: "border-box",
  });
  source.ownerDocument.body.appendChild(ghost);
  return {
    move: (point: DragPointer) => {
      ghost.style.left = `${point.x - (initial.x - rect.left)}px`;
      ghost.style.top = `${point.y - (initial.y - rect.top)}px`;
    },
    remove: () => ghost.remove(),
  };
}

// 只替换手势输入：不启动原生 DnD，让滚轮在按住鼠标拖动期间仍能正常派发。
export function startPointerDrag(source: HTMLElement, initial: PointerEvent, callbacks: DragCallbacks) {
  const document = source.ownerDocument;
  const view = document.defaultView;
  if (!view) return null;
  const root = document.documentElement;
  const origin = { x: initial.clientX, y: initial.clientY };
  const originalCursor = root.style.cursor;
  const originalSelection = root.style.userSelect;
  let active = false;
  let disposed = false;
  let feedback: ReturnType<typeof dragFeedback> | null = null;

  const suppressClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancelPointer, true);
    document.removeEventListener("lostpointercapture", cancelPointer, true);
    document.removeEventListener("keydown", keyDown, true);
    view.removeEventListener("blur", cancel);
    if (root.hasPointerCapture(initial.pointerId)) root.releasePointerCapture(initial.pointerId);
    feedback?.remove();
    if (active) {
      root.style.cursor = originalCursor;
      root.style.userSelect = originalSelection;
      // 捕获松手后的 click，包含落在其他卡片上的情况；下一轮正常点击不受影响。
      view.setTimeout(() => document.removeEventListener("click", suppressClick, true), 0);
    }
  };

  const cancel = () => {
    dispose();
    callbacks.cancel();
  };

  const move = (event: PointerEvent) => {
    if (event.pointerId !== initial.pointerId || disposed) return;
    if (!(event.buttons & 1)) { cancel(); return; }
    const point = { x: event.clientX, y: event.clientY };
    // 保留轻点与短距离移动的点击语义，达到阈值才启动排序。
    if (!active && Math.hypot(point.x - origin.x, point.y - origin.y) < 6) return;
    event.preventDefault();
    if (!active) {
      active = true;
      try {
        feedback = dragFeedback(source, origin);
        root.style.cursor = "grabbing";
        root.style.userSelect = "none";
        document.addEventListener("click", suppressClick, true);
        // 捕获在稳定的根节点上，避免排序移动源卡片时丢失指针捕获。
        root.setPointerCapture(initial.pointerId);
        callbacks.start(point);
      } catch (failure) {
        // 初始化失败也清理手势与浮层，保留原始错误，不静默降级。
        cancel();
        throw failure;
      }
    }
    feedback?.move(point);
    callbacks.move(point);
  };

  const up = (event: PointerEvent) => {
    if (event.pointerId !== initial.pointerId || event.button !== 0 || disposed) return;
    const wasActive = active;
    if (wasActive) event.preventDefault();
    dispose();
    if (wasActive) callbacks.drop({ x: event.clientX, y: event.clientY });
  };

  const cancelPointer = (event: PointerEvent) => {
    if (event.pointerId === initial.pointerId && !disposed) cancel();
  };

  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (active) { event.preventDefault(); event.stopPropagation(); }
    cancel();
  };

  document.addEventListener("pointermove", move, { capture: true, passive: false });
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", cancelPointer, true);
  document.addEventListener("lostpointercapture", cancelPointer, true);
  document.addEventListener("keydown", keyDown, true);
  view.addEventListener("blur", cancel);
  return dispose;
}
