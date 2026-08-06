# Spec: Steam Workshop mod downloads (SteamCMD)

Status: **BUILT + browser-verified (2026-08-01).** Owner-directed, analogous to the
Nexus auto-download but Steam-specific. Connect an owning Steam account, install
Workshop mods from a URL straight into the running community/proxy UE4SS stack.
Verified live: QualityOfLife installed + working; Workshop links shown; framework
items blocked.

## 1. Goal
Let an operator connect a Steam account so the dashboard can **auto-download Steam
Workshop mods** and install them into the server's existing UE4SS/PalSchema/pak
layout — the Steam parallel of the Nexus integration.

## 2. Why it's not a Nexus clone
- **Anonymous can't download paid-game Workshop content** (verified: `+login
  anonymous +workshop_download_item 1623730 …` → `failed`). Needs an account that
  **owns Palworld**.
- Steam login = username + password + a **Steam Guard 2FA code that changes every
  time** — not a static token. After a successful login SteamCMD caches a **session
  token**; persisting it lets later downloads run non-interactively until it expires.

## 3. Connect = one-time interactive shell login (session-only)
The in-dashboard password + Steam Guard web form was **built then removed** — it
can't work for email Guard: a stateless 2-step web form spawns a fresh SteamCMD
process per submit, each triggering a NEW code, so codes go stale in a loop, and a
failed attempt can corrupt the cached session. Connecting is now a **single
interactive shell session** the operator runs once:
```
docker exec -it -e HOME=/app/data/steam palworld-server-dashboard \
  /opt/steamcmd/steamcmd.sh +login <username> +quit
