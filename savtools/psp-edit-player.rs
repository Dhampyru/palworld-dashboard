// Vendored BUILD HELPER (not upstream code). Edits ONE player's basic stats in
// the world save (Level.sav) for the Save Inspector's Stage 3 editing (roadmap
// #5): level, exp, current HP, stomach, sanity, the per-stat status-point
// allocations, AND their Pals (per-Pal level + one-shot "heal all"). See NOTICE.
//
// SAFE-BY-CONSTRUCTION: it builds the player's FULL current DTO via
// build_player_dto, mutates ONLY the fields named in the patch, then applies it
// with psp-core's update_players -> apply_player_dto. Every other field (techs,
// quests, inventory, Pals) is round-tripped unchanged. All edited fields live in
// the character-map inside Level.sav, so ONLY Level.sav is written (the player
// .sav, which only carries techs/quests here, is left untouched). Server MUST be
// stopped and a backup taken by the caller BEFORE this runs.
//
// Contract: `psp-edit-player <world-dir> <data-dir> <player-uid-32hex> <patch>`
// where <patch> is a JSON object, any subset of:
//   {"level":int,"exp":int,"hp":int,"stomach":number,"sanity":number,
//    "status_points":{"<stat>":int,...},
//    "pals":{"heal_all":bool,"levels":{"<pal-instance-uuid>":int,...}},
//    "items":{"<container-label>":{"<slot-index>":count,...},...}}
//      container-label: Inventory|Key Items|Weapons|Equipment|Food; count 0
//      removes the slot; counts clamp to the item's max_stack_count.
// -> JSON on stdout echoing the applied values:
//   {"ok":true,"nickname":str,"level","exp","hp","stomach","sanity",
//    "status_points":{...},"healed":bool,"pals_updated":[uuid,...]}
// Only EXISTING status-point stats are editable; unknown keys are ignored. Pal
// level edits apply before heal_all so a heal (which resets Hp) always wins.
// Exit 1 on a load/apply/write error, 2 on a read/arg error.
use psp_core::domain::pal::{heal_all_player_pals, update_pals};
use psp_core::domain::player::{build_player_dto, update_players};
use psp_core::dto::container::ItemContainerDto;
use psp_core::dto::ordered_map::OrderedMap;
use psp_core::dto::pal::PalDto;
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

