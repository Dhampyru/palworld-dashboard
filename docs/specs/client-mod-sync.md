# Spec: Client Mod-Sync & Onboarding

Status: **Phase 1 BUILT (2026-07-27); Phase 2 RE-SCOPED 2026-08-06 — client-mod INTAKE +
LOADOUT GENERATOR built & tested (see §7). Remaining: manifest-v2 delivery variants
(sync-script / FSA) + real in-game client verification.**
The manifest + Invite tab ship (server info + per-pak client download + copy-invite).
Phase 2 (the "let friends install it easily" automation) was re-scoped after the Steam
Workshop feature, the Nexus/Steam compatibility work, and the mod catalog all landed —
they change what a client actually needs (see §2a–§2c and the rewritten §7). Public-
release goal (owner, 2026-08-06): *any* admin installs the dashboard, loads the mods
they want (Nexus **or** Steam), and gets a one-click way to align their friends — the
same ability the owner has. Still needs an explicit "start" before any code.

## 1. Goal
Help the people joining a modded server get their client into a matching state with
minimum friction: see what the server runs, check their own install against it, and
pull down the client-side files they're missing — plus give the admin a clean way
to invite and align friends.

## 2. Scope & the key simplifying truth
For a **dedicated server, clients almost only need the `.pak` files.** This is what
makes the feature tractable:
- **Pak mods** load via the game's own pak system → the client needs them.
- **PalSchema mods** run server-side (the JSON never touches the client). Only their
  **pak** parts (already pak mods) matter to the client.
- **Classic UE4SS Lua/BP mods**, **UE4SS itself**, and **PalSchema itself** run
  **server-side** → clients do NOT install these.
- **Game version** must match, but **Steam enforces that** — a version-mismatched
  client can't join at all. The tool can only *report* a mismatch and point the
  player at Steam; it cannot patch the game.

So the actual sync target is: *"make the client's `Pal/Content/Paks/~mods/` pak set
match the server's client-required paks."* UE4SS/PalSchema/game versions are shown
for **information/diagnosis**, not installed on the client.

## 2a. Correction — the CLIENT-ONLY mod category (added 2026-08-06)
§2's "clients almost only need paks" holds for mods the **server** runs (a gameplay
mod's Lua/JSON stays server-side; the client just needs the matching pak). But it MISSES
a second, large category the owner's real mod set surfaced: **client-only mods** — the
cosmetic / UI / FOV / QoL mods that run **entirely on the client** and are **not on the
server at all.** In the owner's `mod_data` catalog, **51 of 121 are "Client only,"** and
**~78 need to be on a friend's client** once the "BOTH — server AND every client" mods
are counted. Many are **UE4SS Lua** mods, so the client needs **UE4SS itself + the
Lua/pak files**, not just paks. So the sync target is bigger than §2 assumed:
- **Server-parity paks** (the "BOTH" set): match the server's `~mods` — Phase 1's list.
- **Client-only mods** (the 51): the client runs them; needs a client UE4SS runtime +
  the mod files. Never installed on the server (some are explicitly "DISABLED on servers"
  / "author does NOT support servers" — putting them server-side would be wrong).

