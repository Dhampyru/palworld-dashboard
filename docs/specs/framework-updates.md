# Framework Update Checks (UE4SS + PalSchema)

Built 2026-08-18 at the owner's request. Regular mods (Nexus/Steam) already have update
detection; the **frameworks** (UE4SS, PalSchema) did not. Adds a check + update-with-rollback.

## Detection — `lib/framework-updates.ts`
`checkFrameworkUpdates()` (cached 1h — GitHub's unauth API is 60/hr):
- **PalSchema** — clean semver. Installed = `readPalSchemaStatus().version`; latest =
  `Okaetsu/PalSchema/releases/latest` `tag_name`. `updateAvailable` = `latest > installed`
  (numeric compare). A **hard** flag (e.g. 0.6.1 → 0.6.3).
- **UE4SS** — the server tracks the **rolling** `experimental-palworld` tag, whose git sha
  does NOT map to the installed build's log-banner sha (the banner reports the upstream
  UE4SS-RE base, not Okaetsu's fork commit), and its asset can be re-uploaded under the same
  tag/version. So a version/sha compare would **false-positive**. UE4SS is therefore
  **informational**: show installed build + latest release (tag/date/link), `updateAvailable
  = null` (never a false badge). The release feed follows the installed line
  (experimental-palworld → Okaetsu; beta → UE4SS-RE experimental-latest; else stable latest).

## Update with rollback
- **PalSchema** — NEW backup/rollback in `lib/palschema.ts`: `backupPalSchemaLoader()` tars the
  whole `<modsDir>/PalSchema` folder → `<game>/backups/palschema-loader-<ver>-<stamp>.tar.gz`;
  `listPalSchemaLoaderBackups()`; `rollbackPalSchemaLoader(file)` restores it AND rewrites the
  version meta from the backup name (meta lives outside the folder). `downloadPalSchemaRelease`
  gained a `tag` param (default = `PALSCHEMA_PINNED_TAG` 0.6.1; the update passes a newer tag).
  `updatePalSchemaLoader(tag)` = backup → download(tag) → `installPalSchemaLoader(buf, tag)`.
- **UE4SS** — reuses the EXISTING flow: `installUe4ssZip` already backs up first, and
  `listUe4ssBackups()`/`rollbackUe4ss()` exist. The card calls
  `/api/game-mods/ue4ss/install` (`download` to reinstall the tracked source, `rollback` to
  restore) — no new UE4SS code.

## API — `app/api/framework-updates/route.ts` (admin-only)
- `GET` → `{ updates, palschemaBackups, ue4ssBackups }` (`?refresh=1` forces a re-check).
- `POST` → `palschemaUpdate {tag}` / `palschemaRollback {file}`. UE4SS actions go to the
  existing UE4SS install route.

## UI — `components/framework-updates-card.tsx`
A card above the mod tabs (in `mods-workspace.tsx`, beside the UE4SS loader). PalSchema row:
installed→latest, "update available"/"up to date" badge, **Update to <ver> (backup taken)** +
a **Rollback to…** picker. UE4SS row: installed build + latest release link, "rolling tag"
badge (no update badge), **Reinstall latest (backup taken)** + Rollback picker. Everything
takes effect on the next server restart; every update takes a rollback backup.

## Deliberate stance
Frameworks are fragile — a bump can break every mod at once, so PalSchema stays **pinned**
(0.6.1) for fresh installs and updating is a **deliberate** operator action, not an auto-nag.
That's why UE4SS gets no hard "update" badge and every change is backed up.
