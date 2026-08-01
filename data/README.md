# Command datasets (items / pals / eggs)

These back the typeahead pickers in the RCON console
(`docs/specs/rcon-console.md` §6/§9). **They ship empty on purpose.**

> For a step-by-step walkthrough of extracting the data from your own game and
> running the generator, see the **Item & Pal Datasets** guide
> (`content/configuration/item-pal-datasets.mdx`). This file is the reference;
> that guide is the how-to.

## Schema

Each file is an array of entries. Only `id` is required, so a dataset can be
filled in incrementally and enriched later without a code change:

```jsonc
[
  {
    "id": "Special_PalSphere_Grade_01", // exact string sent over RCON
    "name": "Pal Sphere",               // optional display label
    "image": "/images/items/sphere.png" // optional icon, served from public/
  }
]
```

The picker searches `id` and `name`, shows `name` with `id` as secondary text,
and fills `id`. With `name` absent it falls back to showing the id alone, which
is usable — most Palworld identifiers are readable English.

## Why empty

Two separate reasons, and only the second is a licensing question.

**1. Accuracy.** Palworld's internal identifiers are structured and
unguessable: the tech list from a live server contains
`Special_PalSphere_Grade_01`, `Product_Axe_Grade_01` and
`Battle_MeleeWeapon_Bat` — not `PalSphere`, `Axe`, `Bat`. Hand-written IDs
would be confidently wrong, and a wrong ID in a picker is worse than free text:
it looks authoritative and fails silently at the server. Nothing goes in here
that has not been verified against a real build.

**2. Provenance.** Whether Palworld's data and art may be redistributed is
unresolved. Community datasets are not a safe shortcut — the most complete one
carries an MIT licence over several hundred extracted game sprites, and a
licence cannot grant rights its author never held. Anything added here should
either be generated from the operator's own game install or come from a source
whose licence has actually been checked.

Neither reason blocks the console: every picker degrades to free-text ID entry,
which accepts any valid identifier today.

## The generator (`scripts/generate-datasets.py`)

Reworked 2026-07-23 to source from extracted **DataTables** (a proper UE parse
of the game's own tables), which is authoritative and richer than grepping the
raw pak. Point it at a clone of the operator's own extraction (e.g. a private
Palworld-DataExtract repo):

```sh
./scripts/generate-datasets.py \
  --datatable-dir /path/to/DataExtract/Pal/Content/Pal/DataTable
```

- **Items** — every row of `DT_ItemDataTable` (junk/`Test`/`None` dropped). 2466
  on the 1.0 build. Covers `give`/`delitem`.
- **Eggs** — the `PalEgg_*` items (56, element × size). Covers `giveegg`'s EggId.
- **Pals** — rows of `DT_PalMonsterParameter`, minus event/quest-only entities
  (`RAID_`/`GYM_`/`SUMMON_`/`_Quest_*`/…). 707 on the 1.0 build. **This replaces
  the earlier GPL Palworld-Pal-Editor reference — no GPL data is used at all
  now.** The palId picker's BOSS toggle still constructs `BOSS_<pal>`.

The **DataTable is the source of truth — the pak is NOT used to filter.** An
optional `--pak` only prints a coarse drift warning; it never removes IDs,
because the pak's FName pool fragments strings and produces false negatives
(e.g. `PalEgg_Dark_02` is real but never appears contiguously).

- **Names: DONE (2026-07-23).** English display names come from the L10N/en
  text tables (`L10N/en/Pal/DataTable/Text/DT_{Pal,Item}NameText_Common.json`,
  keyed `PAL_NAME_<id>` / `ITEM_NAME_<id>`). Pals resolve variant names via the
  row's `OverrideNameTextID` (BOSS_/alpha point at the base). Coverage on 1.0:
  items 1964/2466, eggs 56/56, pals 674/707; the rest fall back to ID. Pass
  `--l10n-dir` to override the default path. The base DataTable/Text tables are
  the source (Japanese) culture — do NOT use them for names.
- **Icons: DONE (2026-07-23).** Run with `--icons`: copies each referenced PNG
  into `public/palworld-icons/{item,pal}/` (gitignored) and sets an `image`
  field. Items map `IconName` → `T_icon_<IconName>_UI.png`; pals map id →
  `T_<id>_icon_normal.png` (BOSS_ shares the base). A custom
  `DatasetCombobox` renders icon + name + id (native `<datalist>` can't show
  images). Any referenced PNG absent from the extraction is written to
  `data/missing-icons.txt` (gitignored) — add those to the Texture dir and
  re-run. 1.0 coverage: pals 587/707, items 266/2466 (weapons only in the
  current extraction), eggs 0/56.

**These files are committed EMPTY and kept empty in the repo** via
`git update-index --skip-worktree data/{items,pals,eggs}.json`, so a fresh
checkout builds (the picker statically imports them) yet the generated,
game-derived data is never committed. Re-run the generator locally after a game
update; the Docker image build picks up the populated files from the working
tree. To commit an intentional change to the empty placeholders, clear the flag
first (`git update-index --no-skip-worktree <file>`).

## Filling them in

Preferred order:

1. **Live enumeration**, where the server can tell us. This is already done for
   technology IDs, which come from PalDefender's `gettechids` at runtime — the
   operator's own server is the source, so the data is both correct for their
   exact build and free of any redistribution question. `getskinids` is
   available the same way if skins ever get a picker.
2. **Generated from the operator's install**, offline. Palworld's DataTables
   live in `Pal-WindowsServer.pak`; extracting them needs a `.usmap` and UE5
   tooling, and UE4SS's own ObjectDumper documents itself as unstable, so this
   must not be run against a live server.
3. **A vetted third-party dataset**, only after confirming its licence covers
   the data rather than just the surrounding code.

Images are deliberately not populated. Serving art in an app and committing it
to a public MIT repo are different acts: the second tells everyone downstream
they may redistribute and sell it, which is a grant this project cannot make
for assets it does not own.
