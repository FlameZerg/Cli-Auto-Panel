use crate::model::{ApplyPlan, ConfigGroup, PanelState, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LayoutState {
    pub revision: u64,
    pub config_order: Vec<String>,
    pub template_order: Vec<String>,
    pub config_groups: Vec<ConfigGroup>,
}

pub(crate) fn layout(state: &PanelState) -> LayoutState {
    LayoutState {
        revision: state.layout_revision,
        config_order: state.config_order.clone(),
        template_order: state.template_order.clone(),
        config_groups: state.config_groups.clone(),
    }
}

pub(crate) fn compose(state: &PanelState, layout: &LayoutState) -> PanelState {
    PanelState {
        layout_revision: layout.revision,
        config_order: layout.config_order.clone(),
        template_order: layout.template_order.clone(),
        config_groups: layout.config_groups.clone(),
        ..state.clone()
    }
}

pub(crate) fn business(state: &PanelState) -> PanelState {
    // 模板的持久化顺序与显示顺序分离，比较时只采用稳定的业务身份顺序。
    let mut templates = state.templates.clone();
    templates.sort_by(|a, b| a.id.cmp(&b.id));
    PanelState {
        templates, layout_revision: 0, config_order: Vec::new(),
        config_groups: Vec::new(), template_order: Vec::new(), ..state.clone()
    }
}

pub(crate) fn same_business(left: &PanelState, right: &PanelState) -> Result<bool> {
    Ok(serde_json::to_value(business(left)).map_err(|e| e.to_string())?
        == serde_json::to_value(business(right)).map_err(|e| e.to_string())?)
}

pub(crate) fn same_layout(left: &PanelState, right: &PanelState) -> Result<bool> {
    let left = LayoutState { revision: 0, ..layout(left) };
    let right = LayoutState { revision: 0, ..layout(right) };
    Ok(serde_json::to_value(left).map_err(|e| e.to_string())?
        == serde_json::to_value(right).map_err(|e| e.to_string())?)
}

pub(crate) fn next_revision(revision: u64) -> Result<u64> {
    let next = revision.checked_add(1).ok_or("状态版本已达到上限。")?;
    // SQLite 的整数范围与前端安全整数范围均不得溢出。
    if next > 9_007_199_254_740_991 { return Err("状态版本超过前端安全整数范围。".into()); }
    Ok(next)
}

pub(crate) fn finish_layout(before: &PanelState, next: &PanelState) -> Result<PanelState> {
    let template_order = next.template_order.iter()
        .filter(|id| next.templates.iter().any(|template| &template.id == *id))
        .cloned().chain(next.templates.iter()
            .filter(|template| !next.template_order.contains(&template.id))
            .map(|template| template.id.clone())).collect();
    let normalized = PanelState { template_order, ..next.clone() };
    let revision = if same_layout(before, &normalized)? {
        before.layout_revision
    } else { next_revision(before.layout_revision)? };
    Ok(PanelState { layout_revision: revision, ..normalized })
}

pub(crate) fn legacy(state: &PanelState) -> PanelState {
    // 旧记录中的模板数组同时承担显示顺序，比较旧记录前恢复该投影。
    let mut templates = state.templates.clone();
    templates.sort_by_key(|template| state.template_order.iter()
        .position(|id| id == &template.id).unwrap_or(usize::MAX));
    PanelState { templates, layout_revision: 0, template_order: Vec::new(), ..state.clone() }
}

pub(crate) fn restore_layout(current: &PanelState, backup: &ApplyPlan) -> LayoutState {
    let mut next = layout(current);
    // 只逆转配置身份迁移，保留用户在配置保存之后进行的其他布局调整。
    for change in backup.identity_changes.iter().rev() {
        if let Some(after) = &change.after {
            next.config_order = next.config_order.iter().filter_map(|id| {
                if id == after { change.before.clone() } else { Some(id.clone()) }
            }).collect();
            next.config_groups = next.config_groups.iter().map(|group| ConfigGroup {
                config_ids: group.config_ids.iter().filter_map(|id| {
                    if id == after { change.before.clone() } else { Some(id.clone()) }
                }).collect(), ..group.clone()
            }).collect();
        } else if let Some(before) = &change.before {
            if backup.before_state.config_order.contains(before) && !next.config_order.contains(before) {
                next.config_order.push(before.clone());
            }
            // 被用户后来删除的分组不复活；恢复的配置留在未分组。
            let original = backup.before_state.config_groups.iter()
                .find(|group| group.config_ids.contains(before));
            if let Some(original) = original {
                next.config_groups = next.config_groups.iter().map(|group| {
                    if group.id == original.id && !group.config_ids.contains(before) {
                        ConfigGroup {
                            config_ids: group.config_ids.iter().cloned()
                                .chain(std::iter::once(before.clone())).collect(), ..group.clone()
                        }
                    } else { group.clone() }
                }).collect();
            }
        }
    }
    next
}
