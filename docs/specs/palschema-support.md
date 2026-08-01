# Spec: PalSchema Mod Support (Mods tab extension)

Adds management of PalSchema-based mods to the existing Mods tab. PalSchema
mods are folders of JSON/JSONC living at
`ue4ss/Mods/PalSchema/Mods/<modname>/` — NOT standard UE4SS mods: no
mods.txt registration, no enabled.txt, one level deeper than the tab's
current install path. Built as a distinct section, not by bending the
existing UE4SS handling.

## 0. Pre-flight (report before any code)

1. **Audit the production container's UE4SS layout.** Confirm the modern
   layout (`Win64/ue4ss/Mods/`, dwmapi proxy) and — critical, from
   PalSchema's own docs — that NO legacy remnants exist that would make
   the wrong UE4SS load: no stray `Win64/Mods/` folder, no old
   `UE4SS.dll`/`UE4SS-settings.ini` sitting directly in Win64. Report
   what's found; clean-up is operator-approved, not automatic.
2. **Report the installed UE4SS build** (version/source) and the current
   PalSchema release's REQUIRED UE4SS build (from PalSchema's releases —
   it is built against one specific linked UE4SS; other experimental
   builds crash or silently no-op). State whether our build matches. If
   not, installing PalSchema is BLOCKED until the operator approves a
   coordinated UE4SS upgrade (that touches the dwmapi override — Wine
   territory, plan it, don't improvise it).
3. Confirm whether PalSchema is already installed; report its version if
   so.

## 1. Detection & status

Mods tab gains a **PalSchema section**:
- Not installed → state card: what PalSchema is (one line), its required
  UE4SS pairing, and an install affordance ONLY if pre-flight said the
  UE4SS build matches. PalSchema itself installs as a normal UE4SS mod
  through the existing pipeline.
- Installed → show PalSchema version + a pinned note: "PalSchema and
  UE4SS are a version-locked pair — update together" (this is the #1
  breakage mode in the wild).

## 2. Sub-mod management (the new capability)

- **List** `ue4ss/Mods/PalSchema/Mods/*` folders: name, file count,
  total size, mtime. These are the PalSchema mods.
- **Install from zip:** extract into the correct nested path. VALIDATE
  structure first: the zip must contain a single top-level mod folder
  with JSON/JSONC content (per PalSchema layout). Reject with a clear
  message if it looks like a standard UE4SS mod (has scripts/dlls at
  top level → "this is a UE4SS mod, use the section above") or is a
  bare pile of loose files. Handle the nested-folder zip variant
  (Mod/Mod/) by flattening — the kubectl-cp nesting trap from the
  friction log applies to zip extraction too.
- **Remove:** delete the folder, with confirm. Before delete, tar the
  folder to the backups area (reuse the backup dir + a
  `palschema-<name>-<stamp>.tar.gz` name) so removal is reversible —
  same snapshot-before-destructive-action discipline as config writes.
- **No enable/disable toggle** — PalSchema has no per-mod flag;
  presence = active. Say so in the UI rather than faking a toggle
  (remove-with-backup is the honest disable).
- **Restart-to-apply:** every install/remove surfaces "takes effect on
  next server restart" with the existing restart affordance. Mods are
  scanned at UE4SS startup.

## 3. Hybrid-mod honesty

If an installed zip ALSO contains `.pak`/`.utoc`/`.ucas` assets (hybrid
PalSchema mods), do not silently drop or misplace them:
- Place pak files at the server's pak-mod path
  (`Pal/Content/Paks/~mods/` — verify exact path in pre-flight).
- Show a prominent per-mod warning: "Hybrid mod — connecting players
  must install the client files themselves; server-side install alone
  is not sufficient." List the pak filenames so the operator can
  distribute them.

## 4. Out of scope (v1)

- Editing PalSchema JSON in-dashboard (raw file access via SSH; maybe a
  later raw-editor reuse).
- Auto-updating PalSchema or its mods from Nexus (auth-gated, same
  verdict as all Nexus auto-update ideas).
- PalSchema Dev-edition features (hot reload, schema generation) —
  server runs the standard edition.

## 5. Acceptance

1. Pre-flight report delivered first: layout audit, UE4SS↔PalSchema
   version verdict, PalSchema presence.
2. With PalSchema absent and UE4SS mismatched: section shows blocked
   state, no install offered.
3. Install a real small PalSchema mod zip → lands at
   `PalSchema/Mods/<name>/`, listed with size/mtime, restart notice
   shown; after restart the mod demonstrably functions in-game
   (operator verifies one visible effect).
4. Nested-zip variant flattens correctly; a standard-UE4SS-mod zip is
   rejected with the redirect message.
5. Remove → backup tarball exists in backups area → folder gone →
   restart notice; restoring the tarball by hand brings the mod back.
6. Hybrid zip → paks placed at the pak path + client-files warning
   listing them.
7. Existing UE4SS mod management untouched (regression: list/toggle/
   install still work).