// Edit existing item counts in one container: `edits` maps slot_index -> new
// count (0 removes the slot). Each count is clamped to the item's real
// max_stack_count from items.json (so gear stays 1, stackables cap correctly).
// apply_player_dto writes these containers back, so mutating the DTO is the
// whole edit. Adding NEW items is deliberately out of scope for now.
fn edit_container(
    container: &mut Option<ItemContainerDto>,
    edits: &serde_json::Map<String, Value>,
    items: Option<&Value>,
) {
    let Some(c) = container.as_mut() else {
        return;
    };
    for (idx_str, cnt) in edits {
        let (Ok(idx), Some(count)) = (idx_str.parse::<i32>(), cnt.as_i64()) else {
            continue;
        };
        if let Some(slot) = c.slots.iter_mut().find(|s| s.slot_index == idx) {
            if count <= 0 {
                // Removal: mark the slot "None" and KEEP it in the DTO --
                // apply_item_container_dto deletes a raw slot only when it sees
                // an incoming "None" for that index. Dropping the slot from the
                // DTO instead would leave the item untouched (apply upserts only
                // the slots present in the DTO).
                slot.static_id = Some("None".to_string());
                slot.count = 0;
                slot.dynamic_item = None;
            } else {
                let max = slot
                    .static_id
                    .as_deref()
                    .and_then(|id| items.and_then(|m| m.get(id)))
                    .and_then(|m| m.get("max_stack_count"))
                    .and_then(Value::as_i64)
                    .unwrap_or(9999);
                slot.count = count.clamp(1, max) as i32;
            }
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let save_dir = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| die(2, "usage: psp-edit-player <world-dir> <data-dir> <player-uid> <patch-json>"));
    let data_dir = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| die(2, "data-dir required"));
    let target = args
        .next()
        .and_then(|s| uid_from_stem(&s))
        .unwrap_or_else(|| die(2, "valid 32-hex player uid required"));
    let patch: Value = args
        .next()
        .map(|s| serde_json::from_str(&s).unwrap_or_else(|e| die(2, &format!("bad patch json: {e}"))))
        .unwrap_or_else(|| die(2, "patch json required"));

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

    let mut dto = build_player_dto(&session, &game_data, target)
        .unwrap_or_else(|e| die(1, &format!("build player error: {e:?}")))
        .unwrap_or_else(|| die(1, "player has no character in the world save"));

    // --- apply ONLY the fields present in the patch, clamped to sane ranges ---
    if let Some(v) = patch.get("level").and_then(Value::as_i64) {
        dto.level = v.clamp(1, 255);
    }
    if let Some(v) = patch.get("exp").and_then(Value::as_i64) {
        dto.exp = v.max(0);
    }
    if let Some(v) = patch.get("hp").and_then(Value::as_i64) {
        dto.hp = v.max(0);
    }
    if let Some(v) = patch.get("stomach").and_then(Value::as_f64) {
        dto.stomach = v.clamp(0.0, 200.0);
    }
    if let Some(v) = patch.get("sanity").and_then(Value::as_f64) {
        dto.sanity = v.clamp(0.0, 100.0);
    }
    if let Some(sp) = patch.get("status_points").and_then(Value::as_object) {
        // Rebuild the list in its existing order, overriding only stats the
        // player already has (unknown stats are ignored -- apply_status_points
        // only updates existing rows anyway).
        let mut new_sp = OrderedMap::new();
        for (stat, cur) in dto.status_point_list.iter() {
            let next = sp.get(stat).and_then(Value::as_i64).unwrap_or(*cur).max(0);
            new_sp.insert(stat.clone(), next);
        }
        dto.status_point_list = new_sp;
    }
    // Item-count edits per container (keyed by the same display labels the UI
    // shows). apply_player_dto writes these containers back with the DTO.
    if let Some(items) = patch.get("items").and_then(Value::as_object) {
        let meta = game_data.get("items");
        let mut apply = |kind: &str, container: &mut Option<ItemContainerDto>| {
            if let Some(edits) = items.get(kind).and_then(Value::as_object) {
                edit_container(container, edits, meta);
            }
        };
        apply("Inventory", &mut dto.common_container);
        apply("Key Items", &mut dto.essential_container);
        apply("Weapons", &mut dto.weapon_load_out_container);
        apply("Equipment", &mut dto.player_equipment_armor_container);
        apply("Food", &mut dto.food_equip_container);
    }

    // Capture the echo values (and a snapshot of the player's Pals for level
    // edits) before the DTO is moved into update_players.
    let nickname = dto.nickname.clone();
    let (level, exp, hp, stomach, sanity) = (dto.level, dto.exp, dto.hp, dto.stomach, dto.sanity);
    let status_points: serde_json::Map<String, Value> = dto
        .status_point_list
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    let current_pals: OrderedMap<Uuid, PalDto> = dto.pals.clone();

    let mut modified: OrderedMap<Uuid, _> = OrderedMap::new();
    modified.insert(target, dto);
    update_players(&mut session, &game_data, &modified, &progress)
        .unwrap_or_else(|e| die(1, &format!("apply error: {e:?}")));

    // --- Pal edits (optional) ---
    let mut healed = false;
    let mut pals_updated: Vec<String> = Vec::new();
    if let Some(pals_patch) = patch.get("pals").and_then(Value::as_object) {
        // Per-Pal level FIRST: round-trip each targeted Pal's full current DTO
        // with only its level changed (unknown/foreign instance ids ignored).
        if let Some(levels) = pals_patch.get("levels").and_then(Value::as_object) {
            let mut modified_pals: OrderedMap<Uuid, PalDto> = OrderedMap::new();
            for (id_str, val) in levels {
                let (Ok(pid), Some(new_level)) = (Uuid::parse_str(id_str), val.as_i64()) else {
                    continue;
                };
                if let Some(pal) = current_pals.get(&pid) {
                    let mut edited = pal.clone();
                    edited.level = new_level.clamp(1, 255);
                    modified_pals.insert(pid, edited);
                    pals_updated.push(id_str.clone());
                }
            }
            if !modified_pals.is_empty() {
                update_pals(&mut session, &game_data, &modified_pals, &progress)
                    .unwrap_or_else(|e| die(1, &format!("update pals error: {e:?}")));
            }
        }
        // heal_all AFTER, so its Hp/stomach/sanity reset wins over any level apply.
        if pals_patch.get("heal_all").and_then(Value::as_bool).unwrap_or(false) {
            heal_all_player_pals(&mut session, &game_data, target)
                .unwrap_or_else(|e| die(1, &format!("heal pals error: {e:?}")));
            healed = true;
        }
    }

    // Only Level.sav changed. Re-encode and write it back atomically (temp +
    // rename); the 0777 dir lets uid 2001 replace the game-user-owned file, and
    // the game re-chowns on start.
    let out_bytes = session
        .level_sav_bytes()
        .unwrap_or_else(|e| die(1, &format!("re-encode Level.sav: {e:?}")));
    let tmp = save_dir.join("Level.sav.psp-tmp");
    std::fs::write(&tmp, &out_bytes).unwrap_or_else(|e| die(1, &format!("write temp: {e}")));
    std::fs::rename(&tmp, &level_path).unwrap_or_else(|e| die(1, &format!("rename: {e}")));

    println!(
        "{}",
        json!({
            "ok": true,
            "nickname": nickname,
            "level": level,
            "exp": exp,
            "hp": hp,
            "stomach": stomach,
            "sanity": sanity,
            "status_points": status_points,
            "healed": healed,
            "pals_updated": pals_updated,
        })
    );
}
