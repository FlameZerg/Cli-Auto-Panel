export interface DragPointer { x: number; y: number }

// 组内列表不滚动时向上查找，卡片、整组与通用配置复用实际滚动容器。
function scrollContainer(source: HTMLElement): HTMLElement | null {
  const view = source.ownerDocument.defaultView;
  if (!view) return null;
  for (let parent = source.parentElement; parent; parent = parent.parentElement) {
    if (parent.scrollHeight > parent.clientHeight
      && /^(auto|scroll)$/.test(view.getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

function scrollBounds(container: HTMLElement, view: Window) {
  const rect = container.getBoundingClientRect();
  return {
    top: Math.max(0, rect.top + container.clientTop),
    bottom: Math.min(view.innerHeight, rect.top + container.clientTop + container.clientHeight),
    left: Math.max(0, rect.left),
    right: Math.min(view.innerWidth, rect.right),
  };
}

// 捕获期间允许拉到窗口外及屏幕上下边缘；始终滚动原列表，不切换到相邻列。
function withinScrollRange(pointer: DragPointer, bounds: ReturnType<typeof scrollBounds>, height: number) {
  const atWindowEdge = pointer.y <= 24 || pointer.y >= height - 24;
  const inColumn = pointer.x >= bounds.left && pointer.x <= bounds.right;
  return bounds.bottom > bounds.top && (inColumn || atWindowEdge);
}

// 指针停在边缘时持续滚动，滚轮和动画帧共用当前列及滚动后的命中刷新。
export function startDragAutoScroll(
  source: HTMLElement, initial: DragPointer, onScroll: (point: DragPointer) => void,
) {
  const container = scrollContainer(source);
  const document = source.ownerDocument;
  const view = document.defaultView;
  if (!container || !view) return null;
  let pointer = initial;
  let frame: number | null = null;
  let lastTime: number | null = null;
  let wheelUntil = 0;
  let stopped = false;

  const pause = () => {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    lastTime = null;
  };

  const tick = (time: number) => {
    frame = null;
    if (stopped || !container.isConnected) return;
    const bounds = scrollBounds(container, view);
    if (!withinScrollRange(pointer, bounds, view.innerHeight)) {
      lastTime = null;
      return;
    }
    const { top, bottom } = bounds;
    const edge = Math.min(120, (bottom - top) / 3);
    const distance = Math.max(0, Math.min(pointer.y - top, bottom - pointer.y, edge));
    const direction = pointer.y - top < edge ? -1 : 1;
    const speed = direction * 600 * (1 - distance / edge);
    if (!speed) { lastTime = null; return; }
    // 手动滚轮短暂优先，避免边缘自动滚动抵消反向滚轮操作。
    if (time < wheelUntil) {
      lastTime = null;
      frame = view.requestAnimationFrame(tick);
      return;
    }
    const elapsed = lastTime === null ? 1 / 60 : Math.min((time - lastTime) / 1000, 0.032);
    const before = container.scrollTop;
    // 直接更新当前列，避免平滑滚动排队或带动页面及相邻列表。
    container.scrollTop = before + speed * elapsed;
    if (container.scrollTop === before) {
      lastTime = null;
      return;
    }
    lastTime = time;
    onScroll(pointer);
    if (!stopped) frame = view.requestAnimationFrame(tick);
  };

  const move = (point: DragPointer) => {
    pointer = point;
    if (frame === null && !stopped) frame = view.requestAnimationFrame(tick);
  };

  const wheel = (event: WheelEvent) => {
    if (stopped || !container.isConnected || event.defaultPrevented || event.ctrlKey || !event.deltaY) return;
    const point = { x: event.clientX, y: event.clientY };
    const bounds = scrollBounds(container, view);
    // 屏幕边缘扩展只用于自动滚动，手动滚轮仍限定原列的横向范围。
    if (bounds.bottom <= bounds.top || point.x < bounds.left || point.x > bounds.right) return;
    // 统一像素、行、页三种单位；只阻止当前列的默认滚动，不吞掉其他列或缩放手势。
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? Number.parseFloat(view.getComputedStyle(container).fontSize)
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? container.clientHeight : 1;
    event.preventDefault();
    pause();
    wheelUntil = view.performance.now() + 250;
    container.scrollTop += event.deltaY * unit;
    onScroll(point);
    move(point);
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    pause();
    document.removeEventListener("wheel", wheel, true);
  };

  document.addEventListener("wheel", wheel, { capture: true, passive: false });
  move(initial);
  return { move, stop };
}
