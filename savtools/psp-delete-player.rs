// Vendored BUILD HELPER (not upstream code). Removes a player from the WORLD
// save (Level.sav) so the game prompts fresh character creation on next join
// (deleting Players/<uid>.sav alone does NOT: the game regenerates it from
// Level.sav). Then WRITES the re-encoded Level.sav back atomically. See NOTICE.
//
// GUILD HANDLING (2026-07-25) -- learned from a live failure: psp-core's
// delete_player removes the character but REFUSES (Ok(false)) whenever the
// player is their guild's admin, and every solo player is the admin of their
// own auto-created one-person "Unnamed Guild". So deleting the character while
// leaving that orphan guild behind left a dangling group->character reference
// and the game rejected the rejoin with FailedInvalidLoginPlayerCharacterHandle.
//
// Policy (keyed on the SAFE signal -- guild membership -- which coincides with
// the owner's "unnamed personal guild" rule for solo players):
//   * guild has <= 1 member (the player's own personal guild) -> delete the
//     WHOLE guild via delete_guild_and_players (cascades char/pals/containers/
//     base AND removes the group-map entry -> no orphan). deleted=true.
//   * guild has > 1 members:
//       - player is NOT admin -> delete_player (drops just them, keeps guild).
//       - player IS admin      -> REFUSE (deleted=false, reason "guild_admin"):
//         deleting a multi-member guild's admin needs a transfer/guild removal
//         first; the caller surfaces the guild name for a warning.
//   * no guild -> delete_player (character/pals/containers only).
// Server MUST be stopped and a backup taken by the caller BEFORE this runs.
//
// Contract: `psp-delete-player <world-dir> <data-dir> <player-uid-32hex>` ->
// JSON on stdout: {"deleted":bool,"nickname":str,"reason"?:str,"guild_name"?:str,
// "guild_named"?:bool,"member_count"?:int,"guild_deleted"?:bool}.
// Exit 1 on a load/delete/write error, 2 on a read/arg error.
use psp_core::domain::guild::{delete_guild_and_players, find_player_guild_id, get_guild_details};
use psp_core::domain::player::delete_player;
use psp_core::gamedata::GameData;
use psp_core::progress::null_progress;
use psp_core::session::{PlayerFileData, SaveKind, SaveSession};
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

// "Unnamed Guild" (or an empty name) is the game's auto-created default -- a
// personal guild the player never renamed. A non-default name means a guild
// the operator likely cares about, worth a louder warning in the UI.
fn is_named_guild(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty() && trimmed != "Unnamed Guild"
}

fn main() {
    let mut args = std::env::args().skip(1);
    let save_dir = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| die(2, "usage: psp-delete-player <world-dir> <data-dir> <player-uid>"));
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

    let nickname = session
        .player_summaries
        .get(&target)
        .map(|p| p.nickname.clone())
        .unwrap_or_default();

    session
        .ensure_player_loaded(target)
        .unwrap_or_else(|e| die(1, &format!("player not loadable: {e:?}")));

    // Resolve the player's guild, if any, and decide by member count / admin.
    let guild_id = find_player_guild_id(&mut session, target)
        .unwrap_or_else(|e| die(1, &format!("guild lookup error: {e:?}")));

    let mut guild_name = String::new();
    let mut guild_named = false;
    let mut member_count: usize = 0;
    let mut guild_deleted = false;

    if let Some(gid) = guild_id {
        let details = get_guild_details(&mut session, &game_data, gid)
            .unwrap_or_else(|e| die(1, &format!("guild details error: {e:?}")))
            .unwrap_or_else(|| die(1, "guild vanished between lookup and load"));
        guild_name = details.name.clone().unwrap_or_default();
        guild_named = is_named_guild(&guild_name);
        member_count = details.players.len();
        let is_admin = details.admin_player_uid == Some(target);

        if member_count <= 1 {
            // The player's own personal guild -- delete it whole so no orphan
            // group entry survives to reject the rejoin.
            delete_guild_and_players(&mut session, &game_data, gid, &progress)
                .unwrap_or_else(|e| die(1, &format!("delete guild error: {e:?}")));
            guild_deleted = true;
        } else if is_admin {
            // Multi-member guild admin -- refuse; nothing written.
            println!(
                "{}",
                serde_json::json!({
                    "deleted": false,
                    "nickname": nickname,
                    "reason": "guild_admin",
                    "guild_name": guild_name,
                    "guild_named": guild_named,
                    "member_count": member_count,
                })
            );
            return;
        } else {
            // Non-admin member of a shared guild -- drop just this player.
            let ok = delete_player(&mut session, &game_data, target, &progress)
                .unwrap_or_else(|e| die(1, &format!("delete player error: {e:?}")));
            if !ok {
                // delete_player only returns false for the admin case, which we
                // already handled -- treat an unexpected false as a refusal.
                println!(
                    "{}",
                    serde_json::json!({
                        "deleted": false,
                        "nickname": nickname,
                        "reason": "guild_admin",
                        "guild_name": guild_name,
                        "guild_named": guild_named,
                        "member_count": member_count,
                    })
                );
                return;
            }
        }
    } else {
        // No guild at all -- delete the character/pals/containers directly.
        delete_player(&mut session, &game_data, target, &progress)
            .unwrap_or_else(|e| die(1, &format!("delete player error: {e:?}")));
    }

    // Re-encode Level.sav and write it back atomically (temp + rename). The dir
    // is 0777 so uid 2001 can replace the game-user-owned file; the game
    // re-chowns on start.
    let out_bytes = session
        .level_sav_bytes()
        .unwrap_or_else(|e| die(1, &format!("re-encode Level.sav: {e:?}")));
    let tmp = save_dir.join("Level.sav.psp-tmp");
    std::fs::write(&tmp, &out_bytes).unwrap_or_else(|e| die(1, &format!("write temp: {e}")));
    std::fs::rename(&tmp, &level_path).unwrap_or_else(|e| die(1, &format!("rename: {e}")));

    println!(
        "{}",
        serde_json::json!({
            "deleted": true,
            "nickname": nickname,
            "guild_name": guild_name,
            "guild_named": guild_named,
            "member_count": member_count,
            "guild_deleted": guild_deleted,
        })
    );
}
