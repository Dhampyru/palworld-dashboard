// Vendored BUILD HELPER (not upstream code). Loads a Palworld world save
// (Level.sav + Players/*.sav) via psp-core's session API and prints a domain
// summary as JSON: players (nickname/level/pal_count/guild), guilds, and every
// Pal (species/level/owner/talents). Read-only. See savtools/NOTICE.
//
// Built as `psp-core/examples/psp-inspect.rs` inside the pinned fork so it links
// against psp-core in its own workspace (Dockerfile `savtools` stage). Needs the
// game-data JSON dir (psp-core/GameData) for friendly Pal names.
//
// Contract: `psp-inspect <world-dir> <game-data-json-dir>` -> JSON on stdout
// (exit 0). Exit 1 on a load/parse error, 2 on a read error.
use psp_core::domain::pal::pal_summaries;
use psp_core::gamedata::GameData;
use psp_core::progress::null_progress;
use psp_core::session::{PlayerFileData, SaveKind, SaveSession};
use std::collections::BTreeMap;
use std::path::PathBuf;
use uuid::Uuid;

// A Players/*.sav filename is a 32-hex PlayerUId; turn it into a UUID.
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

fn main() {
    let mut args = std::env::args().skip(1);
    let save_dir = match args.next() {
        Some(p) => PathBuf::from(p),
        None => {
            eprintln!("usage: psp-inspect <world-dir> <game-data-json-dir>");
            std::process::exit(2);
        }
    };
    let data_dir = match args.next() {
        Some(p) => PathBuf::from(p),
        None => {
            eprintln!("game-data-json-dir required");
            std::process::exit(2);
        }
    };

    let level_path = save_dir.join("Level.sav");
    let level_bytes = match std::fs::read(&level_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("read Level.sav: {e}");
            std::process::exit(2);
        }
    };
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
                continue; // paired with its main .sav below
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
    let session = match SaveSession::load(
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
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("load error: {e:?}");
            std::process::exit(1);
        }
    };

    let game_data = match GameData::load(&data_dir) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("game data error: {e:?}");
            std::process::exit(1);
        }
    };
    let pals = match pal_summaries(&session, &game_data) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("pal summaries error: {e:?}");
            std::process::exit(1);
        }
    };

    let out = serde_json::json!({
        "players": session.player_summaries.values().collect::<Vec<_>>(),
        "guilds": session.guild_summaries.values().collect::<Vec<_>>(),
        "pals": pals,
    });
    print!("{}", serde_json::to_string(&out).unwrap());
}