## 2b. The client runtime problem (added 2026-08-06)
A client has **two mutually-exclusive UE4SS runtimes** — the same conflict the server's
`ModRegime` handles (only ONE is ever live):
- **Steam Workshop UE4SS** — subscribe to the `UE4SSExperimentalPW` (`3625223587`) +
  `PalSchema` (`3625280368`) framework Workshop items + each mod; Steam downloads to
  `steamapps/workshop/content/1623730/` and the game's Workshop loader reads
  `Info.json`/`InstallRule` (Pocketpair's PalworldModUploader format). Easiest onboarding
  (subscribe, no directory work) — but ONLY for mods that are **on** the Workshop, so it
  strands Nexus-only mods.
- **Classic UE4SS** — `dwmapi.dll` proxy + `ue4ss/Mods/` + `mods.txt` + `~mods` paks:
  manual, but **universal** (Nexus, Workshop, loose paks) and self-contained.

**Clients don't have the dashboard's Steam/Nexus compatibility system**, so they must
pick ONE runtime and can't mix. That's the friction the owner flagged.

## 2c. Resolution — the DASHBOARD generates the client loadout (added 2026-08-06)
The dashboard already reconciles Nexus + Steam mods into the classic proxy layout for
the **server**; a "client loadout" is that same machinery packaged for a friend: **UE4SS
(classic) + the selected client mods laid out in `ue4ss/Mods/` + `~mods`.** Delivered as
a run-a-script OR extract-a-zip, so the friend drops it into their Palworld install —
**no runtime choice, no Workshop subscription, no directory work**, and it covers Nexus +
Workshop mods uniformly. Version parity is free (built from the same mods the server runs).
This answers "who builds the directory loadout" — **the dashboard does**, because it's the
only side with the compatibility knowledge. Classic (not Workshop) is the target: it's
universal (handles Nexus-only mods) and self-contained (the loader ships in the loadout).
A **Steam Workshop Collection** link is a nice secondary path for the Workshop-only subset
(friend hits "subscribe all"), but can't be primary — it strands Nexus mods.

## 3. Server-side manifest
The dashboard already reads everything needed (game REST `/v1/api/info`,
`readUe4ssStatus`, `readPalSchemaStatus`, `listPakMods` / `listUe4ssMods` /
`listPalSchemaSubmods`). Add a manifest the admin can share, e.g.:

```jsonc
{
  "serverName": "Palkatraz",
  "gameVersion": "v1.0.1.100619",
  "ue4ss":     { "source": "experimental-palworld", "sha": "c838a8ac" }, // info only
  "palschema": { "version": "0.6.1" },                                    // info only
  "clientMods": [                                                         // the sync set
    { "file": "William_MoreHairs_P.pak", "sizeBytes": 66059793, "sha256": "…", "source": "…" }
  ],
  "generatedAt": "…"
}
```
`clientMods` is the **admin-curated** list of client-required paks (default: all
`~mods` paks; admin can trim). `sha256` lets the client detect mismatches, not just
absence.

## 4. Redistribution stance (owner's call — dashboard is NOT a mod CDN)
The dashboard must not become a public host for third-party mod files (Nexus etc.
have their own terms). Instead:
- The dashboard **generates the manifest + a customizable sync-script template**;
  the admin **curates** the set and decides where the files are actually served from
  (their own share, a link, etc.).
- Any "serve the pak to the client" path is **opt-in and admin-owned** — the admin
  accepts responsibility for what they redistribute to their own community.
- Ship **guidance** for admins on making/curating their own script rather than a
  one-size CDN. This keeps the project clean for public release.

## 5. Client sync — approaches (a browser page can't write to the game folder by default)
1. **Standalone sync tool** (small script/app the player runs — PowerShell/Python/
   .NET). Reads the manifest, hashes local `~mods`, downloads mismatches, drops them
   in. Most robust; any OS/browser; could even install client-side UE4SS if a mod
   ever needed it. **Cost:** distributing + running an executable (trust / AV flags).
   Fits the "admin curates their own script" model best — the dashboard generates a
   filled-in template.
2. **Browser sync via the File System Access API** (`showDirectoryPicker()`). Player
   picks their `~mods` folder once, grants permission, the page writes the paks.
   **No separate app.** **Cost:** Chromium-only (Chrome/Edge), paks-only, requires a
   file source the page can fetch from (see §4).

### 5a. Comparison
| | Browser FSA | Standalone script |
|---|---|---|
| Friend installs anything? | No — just the browser | Yes — download + run a script/exe |
| Browser support | Chromium only (Chrome/Edge/Opera); **not** Firefox/Safari | Any (browser-irrelevant) |
| OS | Any (Chromium) | Any |
| Needs dashboard public over HTTPS | **Yes** (FSA needs a secure context; page fetches manifest+paks) | Only if it pulls from the dashboard; admin can host files elsewhere instead |
| Can write paks to `~mods` | Yes (user grants folder access) | Yes |
| Can install UE4SS / patch game | No (files-in-picked-folder only) | Could, if ever needed (not needed today) |
| Integrity check (SHA-256) | Yes | Yes |
| Friction | Pick folder + grant once | Trust/AV prompt on an executable |

### 5b. Recommendation — offer BOTH (they share one backend)
Both consume the **same** manifest + token-gated curated pak endpoints, so a second
delivery mechanism is only its own thin client glue — not a second backend. Ship:
- **FSA browser flow as the zero-install happy path** (Chrome/Edge).
- **Standalone script as the universal fallback** (Firefox/Safari/other, or anyone
  who'd rather not grant folder access, or when the admin doesn't want the dashboard
  public).

The FSA page **feature-detects** (`'showDirectoryPicker' in window`) and, when
unsupported, points the user straight at the script — progressive enhancement, no
dead-ends. Building both is mostly additive; there's no real downside to shipping
the pair.

## 6. "Invite & align your friends" onboarding area — the admin-facing control
The dashboard section (extends the built Invite tab) is where the admin **curates what
friends get** and hands out the packet:
- **Client-mod selection**, seeded from the mod catalog (§2a): the ~78 client-relevant
  mods (Client-only + BOTH) are auto-suggested from the catalog's `Install On` flags with
  a keep/skip toggle, so the admin isn't hand-listing them. Server-only mods are excluded.
- Server address + name + current game version (with "update via Steam if mismatched").
- **The generated client loadout** (§2c): a friend-facing **Classic UE4SS bundle**
  (extract-a-zip) and/or the **sync-script**, plus a **Steam Workshop Collection** link for
  the Workshop-only subset (secondary).
- Plain-language steps + copy-to-clipboard shareable text for Discord.

Essentially: the admin loads mods (Nexus/Steam) as they do today, the dashboard reconciles
them, and this area turns that into a one-click friend loadout + human-readable onboarding.

## 7. Phasing
- **Phase 1 — BUILT + browser-verified (2026-07-27):** `GET /api/manifest` (admin-only: server name +
  game version, UE4SS/PalSchema info, client paks with size + SHA-256) and a
  dedicated **Invite tab** (`components/invite-panel.tsx`) — server/versions,
  admin-entered connect address (saved locally; the server can't detect its public
  IP), client paks with per-file download (reuses `/api/game-mods/pak`), and a
  copy-paste invite packet. No client automation yet — players see exactly what
  they need. (Owner browser-verified the tab render, connect-address field, per-pak
  download, and copy-invite.)
- **Phase 2 (RE-SCOPED 2026-08-06 — the client loadout):** deliver the owner's public-
  release goal — any admin loads Nexus/Steam mods and gets a one-click friend loadout.
  Concretely:
  0. **Client-mod intake — BUILT 2026-08-06.** Where the admin STAGES the mods a friend's
     client needs, WITHOUT installing them on the server (the server pipeline would load
     them into the running game — wrong for a client-only mod). `lib/client-mods.ts` keeps
     a store in the data volume (`data/client-mods/<id>/` payloads + `data/client-mods.json`
     index with a per-mod `keep` flag), staging from a Nexus URL (Premium auto-download,
     newest MAIN file → normalized zip), a Steam Workshop URL (SteamCMD content copy — NOT
     `installWorkshopPackageToProxy`), or a manual `.zip/.rar/.7z/.pak` upload. `lib/mod-
     catalog.ts readCatalog()` reads the operator dataset's `Install On` flag → `is
     ClientRelevant()` (74/121 on the owner's box) seeds keep/skip SUGGESTIONS.
     `app/api/client-mods` (admin-only: GET list+suggestions, POST addNexus/addSteam/
     addCatalog/**bulk**/upload/setKeep/remove) + a **Client mods** sub-tab of the Mods page
     (`components/mods-workspace.tsx` splits Mods into **Server mods** = the original
     `game-mods-panel` and **Client mods** = `components/client-mods-panel.tsx`; the main
     `mods` tab is unchanged). The panel mirrors the server Mods tab's **single + bulk +
     upload** install, shows Nexus-Premium / Steam-connected status hints, and the Invite
     tab points at it. The dashboard-data backup excludes the payload dir
     (re-downloadable, large) but keeps the small index. Verified live: authenticated GET
     (74 suggestions) + upload→list→setKeep→remove round-trip, store self-cleans. **The
     loadout generator (below) that consumes this is the remaining piece — deferred until
     the owner has staged their client-only mods, then built + tested together.**
  1. **Manifest v2** — extend §3's manifest beyond `~mods` paks to the full **client-only**
     set (§2a): per mod, `{ name, kind (ue4ss|pak|palschema-pak), source (nexus|steam),
     files[] with sha256, link }`, seeded from the catalog's client flags with admin
     keep/skip curation (§6). Server-only mods excluded.
  2. **Client-loadout generator (§2c) — BUILT + tested 2026-08-06.** `lib/client-loadout.ts`
     `buildClientLoadout()` assembles a self-contained **Classic UE4SS** bundle from the KEPT
     client mods: UE4SS loader + framework (`dwmapi.dll` + `ue4ss/` core + framework-default
     Mods incl `shared`, copied from the live install) + each mod placed by kind — Lua →
     `ue4ss/Mods/<name>` (+ generated `mods.txt`), pak → `~mods`, LogicMods → `LogicMods`,
     PalSchema → client pak parts only (JSON is server-side), Steam Workshop → its `Info.json`
     `InstallRule` (client rules). **Server-parity paks folded in (2026-08-07):** the bundle
     ALSO copies the server's live `~mods` + `LogicMods` paks (deduped against the staged
     client paks; `.pak.disabled` auto-skipped) so a friend matches the server's content —
     making the loadout the SINGLE complete download. The Invite tab's old per-pak
     "Client-required mods" list (Phase 1, manifest `clientMods`) was REMOVED as redundant;
     the invite text now points at the one bundle. Plus `INSTALL.txt` + a robust installer:
     **`install.bat`** (double-click; launches the .ps1 with `-ExecutionPolicy Bypass` — past
     the downloaded-file block — and pauses so errors stay readable) wrapping **`install.ps1`**
     (String.raw, try/catch, robocopy). An **`uninstall.bat`/`uninstall.ps1`** reverses it by
     deleting EXACTLY the files it placed — recorded in **`installed-files.txt`** (every path
     under `game/`) — then pruning emptied mod dirs, so it never touches the friend's other
     files/saves. Plus `manifest.json` (placed + skipped, with reasons). Assembled ON DISK
     and zipped via the `zip` CLI (added to the image); archive payloads unpacked with `unar`
     — so the ~1GB set never sits in a Node buffer; mod-folder names are collision-safe.
     **Download (streamed-token, 2026-08-07):** the bundle is ~1GB, so it must not buffer in
     the browser. `POST /api/client-mods/loadout?ue4ss=0|1` (admin) generates + mints a
     one-time, 256-bit, 15-min token (`lib/loadout-tokens.ts`) → `{token, fileName, summary}`;
     the browser then NAVIGATES to `GET …/loadout?token=…`, which streams straight to disk
     (the token IS the capability — no header, so a plain `<a download>` works), consumed on
     first use with the temp dir cleaned up on stream close (abandoned tokens swept). A
     header-authed `GET` (no token) is kept for programmatic/direct download. This is the
     **public-release delivery path** — self-service, admin-gated, no host/shell access
     (chosen over copying the zip to a host path, which assumes SSH). The **Build friend
     loadout** card runs POST→navigate. **Moved 2026-08-07 to the Invite tab** (the
     onboarding area) — the Client-mods tab keeps a link to it (a new `requestTab` nav helper
     in server-context, consumed by dashboard.tsx, mirrors `consoleRequest`). Verified:
     mint→stream (byte count exact)→reuse 410→bad-token 400→temp self-cleans.
     **Verified 2026-08-06 on the live 72-mod set:** a 954 MB bundle in ~34s — correct Classic
     layout (dwmapi.dll, ue4ss core, `mods.txt` = enabled framework + 34 client Lua, 29 `~mods`
     paks, 3 LogicMods), 61 placed / 11 skipped (5 server-side PalSchema, 2 unclassified, 4
     needing a manual look — all recorded, none mis-placed), no path escapes, temp self-cleans.
     **NOT verifiable here:** whether a friend's game actually LOADS them (no game client on this
     box) — that's the real-client test. Output today is the **extract-a-zip bundle**; the
     **sync-script** delivery variant (§5) is the remaining follow-up.
     **PLACEMENT HARDENED 2026-08-06:** `findLuaModRoots` now searches for mod dirs at ANY
     depth (recovers archives that ship the full `Pal/Binaries/Win64/ue4ss/Mods/<name>/` game
     path — a common Nexus packaging), and paks are routed by path (`…/LogicMods/*.pak` →
     `Content/Paks/LogicMods`, else `~mods`). A staged DUPLICATE (same mod from Nexus AND
     Steam) is reported "already in loadout" rather than a phantom failure; Engine.ini-only
     text "mods" get an explicit skip reason. On the live set this lifted Lua 34→43 and
     LogicMods 3→11, leaving 7 genuine skips (5 server-side PalSchema + 2 Engine.ini-text).
  2a. **Client-mod CONFIG editing — BUILT + tested 2026-08-06.** Many client mods ship a
     config (`Scripts/config.lua`, `config.ini`, …; 29 of the owner's 74). `lib/client-mod-
     config.ts` discovers them inside each staged payload (extract via `unar`, find files
     under a mod root), lets the admin edit with **format validation** (json/jsonc/ini/lua via
     the server editor's `validateConfigContent`; `.txt` passes through), and stores the edit
     as an **override** under `data/client-mods/<id>/config-override/<relWithin>` — the staged
     payload is never mutated. The loadout **overlays** each override onto the placed mod so
     EVERY client ships the host's config (only when a mod produced exactly one folder). API
     actions `configList`/`configSave`/`configClear` on `/api/client-mods`; a **Config** button
     + editor Sheet per staged mod row (non-pak). Verified: edited FOV Control's `config.lua`
     → the marker appeared in the generated bundle (`manifest.json configOverrides:1`).
  2b. **Add-time placement WARNING — BUILT + tested 2026-08-07.** A client mod with no
     client-installable files (PalSchema/UE4SS-only, Engine.ini-text, or an unreadable
     archive) is now flagged AT STAGE TIME instead of silently doing nothing at loadout time.
     `lib/client-mods.ts` classifies each add — `warnFromZip` (Nexus/upload: AdmZip entry
     scan — Lua/pak/LogicMods ⇒ ok; PalSchema-only ⇒ server-side warn) / `warnFromContent`
     (Steam: `Info.json` InstallRule types) — and stores `warn` on the record. The panel shows
     an amber ⚠ badge + "won't ship to clients" on the row, a warning toast on add, and the
     warn in bulk results. The loadout also now records a Steam mod that places nothing as
     **skipped** (was silently dropped). Verified: Elemental Passive Icons (Steam 3777233424,
     PalSchema-only) → warn fires; moved it OFF the client set and installed it as a **server**
     PalSchema mod (`PalSchema/mods/ElementalPassiveIcons`).
  2c. **FOMOD contingency — BUILT + tested 2026-08-07.** A **FOMOD** (Nexus installer whose
     `fomod/ModuleConfig.xml` declares mutually-exclusive variant options — e.g. Wing Pack
     Gliding's Unchanged/Zero/Double) has a SINGLE MAIN file, so the bulk "multiple MAIN →
     manual" guard missed it, and its variant files map to no mod-folder layout → it can't be
     auto-installed. `lib/archive.ts isFomodArchive(buffer)` + `FOMOD_MESSAGE` detect it (on
     the normalized zip). Wired everywhere a mod lands: **Nexus single install** → 400 +
     `fomod:true`; **Nexus bulk** → per-item `needsChoice` (route to the single-URL box, like
     the multi-MAIN case); **manual upload** → 400; **client add/backfill** → a FOMOD-specific
     `warn` (via `classifyNames`). Verified on mod 4126 (all three paths flag it; nothing
     installs).
  2d. **FOMOD variant PICKER — BUILT + tested 2026-08-07.** `lib/fomod.ts` parses
     `fomod/ModuleConfig.xml` (UTF-16/UTF-8) → module name + groups (SelectExactlyOne/Any/…)
     + plugins (name/description/recommended/files) via `fast-xml-parser`. `app/api/nexus/
     install` actions: `fomodOptions` (download MAIN → parse → return options) + `fomodInstall`
     (copy the selected plugins' `<file>`/`<folder>` + any `requiredInstallFiles` to their
     declared game-relative destinations, path-safe under the game dir). UI: `components/
     fomod-picker.tsx` — a Sheet opened by the Nexus-install flow when a mod comes back
     `fomod:true`; radios for SelectExactlyOne/AtMostOne, checkboxes otherwise, recommended
     pre-selected. Not handled (MVP): flag conditions / conditionalFileInstalls / step
     visibility. Verified on mod 4126: options parsed (Unchanged/Zero/Double), installing
     "Zero" wrote the 0-cost jsonc to the mod's declared destination. UI is API-verified;
     browser layout unverified (no client here).

## 7a. Planned (not built): catalog-entry-on-add
The operator's `mod_data` catalog is generated OUTSIDE the dashboard by `fetch_all_mods.py`
(reads a tracker spreadsheet → fetches Nexus/Steam API fields → writes `mods.json` +
`descriptions/`), mounted **read-only**, and its **`Install On` flag is a human judgment**
from the spreadsheet — NOT in any API. So "add a mod by URL" cannot (and must not) write into
`mod_data`. Plan to give the *feeling* the owner expected (URL → it lands in the catalog):
- **Writable overlay** `data/catalog-additions.json` (data volume), keyed `<source>_<id>`, same
  field shape as a `mods.json` entry (source/id/url/name/category/tags/author/version/updated/
  summary/description) + `installOn` (INFERRED) + `origin: 'dashboard'`.
- **On add** (server or client), fetch the same API fields `fetch_all_mods.py` does (Nexus
  `mods/<id>.json`; Steam `GetPublishedFileDetails`) and write the overlay entry; optionally a
  description overlay so config-discovery covers dashboard-added mods too.
- **Infer `Install On`** from the Part-2b classifier: PalSchema/UE4SS-only ⇒ `Server`; has a
  client pak ⇒ `BOTH (client needs the pak)`; Lua ⇒ `Server / host (confirm)` (client-vs-server
  Lua isn't reliably inferable) — always tagged `(inferred)`, admin-overridable.
- **`readCatalog()` merges** base `mods.json` + overlay, **operator (curated) wins** on conflict.
- **Reconciliation:** additions live in the writable data volume, NOT `mod_data` (`:ro`), so a
  `fetch_all_mods.py` re-run never clobbers them; a later spreadsheet entry supersedes by id.
- **Clean-room preserved:** still ships only the reader + an operator-owned writable overlay.
  3. **Delivery** — keep §5b's dual client (FSA browser happy-path + standalone script
     fallback) for the *pak-sync* subset, and add the loadout bundle/script for the full
     client-only set. A **Steam Workshop Collection** link covers the Workshop-only subset.
  Prereqs: the curated non-admin manifest path (§8), and — for the FSA/bundle-from-dashboard
  paths — the dashboard reachable over public HTTPS (or admin-hosted files).
  **Test plan (owner, deferred):** once the owner adds their client-only mods to the box,
  follow up to actually exercise the invite flow end-to-end (curate → generate loadout →
  a friend installs from it → joins).

## 8. Security / access
- Players aren't admins, so the manifest + any client-file access need a **separate,
  curated, non-admin path** — only the admin-designated client paks, never the
  arbitrary-file admin download route.
- Prefer a token or share-link over fully open, and never expose anything but the
  curated `clientMods` set.

### 8a. Friend share links — BUILT + tested 2026-08-08
The admin mints a **share link**; a non-admin friend opens a PUBLIC page (the unguessable
192-bit token IS the capability — no admin login) and downloads the bundle.
- `lib/client-shares.ts`: `createShare` generates a bundle (`buildClientLoadout`) and
  PERSISTS it — the .zip to `<game>/client-shares/<token>.zip` (game volume has space; the
  data volume is small), metadata (server-info snapshot + connect + summary + zip path) to
  `data/client-shares.json`. Persistent + multi-use + revocable (vs. the admin one-time
  in-memory token). `listShares`/`getShare`/`deleteShare`/`resolveShareZip` (never exposes
  the path; download resolves it server-side from the token).
- Admin CRUD: `app/api/client-mods/share` POST create / GET list / DELETE revoke (admin).
- PUBLIC (token-gated, no admin header): `GET /api/share/[token]` (curated metadata only) +
  `GET /api/share/[token]/download` (streams the persisted zip; path server-resolved, no
  traversal; multi-use). Public PAGE `app/share/[token]/page.tsx` — server component, NOT
  behind the login gate (that's only in `app/page.tsx`): server identity + connect + one
  Download button + install steps. Revoked/unknown token → 404.
- Invite tab: a **Share links** section (create with optional label, list with copy + revoke;
  full URL = `window.location.origin/share/<token>`). Caveats (§4): the dashboard becomes a
  limited file host for the admin's own community (opt-in) and must be reachable by friends
  (public HTTPS / LAN). FSA "write into ~mods" browser flow (§5.2) remains the follow-up.
- **Access model:** a share link is a BEARER capability — anyone with the URL can download
  (no login, no per-person check); the 192-bit token is the only gate (unguessable, not
  enumerable). Multi-use + persistent until revoked (revoke = instant 404 + deletes the zip).
- **Deferred hardening (owner, later — not built):** optional link **expiry** (auto-die
  after N hrs/days), **one-time / limited uses**, an optional **passphrase** the friend
  enters, and a **"revoke all"** convenience. Current control = manual revoke when done.

## 9. Open decisions (for the owner)
- Serve client paks from the dashboard (opt-in) vs. admin hosts them elsewhere.
- ~~Standalone script vs. browser FSA~~ — RESOLVED: ship **both** (§5b), FSA as the
  happy path + script as the universal fallback, one shared backend.
- Whether to expose the dashboard over public HTTPS (required for the FSA path;
  the script path can avoid it if the admin hosts files elsewhere).
- How curation is expressed (mark paks client-required in the Mods tab; default all).

## 10. Out of scope
- Installing/patching the **game** itself (Steam's job).
- ~~Client-side UE4SS/Lua~~ — **now IN scope** (§2a–§2c): client-only mods are commonly
  UE4SS Lua, so the client loadout ships a client UE4SS runtime. (PalSchema stays
  server-side — only its pak parts reach the client.)
- Touching the friend's machine remotely — the deliverable is a bundle/script the friend
  runs, not automation of their PC.
- Reconciling a client that wants to ALSO run Steam Workshop mods alongside the Classic
  bundle — pick one runtime (§2b); the bundle is meant to be their single mod source.
- Auto-updating a friend's client from Nexus (auth-gated; same verdict as elsewhere).
