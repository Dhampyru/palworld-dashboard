// Vendored BUILD HELPER (not upstream code). Reads ONE player's inventory from
// the world save for the read-only Save Inspector (roadmap #5). Loads the
// session, builds the player DTO via psp-core, and emits their five item
// containers (main inventory, key items, weapons, equipment, food) as JSON.
// Pure read -- never writes. See NOTICE.
//
// Item friendly names are NOT in the bundled game data (Palworld keeps those in
// localization files we don't ship), so each slot carries the raw item id plus
// what items.json does have: category/rarity/weight, and for gear the dynamic
// durability/ammo/passives. Same honest ID-first shape as the RCON picker.
//
// Contract: `psp-player <world-dir> <data-dir> <player-uid-32hex>` -> JSON on
// stdout: {"uid","nickname","level","exp","hp","stomach","sanity",
// "containers":[{"kind","slots":[{"slot","id","count",...}]}]}.
// Exit 1 on a load/build error, 2 on a read/arg error.
use psp_core::domain::player::build_player_dto;
use psp_core::dto::container::ItemContainerDto;
use psp_core::gamedata::GameData;
use psp_core::progress::null_progress;
use psp_core::session::{PlayerFileData, SaveKind, SaveSession};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use uuid::Uuid;

fn uid_from_stem(stem: &str) -> Option<Uuid> {
    if stem.len() != 32 || !stem.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let d = format!(
        "{}-{}-{}-{}-{}",
        &stem[0..8],
        &stem[8..12],
        &stem[12..16],
        &stem[16..20],
        &stem[20..32]
    );
    Uuid::parse_str(&d).ok()
}

fn die(code: i32, msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(code);
}

// Serialize one item container to JSON, dropping empty slots and enriching each
// item from items.json metadata (category/rarity/weight) + any dynamic data.
fn container_json(kind: &str, container: &Option<ItemContainerDto>, items: Option<&Value>) -> Value {
    let slots: Vec<Value> = container
        .as_ref()
        .map(|cont| {
            cont.slots
                .iter()
                .filter_map(|slot| {
                    let id = slot.static_id.clone().filter(|s| !s.is_empty())?;
                    if slot.count <= 0 {
                        return None;
                    }
                    let meta = items.and_then(|m| m.get(&id));
                    let mut o = json!({ "slot": slot.slot_index, "id": id, "count": slot.count });
                    if let Some(m) = meta {
                        if let Some(v) = m.get("group") {
                            o["category"] = v.clone();
                        }
                        if let Some(v) = m.get("type_a") {
                            o["type"] = v.clone();
                        }
                        if let Some(v) = m.get("rarity") {
                            o["rarity"] = v.clone();
                        }
                        if let Some(v) = m.get("weight") {
                            o["weight"] = v.clone();
                        }
                        if let Some(v) = m.get("max_stack_count") {
                            o["max_stack"] = v.clone();
                        }
                    }
                    if let Some(dyn_item) = &slot.dynamic_item {
                        if let Some(d) = dyn_item.durability {
                            o["durability"] = json!(d);
                        }
                        if let Some(b) = dyn_item.remaining_bullets {
                            o["bullets"] = json!(b);
                        }
                        if let Some(p) = &dyn_item.passive_skills {
                            if !p.is_empty() {
                                o["passives"] = json!(p);
                            }
                        }
                    }
                    Some(o)
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "kind": kind, "slots": slots })
}

fn main() {
    let mut args = std::env::args().skip(1);
    let save_dir = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| die(2, "usage: psp-player <world-dir> <data-dir> <player-uid>"));
    let data_dir = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| die(2, "data-dir required"));
    let target = args
        .next()
        .and_then(|s| uid_from_stem(&s))
        .unwrap_or_else(|| die(2, "valid 32-hex player uid required"));

    let level_path = save_dir.join("Level.sav");
    let level_bytes = std::fs::read(&level_path).unwrap_or_else(|e| die(2, &format!("read Level.sav: {e}")));
    let level_meta = std::fs::read(save_dir.join("LevelMeta.sav")).ok();
    let world_option = std::fs::read(save_dir.join("WorldOption.sav")).ok();

    let players_dir = save_dir.join("Players");
    let mut refs: BTreeMap<Uuid, PlayerFileData> = BTreeMap::new();
    if let Ok(entries) = std::fs::read_dir(&players_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(".sav") else {
                continue;
            };
            if stem.ends_with("_dps") {
                continue;
            }
            let Some(uid) = uid_from_stem(stem) else {
                continue;
            };
            let dps = players_dir.join(format!("{stem}_dps.sav"));
            refs.insert(
                uid,
                PlayerFileData::Paths {
                    sav: Some(entry.path()),
                    dps: dps.exists().then_some(dps),
                },
            );
        }
    }

    let progress = null_progress();
    let mut session = SaveSession::load(
        SaveKind::Steam {
            level_path: level_path.clone(),
        },
        save_dir.to_string_lossy().into_owned(),
        "steam",
        &level_bytes,
        level_meta.as_deref(),
        world_option.as_deref(),
        refs,
        None,
        false,
        &progress,
    )
    .unwrap_or_else(|e| die(1, &format!("load error: {e:?}")));

    let game_data = GameData::load(&data_dir).unwrap_or_else(|e| die(1, &format!("game data error: {e:?}")));

    session
        .ensure_player_loaded(target)
        .unwrap_or_else(|e| die(1, &format!("player not loadable: {e:?}")));

    let dto = build_player_dto(&session, &game_data, target)
        .unwrap_or_else(|e| die(1, &format!("build player error: {e:?}")))
        .unwrap_or_else(|| die(1, "player has no character in the world save"));

    // Per-stat status-point allocations (HP/Attack/Weight/...), so the Inspect
    // dialog can both show them and prefill the Stage 3 edit form from one fetch.
    let status_points: serde_json::Map<String, Value> = dto
        .status_point_list
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();

    let items = game_data.get("items");
    let containers = json!([
        container_json("Inventory", &dto.common_container, items),
        container_json("Key Items", &dto.essential_container, items),
        container_json("Weapons", &dto.weapon_load_out_container, items),
        container_json("Equipment", &dto.player_equipment_armor_container, items),
        container_json("Food", &dto.food_equip_container, items),
    ]);

    println!(
        "{}",
        json!({
            "uid": dto.uid,
            "nickname": dto.nickname,
            "level": dto.level,
            "exp": dto.exp,
            "hp": dto.hp,
            "stomach": dto.stomach,
            "sanity": dto.sanity,
            "status_points": status_points,
            "containers": containers,
        })
    );
}