```
It prompts for password + one Guard code and caches the session in `STEAM_HOME`
(`/app/data/steam`). **The password never touches the dashboard or browser.**

**Security model:**
- We persist **only the cached SteamCMD session** (in `STEAM_HOME`, the `/app/data`
  volume). No password is stored anywhere. A compromised host leaks a session token,
  not the account password.
- Use a **dedicated secondary account** that owns Palworld (nothing else attached).
- Admin-only; opt-in; dormant with no session. `data/steam*` gitignored.

## 4. Architecture — SteamCMD in the dashboard image
- The dashboard container has **no Docker access** (security model) and the game
  container's SteamCMD isn't reachable — so SteamCMD is installed **into the
  dashboard image** (Debian bookworm/glibc; i386 libs; bootstrap baked at build).
- Runs as the **non-root `nextjs` user (uid 2001)** — running SteamCMD as root breaks
  a real account's Steam-cloud writes (verified). `HOME=STEAM_HOME` in `/app/data`
  holds the session; downloads land in the already-mounted game dir
  (`/palworld-game/steamapps/workshop/content/1623730`), visible to both containers.
- No host units, no flag files.

## 5. Status + session (lib/steam.ts)
- **Source of truth is the SteamCMD session, not a side file.** `readSessionUsername()`
  parses the logged-in account from `STEAM_HOME/Steam/config/config.vdf`
  (`Accounts → <name>`); `resolveUsername()` prefers it. So a missing/`Disconnect`ed
  side file can't make a valid session look disconnected.
- `getSteamStatus()` — cheap (reads config.vdf, no SteamCMD spawn): `configured` +
  `connected` + `username`.
- `validateSteamSession()` — real check for the **Test** button: `+login <user> +quit`
  with the cached session → `classifyLogin === 'ok'`.
- `clearSteamAccount()` — **Disconnect**: removes the account file + `config.vdf` +
  `STEAM_HOME` (truly signs out).
- **`classifyLogin()` hardening (cost two live-debug rounds):** SteamCMD output is
  finicky — (a) it emits ANSI color codes (`runSteamcmd` strips them), and (b) it
  injects interstitial text inside status lines and prints unrelated lowercase
  "failed" during bootstrap. So success keys on the **login-response line**
  (`… to Steam Public...OK`), NOT `Waiting for user info...OK` alone and NOT a blanket
  "no FAILED anywhere".
- `app/api/steam`: GET status; POST **test** / **disconnect** (admin). No `connect`
  action (see §3).
- Panel Settings → "Steam account · Workshop": connected → Connected-as + Test +
  Disconnect; not connected → the copyable one-time shell command + **Refresh**.

## 6. Install from a Workshop URL (Option B — into the proxy layout)
The official Workshop-*layout* loader was shelved after a live failure (see
official-workshop-mods.md). Instead, a downloaded item is installed into the
**community proxy layout** the running UE4SS/PalSchema already use — no loader swap,
no regime change, no server-stop.
- `parseWorkshopId()` (URL or bare id); `downloadWorkshopItem(id)` — `+force_install_dir
  <GAME_DIR> +login <user> +workshop_download_item 1623730 <id> +quit` (cached
  session) → item lands at `GAME_DIR/steamapps/workshop/content/1623730/<id>/`; reads
  `Info.json`. Clear "session expired — reconnect" on a login failure.
- `installWorkshopPackageToProxy(contentDir, itemId)` (lib/game-mods.ts): read the
  item's `Info.json` `InstallRule`; for each server-applicable (`IsServer:true`) rule,
  copy its Targets into the mapped proxy folder —
  `Lua` → `Win64/ue4ss/Mods/<PackageName>/` (+ `mods.txt`);
  `PalSchema` → `…/PalSchema/mods/<PackageName>/`;
  `Paks` → `~mods`; `LogicMods` → `Paks/LogicMods`; `UE4SS` skipped (already have it).
  Path-traversal guarded; targets deduped per Type.
  - **PalSchema-target placement (fix, 2026-08-06, `87ac2a6`).** The two mod kinds
    place their Targets differently, and this bit the FIRST PalSchema-type Workshop
    mod on the box (Super Stacks No Lag, id `3770035710`). A **Lua** mod's Targets
    (`./Scripts`, `./enabled.txt`) name folders that belong verbatim under
    `Mods/<pkg>/` — the folder name is kept. A **PalSchema** mod's Target is a
    `./PalSchema/` **wrapper** whose *contents* map to `PalSchema/mods/<pkg>/` (the
    real layout is `<pkg>/blueprints|raw/…`, cf. `AncientCoreDrops/raw/…`). Copying
    the wrapper verbatim (`copyTargets` default) landed the payload a level too deep
    (`<pkg>/PalSchema/blueprints/…`) and PalSchema loaded nothing. `copyTargets` now
    takes a `flatten` flag — the PalSchema branch strips the wrapper (copies the
    target's contents into dest); Lua/pak keep the old preserve-name behavior. (Paks
    were always flattened into `~mods` by `copyPaksFlat`, so unaffected.) The earlier
    "validated against synthetic PalSchema packages" claim was optimistic — the
    synthetic didn't use the real `./PalSchema/` wrapper convention.
  - **Live-verified 2026-08-06** against a 5-mod bulk add: 3 Lua (Alpha&Lucky Pal
    Surgery, Base Radius Improved, Smart Pal Feeding) → `ue4ss/Mods` + enabled; 1 pak
    (Pal Surgery Table Unlocker) → `~mods`; 1 PalSchema (Super Stacks No Lag) → now
    `<pkg>/blueprints/…`, `[PalSchema] Loading mod: SuperStacksNoLag` on restart with
    no "empty mod" warning. A full scan of all 17 PalSchema mod folders found no other
    wrapper-nested casualty; the pre-existing QualityOfLife (Lua+pak) was unaffected.
- `app/api/steam/workshop` (POST, admin + connected): download → install-to-proxy.
  `game-mods-panel`: "Install from Steam Workshop URL" box (shown when connected).
  Restart to load.

## 7. Guards, links, nesting
- **Framework blocker:** the UE4SS + PalSchema framework Workshop items (ids
  `3625223587`, `3625280368`; PackageNames `UE4SSExperimentalPW`, `PalSchema`, and
  `shared`) are refused — by id in the route (`isFrameworkWorkshopId`) and by
  PackageName in the installer — so a Workshop copy can't clobber the operator's
  installed UE4SS/PalSchema.
- **Steam Workshop links:** each installed mod's Workshop item is recorded
  (`data/steam-mods.json`; `readSteamMods`/`setSteamMod`/`removeFromSteamMods`). The
  mod row shows a **"Steam Workshop ↗"** link (the parallel of the Nexus link) and
  the **Nexus chip is suppressed** for Steam-linked mods. GET /api/game-mods returns
  `steamLinks`; DELETE cleans them up. Keyed `ue4ss:<pkg>` (Lua parent, paks nest
  under it) or `pak:<file>` for pak-only.
  - **PalSchema-only Workshop mods** (no Lua row, no pak row) are now recorded under
    `palschema:<pkg>` (fix `87ac2a6` — previously they installed **untracked**).
    Caveat: PalSchema submods aren't listed as their own rows in the Mods tab (they're
    managed under the PalSchema framework, like every other PalSchema mod), so this
    key has no visible row to attach a link to yet — it's recorded for association
    integrity, not UI. A dedicated PalSchema-submod row/link is a possible follow-up.
- **Hybrid nesting:** a mod that drops both a UE4SS part and pak(s) records a
  mod-group so its paks nest (collapsed) under the UE4SS row — same as Nexus hybrids.
- **Update detection + one-click update (BUILT 2026-08-06).** Workshop exposes an update
  TIMESTAMP, not a version. The installed baseline is already on disk — SteamCMD records
  each item's `timeupdated` in `steamapps/workshop/appworkshop_1623730.acf` — so no
  install-time bookkeeping. `lib/steam.ts`: `readInstalledWorkshopTimes()` (line-scan the
  acf VDF), `fetchWorkshopUpdateTimes()` (Steam's PUBLIC `GetPublishedFileDetails`, no
  key), `getSteamModUpdates()` → `updateAvailable` when live `time_updated` > installed.
  `GET /api/steam/workshop` returns `{updates}` keyed by itemId (works with NO connected
  account — public API; only the update itself needs a session). Panel: `loadSteam` also
  fetches updates; a Steam-linked row shows **`↑ update`** (amber, dated tooltip
  "Workshop updated YYYY-MM-DD; you installed …") + **`↑ update now`** when connected —
  which just re-POSTs the item to the install path (SteamCMD pulls latest → re-convert →
  acf heals). Mirrors the Nexus update chips. **No version string** (Workshop limitation);
  the chip shows dates. Verified live: aged an item's acf time → chip + `↑ update now` →
  re-download → `updateAvailable` cleared; browser 3/3.

## 8. Public release
- Ships **opt-in and dormant**. Documented that Workshop download needs the operator's
  own owning account (dedicated recommended); otherwise Nexus or manual download
  remain. The "no Steam creds on the server" posture is the default; this is the
  explicit opt-in, and even then only a session token (never a password) is stored.

## 9. Out of scope
- Storing the password / fully unattended re-login (rejected: session-only + shell login).
- Uploading/publishing to the Workshop; browsing all of Workshop in-dashboard.
- The official Workshop-layout loader (shelved; see official-workshop-mods.md).
