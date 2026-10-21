import { useDragSort } from "../drag/useDragSort";
import type { Bootstrap, ConfigEntry, ConfigGroup, ConfigGroupChange } from "../../types";

// 每组独立处理拖拽，只替换当前组在全量顺序中的槽位，不产生跨组隐式移动。
export function ConfigGroupSection({ group, configs, allConfigs, groups, data, selected,
  disabled, searching, onSelect, onAssign, onReorder, onRename, onDelete }: {
  group: ConfigGroup | null; configs: ConfigEntry[]; allConfigs: ConfigEntry[];
  groups: ConfigGroup[]; data: Bootstrap; selected: string | null; disabled: boolean; searching: boolean;
  onSelect: (config: ConfigEntry) => void;
  onAssign: (change: ConfigGroupChange) => void;
  onReorder: (order: string[], cancel: () => void) => void;
  onRename: () => void; onDelete: () => void;
}) {
  const drag = useDragSort(configs, (config) => config.id, !disabled && !searching, (order) => {
    const members = new Set(order);
    // 后端仍接收当前产品的完整排列；其他组和未分组的相对位置保持不变。
    const slots = allConfigs.filter((config) => members.has(config.id)).map((config) => config.id);
    const replacements = new Map(slots.map((id, index) => [id, order[index]]));
    onReorder(allConfigs.map((config) => replacements.get(config.id) ?? config.id), drag.cancel);
  });
  const title = group?.name ?? "未分组";

  return <section className="config-group" aria-label={`${title}分组`}>
    <header className="config-group-heading">
      <h3 title={title}>{title}<span>{configs.length}</span></h3>
      {group && <div className="config-group-actions">
        <button className="quiet" disabled={disabled} aria-label={`重命名分组 ${title}`} onClick={onRename}>改名</button>
        <button className="quiet" disabled={disabled} aria-label={`删除分组 ${title}`} onClick={onDelete}>删除</button>
      </div>}
    </header>
    <div className="config-group-items" {...drag.container}>
      {drag.ordered.map((config) => <ConfigCard key={config.id} config={config} data={data}
        groups={groups} groupId={group?.id ?? ""} disabled={disabled} selected={selected === config.id}
        dragging={drag.dragging === config.id} over={drag.over === config.id}
        card={drag.card(config.id, () => onSelect(config))} onAssign={onAssign} />)}
      {!configs.length && <p className="config-group-empty">{group
        ? "暂无配置，可通过卡片下方的选择框移入。"
        : "暂无未分组配置。新建或导入的配置默认放在这里。"}</p>}
    </div>
  </section>;
}

function ConfigCard({ config, data, groups, groupId, disabled, selected, dragging, over, card, onAssign }: {
  config: ConfigEntry; data: Bootstrap; groups: ConfigGroup[]; groupId: string; disabled: boolean;
  selected: boolean; dragging: boolean; over: boolean;
  card: ReturnType<ReturnType<typeof useDragSort<ConfigEntry>>["card"]>;
  onAssign: (change: ConfigGroupChange) => void;
}) {
  const binding = data.state.bindings.find((item) => item.configId === config.id);
  const template = data.state.templates.find((item) => item.id === binding?.templateId);
  // 继续使用实际应用快照判断同步状态，分组不改变配置或绑定的健康信息。
  const health = config.error ? "读取错误" : binding
    ? binding.lastHash !== config.hash ? "外部已修改"
      : template?.content !== binding.appliedContent ? "待同步" : "已同步"
    : "未绑定";
  const warning = config.error || health === "外部已修改" || health === "待同步";
  const label = config.aliases.join(" / ") || config.path.split(/[\\/]/).pop() || "手动导入";

  return <div className={`config-card-shell ${selected ? "selected" : ""}`}>
    <button disabled={disabled} {...card}
      className={`config-card ${dragging ? "dragging" : ""} ${over ? "drag-over" : ""} ${selected ? "selected" : ""}`}>
      <div className="card-label"><strong>{config.aliases.join(" / ") || "手动导入"}</strong>
        <span className={`status ${warning ? "warning" : binding ? "synced" : ""}`}>{health}</span></div>
      <span className="card-path" title={config.path}>{config.path.split(/[\\/]/).pop()}</span>
      <span className="card-template">{template ? template.name : "保留原配置，可手动选择模板"}</span>
    </button>
    {/* 归组控件置于卡片按钮之外，避免嵌套交互元素及选择分组时误打开编辑器。 */}
    <label className="config-group-select">分组
      <select value={groupId} disabled={disabled} aria-label={`设置 ${label} 的分组`}
        onChange={(event) => onAssign({
          type: "assignConfigGroup", configId: config.id, groupId: event.target.value || null,
        })}>
        <option value="">未分组</option>
        {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
      </select>
    </label>
  </div>;
}
