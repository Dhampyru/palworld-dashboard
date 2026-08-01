# Spec: Nexus Mods Integration

Status: **BUILT + browser-verified (2026-07-27).** Standalone feature, fully
shipped: Phases 1–3 plus bulk install, a discoverable disabled state, and in-UI
API-key guidance. The owner connected a Nexus **lifetime (= Premium)** key and
verified every surface in a browser. Still ships **inert with no key** (dormant,
Mods tab unchanged) and degrades to the free tier with a non-Premium key. Only the
optional client-mod-sync manifest tie-in (§10 Phase 3) is deferred.

## 1. Goal
Bring Nexus awareness into the Mods tab: identify installed mods, show when updates
exist, and — where the account allows it — install/update straight from Nexus,
reusing the install pipeline we already have (pak / UE4SS / PalSchema, incl. the
game-root drop-in layout).

## 2. The Premium boundary → two tiers, both first-class
Nexus deliberately gates programmatic **downloads**:
- Generating a mod download link via the API works for **Premium** accounts;
  **free** accounts get a 403 unless they pass a `key`+`expires` pair that only
  comes from clicking "Mod Manager Download" on the site (fires an `nxm://` link a
  desktop manager catches — not something a server-side web app can do).
- Read/**metadata** endpoints work with **any** valid API key (free included).
- Their ToS restricts automated scraping/bulk downloading.

So this is inherently **account-specific**, and the spec is built around TWO tiers
from the start (this owner is Premium, but the project targets public release, so
the free path is a hard requirement, not a fallback bolt-on):

| Capability | No key | Free key | Premium key |
|---|---|---|---|
| Show mod info / version (once associated) | — | ✅ | ✅ |
| "Update available" badges | — | ✅ | ✅ |
| Identify installed mod by archive MD5 | — | ✅ | ✅ |
| **Auto-download + install/update** | — | ❌ (guided upload) | ✅ |
| Guided manual download → existing upload flow | ✅ (link only) | ✅ | ✅ |

With **no key at all**, the feature is dormant and the Mods tab behaves exactly as
it does today — nothing regresses.

## 3. Prerequisites
- **Admin-supplied Nexus API key**, stored server-side as a secret in `.env`
  (`NEXUS_API_KEY`), never in code/git/chat — same handling as
  `PALDEFENDER_REST_TOKEN`. Templated in `.env.example` for release.
- On boot / on save, validate the key via `/v1/users/validate.json` and cache
  `{ name, is_premium }` — this drives which tier the UI offers.

## 4. Mod ↔ Nexus association
Our installed mods don't carry Nexus IDs, so each needs a link to its Nexus mod:
- **Manual (always works):** paste the mod's Nexus URL (or `game/modId`) on the
  mod row; we parse `nexusmods.com/palworld/mods/<id>`.
- **Auto by MD5 (going forward):** record the **source archive's MD5** when a mod is
  installed *through the dashboard*, then `md5_search` resolves the Nexus mod + file
  + version with no manual step. NB: `md5_search` matches the downloaded **archive**,
  not the extracted `.pak`, so it can't retro-identify already-extracted mods —
  those use the manual association once.
- Store associations dashboard-side (`data/nexus-mods.json`): our mod key
  (pak filename / ue4ss folder / palschema sub-mod) → **as built:**
  `{ modId, baselineVersion, latestVersion?, latestName?, latestAuthor?, checkedAt? }`.
  `baselineVersion` = what the operator has (drives the update flag); the
  `latest*`/`checkedAt` fields are the Phase-3 sweep version cache. (Hybrid pak↔parent
  nesting lives separately in `data/mod-groups.json`.)

## 5. Update checking
- Per associated mod, `GET /v1/games/palworld/mods/{modId}.json` +
  `/files.json` → compare Nexus's latest file version to the recorded
  `installedVersion` → an **↑ update** chip + changelog link on the mod row.
- **As built:** one `updated.json?period=1m` sweep per refresh; a linked mod whose
  version cache is fresher than the window and absent from the updated set is proven
  unchanged → its per-mod call is skipped (cold cache / failed sweep falls back to
  per-mod refetch). See §10 Phase 3.
- Respect rate limits (~2500/day, 100/hour per key) — batch + cache, don't poll hot.

## 6. Install / update flow
- **Premium:** `download_link.json` → fetch the archive server-side → run the
  existing install pipeline (auto-detects pak / UE4SS / PalSchema; hybrid split;
  game-root drop-in anchor). Record the archive MD5 for future auto-ID. One-click
  install AND update.
- **Free:** show the mod + files + a deep link; the admin downloads it and uses the
  **existing upload** in "Install a Mod" (already handles all three types). Update =
  same, with an "update available" nudge.

## 7. Nexus API endpoints used (base `https://api.nexusmods.com`, header `apikey`)
- `GET /v1/users/validate.json` — key valid? premium?
- `GET /v1/games/palworld/mods/{id}.json` — mod metadata (name, version, updated).
- `GET /v1/games/palworld/mods/{id}/files.json` — files (file_id, version, size, category).
- `GET /v1/games/palworld/mods/md5_search/{md5}.json` — identify by archive md5.
- `GET /v1/games/palworld/mods/updated.json?period=1d|1w|1m` — bulk update sweep.
- `GET /v1/games/palworld/mods/{id}/files/{fid}/download_link.json` — **Premium** download link.

## 8. Security & compliance
- Key is a server-side secret; never sent to the browser (all Nexus calls are
  server-side routes). UI only sees derived state (premium?, versions, links).
- Admin-only to configure; opt-in (no key → dormant).
- Honor Nexus ToS + rate limits; no scraping, no bypassing the Premium download gate.
- Downloading then serving mods to players is the same redistribution question as
  client-mod-sync §4 — keep it admin-scoped/opt-in.

## 9. UI surfaces (as built)
- **Panel Settings → Nexus:** password-masked API key field + Save & validate /
  Clear, and a status line (`Not connected` / `Premium` / `Free` / `Invalid`,
  `<name>` when valid). Description spells out free-vs-Premium capability and links
  to `nexusmods.com → Account → API keys` (Personal API Key → Generate) with the
  "stored server-side only" note (`b608215`; spacing fix `0c65c1f`).
- **Mod rows (Mods tab):** a Nexus chip — `+ Link to Nexus` (paste URL) if unlinked;
  once linked, `Nexus vX ↗` + an `↑ update` chip when newer + `mark seen` + `unlink`.
  Premium additionally gets `↑ update now` (one-click download+reinstall). Nested
  hybrid children skip the chip (the parent owns the link).
- **Install a Mod:** (Premium, connected)
  - **Install from Nexus URL** — single mod: Fetch → file picker → Download & install.
  - **Bulk install from Nexus** — collapsible textarea, one URL/id per line →
    Install all → per-line ✓/⚠/✗ result list (auto-picks each MAIN file) (`5b3d4eb`).
  - When Premium **isn't** connected, a muted dashed **"Install from Nexus (Premium)"**
    explainer takes their place (chip `Not connected` / `Premium only`) so the
    capability is discoverable, not silently missing (`b608215`).

## 10. Phasing
- **Phase 1 — BUILT (2026-07-27):** read-only awareness (works for free & premium).
  Increment 1 (`d705ef3`): key config + validate + Panel Settings section
  (`lib/nexus.ts`, `app/api/nexus`). Increment 2 (`a270f8b`): mod↔Nexus association
  + update watching + the mod-row Nexus chip (`app/api/nexus/mods`,
  `components/game-mods-panel.tsx`). No downloads. Live-verified server-side (key
  validates as Premium; mod 1135 enriches to latest 0.2.0 with the update flag at
  baseline 0.1.2); owner browser-verified.
- **Phase 2 — BUILT + browser-verified (2026-07-27):** Premium auto-install from a
  Nexus URL. `app/api/nexus/install` (GET resolves mod + files for a picker; POST,
  admin + Premium, downloads the chosen file → `detectModKind` → existing
  install pipeline → auto-links for update-watching). "Install from Nexus URL"
  field in the Mods tab. Live-verified against real mods: 2267 (Better Lucky Pals,
  spaced PalSchema folder — fixed by sharing `isSafeModFolderName`, `bf0aa1d`) and
  4379 (Progressive Capture Mastery, Lua+pak hybrid with backslash/nested paths —
  fixed by rewriting `installUe4ssModArchive` to anchor + split paks to `~mods`,
  `4ddf392`). **Hybrid nesting (`6cfcc56`):** a hybrid's split-out pak(s) are
  recorded against the parent UE4SS mod (`data/mod-groups.json`) and nested under
  it in a collapsed "N bundled file(s)" row (nested rows skip the Nexus chip — the
  parent owns the link — but keep download/toggle/remove). Browser-verified by the
  owner. Still parked: one-click Update on linked mods + MD5 auto-association
  (Phase 3). record archive MD5 for auto-ID.
- **Phase 3 — BUILT + browser-verified (2026-07-27):** polish over Phase 2.
  - **One-click Update (Premium)** (`eea4341`): a linked mod showing `↑ update` gets
    an `↑ update now` action — resolve the newest MAIN file → reinstall through the
    Phase 2 pipeline → bump baseline. Refactored install route into a shared
    `installModFile()`; `update` action + `pickUpdateFile()`; `getLinkedModId()`.
    Free accounts unchanged (mark seen + link only). *Caveat:* update reinstalls
    over existing files (like a manual re-upload) — files dropped between versions
    would linger; matches normal mod-update behavior.
  - **MD5 auto-association** (`57b1b86`): the manual upload path
    (`app/api/game-mods/install`) computes the archive MD5 and calls `md5_search`; a
    hit auto-links the mod (`lib/nexus.ts md5AutoAssociate`). Best-effort — silent
    no-op on no key / no match / any error; matches only unmodified Nexus downloads.
  - **Bulk `updated.json` sweep** (`387ea2e`): `getNexusMods` now makes ONE
    `updated.json?period=1m` call and skips the per-mod version fetch for any linked
    mod whose cached version is fresher than the window and absent from the updated
    set. Version cache persists in the association file (`latestVersion/latestName/
    latestAuthor/checkedAt`); cold cache or a failed sweep falls back to per-mod
    refetch (still correct — no missed updates within the window).
  - **Bulk install from URLs** (`5b3d4eb`): a `bulk` action on
    `app/api/nexus/install` (admin + Premium) takes many URLs/ids, installs each
    sequentially via `installModFile` auto-picking its single MAIN file; per-line
    results so one bad URL never aborts the batch; ambiguous mods (multiple/zero MAIN
    files) are flagged for the single-URL box, not guessed; capped at 50. UI: a
    collapsible textarea + "Install all" + a ✓/⚠/✗ result list.
  - **Discoverable disabled state + API-key guidance** (`b608215`, spacing
    `0c65c1f`): a muted dashed explainer replaces the install boxes when Premium
    isn't connected (§9), and Panel Settings → Nexus gained the free-vs-Premium copy
    + the API-keys guide link.
  - **client-mod-sync manifest integration:** deferred (optional; not built).

## 11. Public-release notes
- Ship inert without a key; document how any admin adds their own key
  (`NEXUS_API_KEY` in `.env.example`).
- Be explicit in the UI/docs that **auto-download requires a Nexus Premium account**;
  free accounts get identify + update-notify + guided upload. Never imply the
  project circumvents the Premium gate.

## 12. Out of scope
- Bypassing the Premium download gate / `nxm://` handling (desktop-only, ToS).
- Browsing/searching all of Nexus in-dashboard (start from a known mod URL/ID).
- Endorsing / posting to Nexus on the user's behalf.
