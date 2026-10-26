use crate::model::{ConfigGroup, Inventory, Kind, PanelState, Result};

// 后端统一校验名称，避免直接调用接口绕过界面的长度及重名限制。
pub fn save(
    state: &PanelState, id: Option<&str>, name: &str, kind: Kind,
) -> Result<Vec<ConfigGroup>> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        return Err("分组名称必须为 1～120 个字符，且不能包含控制字符。".into());
    }
    if name == "未分组" {
        return Err("“未分组”是系统保留名称，请使用其他分组名称。".into());
    }
    let previous = id.map(|id| {
        state.config_groups.iter().find(|group| group.id == id).ok_or("分组不存在，请刷新清单。")
    }).transpose()?;
    if previous.is_some_and(|group| group.kind != kind) {
        return Err("不能修改其他产品的分组。".into());
    }
    if state.config_groups.iter().any(|group| {
        group.kind == kind && Some(group.id.as_str()) != id && group.name == name
    }) {
        return Err("当前产品已有同名分组，请使用其他名称。".into());
    }
    let next = ConfigGroup {
        id: id.map(str::to_owned).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: name.into(), kind,
        config_ids: previous.map(|group| group.config_ids.clone()).unwrap_or_default(),
    };
    Ok(if previous.is_some() {
        state.config_groups.iter().map(|group| {
            if group.id == next.id { next.clone() } else { group.clone() }
        }).collect()
    } else {
        state.config_groups.iter().cloned().chain(std::iter::once(next)).collect()
    })
}

pub fn delete(state: &PanelState, id: &str) -> Result<Vec<ConfigGroup>> {
    if !state.config_groups.iter().any(|group| group.id == id) {
        return Err("分组不存在，请刷新清单。".into());
    }
    // 删除容器即解除成员归属，文件、别名与模板绑定全部保留。
    Ok(state.config_groups.iter().filter(|group| group.id != id).cloned().collect())
}

pub fn assign(
    state: &PanelState, inventory: &Inventory, config_id: &str, group_id: Option<&str>,
) -> Result<Vec<ConfigGroup>> {
    let entry = inventory.configs.iter().find(|config| config.id == config_id)
        .ok_or("配置不在当前受管清单中，请刷新清单。")?;
    if let Some(id) = group_id {
        let target = state.config_groups.iter().find(|group| group.id == id)
            .ok_or("目标分组不存在，请刷新清单。")?;
        if target.kind != entry.kind {
            return Err("不能跨 Codex / Claude 移动配置分组。".into());
        }
    }
    // 先从所有旧组移除，再只加入目标组，保证一张卡片最多属于一个组。
    Ok(state.config_groups.iter().map(|group| {
        let members = group.config_ids.iter().filter(|id| id.as_str() != config_id).cloned();
        let config_ids = if Some(group.id.as_str()) == group_id {
            members.chain(std::iter::once(config_id.to_owned())).collect()
        } else {
            members.collect()
        };
        ConfigGroup { config_ids, ..group.clone() }
    }).collect())
}

// 重命名和真实删除复用同一成员迁移规则；不修改传入状态或原分组对象。
pub fn rekey(state: &PanelState, old_id: &str, new_id: Option<&str>) -> Vec<ConfigGroup> {
    state.config_groups.iter().map(|group| {
        let config_ids = group.config_ids.iter().filter_map(|id| {
            if id == old_id { new_id.map(str::to_owned) } else { Some(id.clone()) }
        }).collect();
        ConfigGroup { config_ids, ..group.clone() }
    }).collect()
}
