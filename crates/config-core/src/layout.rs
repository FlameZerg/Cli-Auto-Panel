use crate::{config_groups, model::*, state};

pub(crate) fn is_change(change: &Change) -> bool {
    matches!(change, Change::ReorderTemplates { .. } | Change::ReorderConfigs { .. }
        | Change::SaveConfigGroup { .. } | Change::DeleteConfigGroup { .. }
        | Change::AssignConfigGroup { .. })
}

fn validate_order(order: &[String], expected: Vec<String>) -> Result<()> {
    let mut sorted = order.to_vec();
    sorted.sort();
    let mut expected = expected;
    expected.sort();
    if sorted != expected { return Err("排序清单已变化，请刷新后重新排序。".into()); }
    Ok(())
}

pub(crate) fn prepare(
    current: &PanelState, inventory: &Inventory, change: Change,
) -> Result<PanelState> {
    // 布局入口只允许白名单操作，无法借此改写模板正文、绑定或真实文件。
    let next = match change {
        Change::ReorderTemplates { kind, order } => {
            validate_order(&order, current.templates.iter()
                .filter(|template| template.kind == kind).map(|template| template.id.clone()).collect())?;
            let other = current.template_order.iter().filter(|id| {
                current.templates.iter().any(|template| &template.id == *id && template.kind != kind)
            }).cloned();
            PanelState { template_order: order.iter().cloned().chain(other).collect(), ..current.clone() }
        }
        Change::ReorderConfigs { order } => {
            let first = order.first().ok_or("显示顺序不能为空。")?;
            let kind = inventory.configs.iter().find(|entry| &entry.id == first)
                .ok_or("配置清单已变化，请刷新。")?.kind;
            validate_order(&order, inventory.configs.iter()
                .filter(|entry| entry.kind == kind).map(|entry| entry.id.clone()).collect())?;
            let other = current.config_order.iter().filter(|id| {
                inventory.configs.iter().any(|entry| &entry.id == *id && entry.kind != kind)
            }).cloned();
            let mut merged: Vec<String> = order.iter().cloned().chain(other).collect();
            for entry in &inventory.configs {
                if !merged.contains(&entry.id) { merged.push(entry.id.clone()); }
            }
            PanelState { config_order: merged, ..current.clone() }
        }
        Change::SaveConfigGroup { id, name, kind } => PanelState {
            config_groups: config_groups::save(current, id.as_deref(), &name, kind)?,
            ..current.clone()
        },
        Change::DeleteConfigGroup { id } => PanelState {
            config_groups: config_groups::delete(current, &id)?, ..current.clone()
        },
        Change::AssignConfigGroup { config_id, group_id } => PanelState {
            config_groups: config_groups::assign(current, inventory, &config_id, group_id.as_deref())?,
            ..current.clone()
        },
        _ => return Err("此入口只允许保存列表布局。".into()),
    };
    let next = state::finish_layout(current, &next)?;
    if state::same_layout(current, &next)? { return Err("没有需要保存的布局变化。".into()); }
    Ok(next)
}
