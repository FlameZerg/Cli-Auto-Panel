import { useState } from "react";
import { ConfigGroupDialog, type GroupAction } from "./ConfigGroupDialog";
import { ConfigGroupSection } from "./ConfigGroupSection";
import type { Bootstrap, ConfigEntry, ConfigGroupChange, Kind } from "../../types";

// 搜索仅影响展示，不改变归组；完整配置顺序继续交给既有状态库维护。
export function ConfigGroups({ data, kind, configs, search, selected, disabled, saving, error,
  onSelect, onChange, onReorder }: {
  data: Bootstrap; kind: Kind; configs: ConfigEntry[]; search: string;
  selected: string | null; disabled: boolean; saving: boolean; error: string;
  onSelect: (config: ConfigEntry) => void;
  onChange: (change: ConfigGroupChange, onSaved?: () => void) => void;
  onReorder: (order: string[], cancel: () => void) => void;
}) {
  const [action, setAction] = useState<GroupAction | null>(null);
  const groups = (data.state.configGroups ?? []).filter((group) => group.kind === kind);
  const membership = new Map(groups.flatMap((group) => group.configIds.map((id) => [id, group.id] as const)));
  const query = search.trim().toLowerCase();
  const matches = (config: ConfigEntry) =>
    `${config.aliases.join(" ")} ${config.path}`.toLowerCase().includes(query);
  const visible = configs.filter(matches);
  const sections = [
    ...groups.map((group) => ({ key: group.id, group, configs: visible.filter((config) => membership.get(config.id) === group.id) })),
    { key: "ungrouped", group: null, configs: visible.filter((config) => !membership.has(config.id)) },
  ].filter((section) => !query || section.configs.length > 0);

  return <>
    <div className="config-groups-toolbar">
      <span>{groups.length} 个分组</span>
      <button disabled={disabled} onClick={() => setAction({ type: "create" })}>新建分组</button>
    </div>
    <div className="config-list">
      {sections.map(({ key, group, configs: members }) => <ConfigGroupSection key={key}
        group={group} configs={members} allConfigs={configs} groups={groups} data={data}
        selected={selected} disabled={disabled} searching={!!query} onSelect={onSelect}
        onAssign={onChange} onReorder={onReorder}
        onRename={() => { if (group) setAction({ type: "rename", group }); }}
        onDelete={() => { if (group) setAction({ type: "delete", group }); }} />)}
      {!visible.length && <p className="empty-small">{query
        ? "没有符合条件的配置文件。"
        : "尚无配置文件，可新建别名，或手动导入受管目录中的文件。"}</p>}
    </div>
    {action && <ConfigGroupDialog action={action} kind={kind} groups={groups} disabled={disabled} saving={saving}
      error={error} onSubmit={onChange} onClose={() => setAction(null)} />}
  </>;
}
