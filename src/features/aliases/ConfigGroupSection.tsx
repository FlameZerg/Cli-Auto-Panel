import { useEffect, useRef } from "react";
import { useDragSort } from "../drag/useDragSort";
import { fileName } from "./configNames";
import type { Bootstrap, ConfigEntry, ConfigGroup, ConfigGroupChange } from "../../types";
import { useI18n } from "../../theme";

// 每组独立处理拖拽，只替换当前组在全量顺序中的槽位，不产生跨组隐式移动。
export function ConfigGroupSection({ group, configs, allConfigs, groups, data, selected,
  disabled, autoSort, groupCard, groupDragging, groupOver, onSelect, onAssign, onReorder, onRename, onDelete }: {
  group: ConfigGroup | null; configs: ConfigEntry[]; allConfigs: ConfigEntry[];
  groups: ConfigGroup[]; data: Bootstrap; selected: string | null; disabled: boolean; autoSort: boolean;
  groupCard?: ReturnType<ReturnType<typeof useDragSort<ConfigGroup>>["card"]>;
  groupDragging: boolean; groupOver: boolean;
  onSelect: (config: ConfigEntry) => void;
  onAssign: (change: ConfigGroupChange) => void;
  onReorder: (order: string[], cancel: () => void, message: string) => void;
  onRename: () => void; onDelete: () => void;
}) {
  const { t } = useI18n();
  const sortable = !disabled && !autoSort && configs.length > 1;
  const drag = useDragSort(configs, (config) => config.id, sortable, (order, moved) => {
    const members = new Set(order);
    // 只替换命中搜索的卡片槽位，隐藏卡片及其他组保持原位，后端仍接收完整排列。
    const slots = allConfigs.filter((config) => members.has(config.id)).map((config) => config.id);
    const replacements = new Map(slots.map((id, index) => [id, order[index]]));
    const config = configs.find((item) => item.id === moved);
    if (!config) { drag.cancel(); return; }
    onReorder(allConfigs.map((config) => replacements.get(config.id) ?? config.id), drag.cancel,
      t("{filename} 已移至当前列表第 {position} 位。", { filename: fileName(config.path), position: order.indexOf(moved) + 1 }));
  }, { live: false, midpoint: true });
  const title = group?.name ?? t("未分组");

  return <section {...groupCard} onClickCapture={groupCard?.onClick}
    className={`config-group ${groupDragging ? "dragging" : ""} ${groupOver ? "drag-over" : ""}`}
    aria-label={t("{name}分组", { name: title })}>
    <header className="config-group-heading">
      <h3 title={title}>{title}<span>{configs.length}</span></h3>
      {group && <div className="config-group-actions">
        <button className="quiet" disabled={disabled} aria-label={t("重命名分组 {name}", { name: title })} onClick={onRename}>{t("改名")}</button>
        <button className="quiet" disabled={disabled} aria-label={t("删除分组 {name}", { name: title })} onClick={onDelete}>{t("删除")}</button>
      </div>}
    </header>
    <div className="config-group-items" {...drag.container}>
      {drag.ordered.map((config) => <ConfigCard key={config.id} config={config} data={data}
        groups={groups} groupId={group?.id ?? ""} disabled={disabled} selected={selected === config.id}
        dragging={drag.dragging === config.id} over={drag.over === config.id}
        after={drag.after} sortable={sortable}
        card={drag.card(config.id, () => onSelect(config))} onAssign={onAssign}
        onMove={(direction) => drag.moveBy(config.id, direction)} />)}
      {!configs.length && <p className="config-group-empty">{t(group
        ? "暂无配置，可通过卡片下方的选择框移入。"
        : "暂无未分组配置。新建或导入的配置默认放在这里。")}</p>}
    </div>
  </section>;
}

function ConfigCard({ config, data, groups, groupId, disabled, selected, dragging, over, after, sortable, card, onAssign, onMove }: {
  config: ConfigEntry; data: Bootstrap; groups: ConfigGroup[]; groupId: string; disabled: boolean;
  selected: boolean; dragging: boolean; over: boolean;
  after: boolean; sortable: boolean;
  card: ReturnType<ReturnType<typeof useDragSort<ConfigEntry>>["card"]>;
  onAssign: (change: ConfigGroupChange) => void;
  onMove: (direction: number) => boolean;
}) {
  const { t } = useI18n();
  const button = useRef<HTMLButtonElement>(null);
  const keepFocus = useRef(false);
  useEffect(() => {
    if (!disabled && keepFocus.current) {
      keepFocus.current = false;
      button.current?.focus();
    }
  }, [disabled]);
  const binding = data.state.bindings.find((item) => item.configId === config.id);
  const template = binding && data.state.templates.find((item) => item.id === binding.templateId);
  const stale = binding && template?.content !== binding.appliedContent;
  const modified = binding && binding.lastHash !== config.hash;
  const health = config.error ? "读取错误" : modified ? "外部已修改" : stale || !binding ? "未同步" : "已同步";
  const warning = !!config.error || modified || stale;
  const commands = config.aliases.join(" / ");
  const filename = fileName(config.path);
  const label = commands || filename;

  const dropClass = over ? (after ? "drag-over-after" : "drag-over") : "";
  return <div className={`config-card-shell ${selected ? "selected" : ""} ${dropClass}`}
    data-drag-sort-scope={card["data-drag-sort-scope"]} data-drag-sort-key={config.id}>
    <button ref={button} disabled={disabled} {...card}
      aria-keyshortcuts={sortable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      onKeyDown={(event) => {
        if (!sortable || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        keepFocus.current = onMove(event.key === "ArrowUp" ? -1 : 1);
      }}
      className={`config-card ${dragging ? "dragging" : ""} ${selected ? "selected" : ""}`}>
      <div className="card-label"><strong>{commands || t("手动导入")}</strong>
        <span className={`status ${warning ? "warning" : binding ? "synced" : ""}`}
          title={config.error || t(health)}>{t(health)}</span></div>
      <span className="card-path" title={config.path}>{filename}</span>
      <span className="card-template">{template?.name || t("保留原配置，可手动选择模板")}</span>
    </button>
    {/* 归组控件置于卡片按钮之外，避免嵌套交互元素及选择分组时误打开编辑器。 */}
    <label className="config-group-select">{t("分组")}
      <select value={groupId} disabled={disabled} aria-label={t("设置 {name} 的分组", { name: label })}
        onChange={(event) => onAssign({
          type: "assignConfigGroup", configId: config.id, groupId: event.target.value || null,
        })}>
        <option value="">{t("未分组")}</option>
        {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select>
    </label>
  </div>;
}
