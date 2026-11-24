import { useState } from "react";
import { ConfigGroupDialog, type GroupAction } from "./ConfigGroupDialog";
import { ConfigGroupSection } from "./ConfigGroupSection";
import { configMatches } from "./configNames";
import { useDragSort } from "../drag/useDragSort";
import type { Bootstrap, ConfigEntry, ConfigGroupChange, Kind } from "../../types";
import { useI18n } from "../../theme";

// 搜索仅影响展示，不改变归组；完整配置顺序继续交给既有状态库维护。
export function ConfigGroups({ data, kind, configs, search, selected, disabled, autoSort, saving, error,
  onSelect, onChange, onReorder, onReorderGroups }: {
  data: Bootstrap; kind: Kind; configs: ConfigEntry[]; search: string;
  selected: string | null; disabled: boolean; autoSort: boolean; saving: boolean; error: string;
  onSelect: (config: ConfigEntry) => void;
  onChange: (change: ConfigGroupChange, onSaved?: () => void) => void;
  onReorder: (order: string[], cancel: () => void, message: string) => void;
  onReorderGroups: (order: string[], cancel: () => void) => void;
}) {
  const { t } = useI18n();
  const [action, setAction] = useState<GroupAction | null>(null);
  const groups = (data.state.configGroups ?? []).filter((group) => group.kind === kind);
  const membership = new Map(groups.flatMap((group) => group.configIds.map((id) => [id, group.id] as const)));
  const query = search.trim().toLowerCase();
  // 整组排序严格复用卡片拖拽；未分组固定末尾，搜索中不提交残缺排列。
  // live=false：拖动中列表保持静止，仅由分组头浮层与落点指示线表达插入位置，松手一次性插入。
  const drag = useDragSort(groups, (group) => group.id, !disabled && !query && groups.length > 1,
    (order) => onReorderGroups(order, drag.cancel), { live: false });
  const visible = configs.filter((config) => configMatches(config, query));
  const sections = [
    ...drag.ordered.map((group) => ({ key: group.id, group, configs: visible.filter((config) => membership.get(config.id) === group.id) })),
    { key: "ungrouped", group: null, configs: visible.filter((config) => !membership.has(config.id)) },
  ].filter((section) => !query || section.configs.length > 0);

  return <>
    <div className="config-groups-toolbar">
      <span>{t("{count} 个分组", { count: groups.length })}</span>
      <button disabled={disabled} onClick={() => setAction({ type: "create" })}>{t("新建分组")}</button>
    </div>
    <div className="config-list" {...drag.container}>
      {sections.map(({ key, group, configs: members }) => <ConfigGroupSection key={key}
        group={group} configs={members} allConfigs={configs} groups={groups} data={data}
        selected={selected} disabled={disabled} autoSort={autoSort} onSelect={onSelect}
        groupCard={group ? drag.card(group.id, undefined,
          // 拖动整组时浮层只显示分组头，避免大容器半透明块遮挡落点指示。
          { ghostOf: (section) => section.querySelector<HTMLElement>(".config-group-heading") }) : undefined}
        groupDragging={drag.dragging === key} groupOver={drag.over === key}
        onAssign={onChange} onReorder={onReorder}
        onRename={() => { if (group) setAction({ type: "rename", group }); }}
        onDelete={() => { if (group) setAction({ type: "delete", group }); }} />)}
      {!visible.length && <p className="empty-small">{t(query
        ? "没有符合条件的配置文件。"
        : "尚无配置文件，可新建别名，或手动导入受管目录中的文件。")}</p>}
    </div>
    {action && <ConfigGroupDialog action={action} kind={kind} groups={groups} disabled={disabled} saving={saving}
      error={error} onSubmit={onChange} onClose={() => setAction(null)} />}
  </>;
}
