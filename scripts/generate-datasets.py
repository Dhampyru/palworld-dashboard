#!/usr/bin/env python3
"""Generate the RCON console typeahead datasets from extracted game DataTables.

Outputs data/{items,eggs,pals}.json as arrays of {"id": ...}. See
docs/specs/rcon-console.md §9. IDs only for now — display names live in the
localization text tables (TextID lookups) and icons in Texture/*.png; both are
a larger follow-up (names need the text tables joined; icons need serving + an
image-rendering picker). Type-ahead works on IDs alone.

SOURCE: the operator's own extracted DataTables (e.g. a clone of a private
Palworld-DataExtract repo) — their extraction of their own licensed game files.
Point --datatable-dir at `.../Pal/Content/Pal/DataTable`.

The DataTable IS the ground truth: it's a proper UE parse of the game's own
item/pal tables. An optional --pak cross-check exists, but grepping the raw pak
is UNRELIABLE — the pak's FName pool fragments/deduplicates strings, so many
valid IDs (e.g. PalEgg_Dark_02) never appear contiguously and produce false
negatives. So --pak only WARNS about drift; it never filters. Default ships
every DataTable ID.

The generated data/*.json are gitignored (skip-worktree); the repo keeps
shipping empty [].
"""

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA_DIR = REPO / "data"
# Icons are copied here (gitignored) and served by Next at /palworld-icons/...
ICON_PUBLIC_DIR = REPO / "public" / "palworld-icons"
ICON_URL_PREFIX = "/palworld-icons"


def load_rows(datatable_path: Path) -> dict:
    """Load a FModel-style DataTable export -> its Rows dict (keyed by row id)."""
    data = json.loads(datatable_path.read_text(encoding="utf-8"))
    obj = data[0] if isinstance(data, list) else data
    return obj.get("Rows", obj)


def confirm_against_pak(candidate_ids: list[str], pak: Path) -> set[str]:
    if not candidate_ids:
        return set()
    with tempfile.NamedTemporaryFile("w", suffix=".ids", delete=False) as fh:
        fh.write("\n".join(candidate_ids))
        idfile = fh.name
    try:
        proc = subprocess.run(
            ["grep", "-aoF", "-f", idfile, str(pak)],
            capture_output=True, text=True,
            env={**os.environ, "LC_ALL": "C"}, check=False,
        )
    finally:
        os.unlink(idfile)
    return {ln for ln in proc.stdout.split("\n") if ln} & set(candidate_ids)


# Pocketpair leaves these dev placeholders in the L10N tables for unlocalized/
# debug rows (~100 in the item table). They are NOT names -- treat as absent so
# the entry falls back to its ID, matching what other tools (palserver-gui) do.
_NAME_PLACEHOLDERS = {"en text", "none", ""}


def name_map(text_table: Path, prefix: str) -> dict:
    """Map <id> -> English display string from an L10N/en name table keyed by
    <prefix><id> (e.g. PAL_NAME_Alpaca -> "Melpaca"). Placeholder strings are
    dropped."""
    if not text_table.is_file():
        return {}
    out = {}
    for key, row in load_rows(text_table).items():
        if not key.startswith(prefix):
            continue
        s = (row.get("TextData") or {}).get("LocalizedString")
        if s and s.strip().lower() not in _NAME_PLACEHOLDERS:
            out[key[len(prefix):]] = s
    return out


def index_pngs(*dirs: Path) -> dict:
    """Lowercased basename -> full path, across the given icon dirs."""
    idx = {}
    for d in dirs:
        for p in glob.glob(str(d / "**" / "*.png"), recursive=True):
            idx.setdefault(os.path.basename(p).lower(), p)
    return idx


def build_item_icon_index(png_index: dict) -> dict:
    """IconName(lowercased) -> icon path. Item icon files are
    T_itemicon_<Category>_<IconName>.png (materials/eggs/etc.) or
    T_icon_<IconName>_UI.png (weapons). We index each under BOTH its full rest
    ("material_wood") AND its category-stripped rest ("wood"), because the
    DataTable's IconName sometimes includes the category prefix and sometimes
    not. Exact keys only -- no suffix guessing (which mismatched Wood vs
    Processed_Wood)."""
    idx = {}
    itemicon = {}  # rest -> path for T_itemicon_<rest>.png
    weapons = {}   # <x> -> path for T_icon_<x>_UI.png
    cats = set()
    for base, path in png_index.items():
        if base.startswith("t_itemicon_") and base.endswith(".png"):
            rest = base[len("t_itemicon_"):-len(".png")]
            itemicon[rest] = path
            if "_" in rest:
                cats.add(rest.split("_", 1)[0])
        elif base.startswith("t_icon_") and base.endswith("_ui.png"):
            weapons[base[len("t_icon_"):-len("_ui.png")]] = path

    def add(key, path):
        idx.setdefault(key, path)

    def add_forms(rest, path):
        add(rest, path)  # full: "material_wood", "accessory_at_1"
        tok, _, after = rest.partition("_")
        if after and tok in cats:
            add(after, path)  # category-stripped: "wood", "at_1"

    # Pass 1: exact names (these take priority).
    for rest, path in itemicon.items():
        add_forms(rest, path)
    for x, path in weapons.items():
        add(x, path)
    # Pass 2 (fallback): drop a trailing rarity tier (_1/_01) the IconName often
    # lacks -- Accessory_AT -> T_itemicon_Accessory_AT_1.png.
    for rest, path in itemicon.items():
        stripped = re.sub(r"_\d+$", "", rest)
        if stripped != rest:
            add_forms(stripped, path)
    return idx


# A few IconNames don't correspond to any file by our rules -- legacy internal
# names, a game-data typo, or an icon shared across a whole element that our
# suffix logic can't reach. Map each IconName(lowercased) to the index key of the
# icon it should actually use. Kept explicit (not heuristic) so it can't produce
# false positives on the other ~2400 items.
ITEM_ICON_ALIASES = {
    "captureprism": "palsphere",              # PalSphere / PalSphere_Debug: legacy internal name
    "palegg_normal_01": "palegg",             # Common Egg: shares the base T_itemicon_Material_PalEgg
    "spheremodule_sniper": "spheremodule_spiper",  # game typo: file is ..._Spiper.png
}


def attach_icons(entries: list[dict], category: str, resolve, png_present: bool) -> list[str]:
    """resolve(id) -> source png path or None. Copies the icon into
    public/palworld-icons/<category>/ and sets entry['image']. Returns MISSING ids."""
    if not png_present:
        return []
    dest = ICON_PUBLIC_DIR / category
    dest.mkdir(parents=True, exist_ok=True)
    missing = []
    for e in entries:
        src = resolve(e["id"])
        if not src:
            missing.append(e["id"])
            continue
        out_name = os.path.basename(src)
        out_path = dest / out_name
        if not out_path.exists():
            shutil.copy2(src, out_path)
        e["image"] = f"{ICON_URL_PREFIX}/{category}/{out_name}"
    return missing


def write_dataset(name: str, entries: list[dict]) -> None:
    entries = sorted(entries, key=lambda e: e["id"])
    named = sum(1 for e in entries if e.get("name"))
    path = DATA_DIR / f"{name}.json"
    path.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(REPO)}: {len(entries)} ids ({named} named)")


# Junk/non-giveable rows to drop from the item table.
def is_real_item(row_id: str) -> bool:
    return bool(row_id) and row_id != "None" and not row_id.startswith("Test")


# Pals: keep normal give targets (base, elemental, BOSS_, PREDATOR_); drop
# event/quest-only entities that clutter the givepal dropdown and aren't
# ordinary targets. The base pal + the picker's BOSS toggle still cover alphas.
_PAL_DROP_PREFIX = ("RAID_", "GYM_", "SUMMON_", "PVP_", "TowerBoss_", "MONSTER_")
_PAL_DROP_SUBSTR = ("_Quest_Enemy", "_Quest_Friend", "_Quest_", "_Avatar")


def is_giveable_pal(row_id: str) -> bool:
    if not row_id or row_id == "None":
        return False
    if row_id.startswith(_PAL_DROP_PREFIX):
        return False
    if any(s in row_id for s in _PAL_DROP_SUBSTR):
        return False
    return True


def resolve(ids: list[str], name: str, pak: Path | None) -> list[str]:
    ids = sorted(set(ids))
    # The DataTable is authoritative -- never filter on the pak. When --pak is
    # given, only WARN how many don't grep (expected: many, due to name-pool
    # fragmentation), as a coarse drift signal.
    if pak is not None:
        found = confirm_against_pak(ids, pak)
        print(f"{name}: datatable={len(ids)} (pak-grep found {len(found)}; "
              f"the rest is fragmentation, not absence)", file=sys.stderr)
    else:
        print(f"{name}: {len(ids)} ids", file=sys.stderr)
    return ids


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--datatable-dir", required=True,
                    help="path to .../Pal/Content/Pal/DataTable of an extraction")
    ap.add_argument("--l10n-dir",
                    help="English name tables; default: <extract>/Pal/Content/L10N/en/Pal/DataTable/Text")
    ap.add_argument("--icons", action="store_true",
                    help="copy referenced icon PNGs into public/palworld-icons and set image fields")
    ap.add_argument("--texture-dir",
                    help="icon source; default: <extract>/Pal/Content/Pal/Texture")
    ap.add_argument("--pak", default=os.environ.get("PALWORLD_PAK"))
    args = ap.parse_args()

    dt = Path(args.datatable_dir)
    if not dt.is_dir():
        print(f"error: datatable dir not found: {dt}", file=sys.stderr)
        return 2

    # L10N/en sits beside Pal/ under .../Content. English names are optional --
    # absent it, entries ship IDs only.
    l10n = Path(args.l10n_dir) if args.l10n_dir else dt.parent.parent / "L10N/en/Pal/DataTable/Text"
    pal_names = name_map(l10n / "DT_PalNameText_Common.json", "PAL_NAME_")
    item_names = name_map(l10n / "DT_ItemNameText_Common.json", "ITEM_NAME_")
    if not pal_names and not item_names:
        print(f"note: no English names found under {l10n} — shipping IDs only", file=sys.stderr)

    # --pak is an optional drift WARNING only; it never filters.
    pak: Path | None = None
    if args.pak:
        pak = Path(args.pak)
        if not pak.is_file():
            print(f"error: pak not found: {pak}", file=sys.stderr)
            return 2

    DATA_DIR.mkdir(exist_ok=True)

    def item_entry(i: str) -> dict:
        n = item_names.get(i)
        return {"id": i, "name": n} if n else {"id": i}

    # --- Items (all rows of the item master table) ---
    item_rows = load_rows(dt / "Item" / "DT_ItemDataTable.json")
    item_ids = resolve([k for k in item_rows if is_real_item(k)], "items", pak)

    # --- Eggs: the PalEgg_* items (element x size). "Egg"/"FriedEggs" are food. ---
    egg_ids = resolve([i for i in item_ids if i.startswith("PalEgg")], "eggs", pak)

    # --- Pals (rows of the monster parameter table; replaces the GPL reference) ---
    pal_rows = load_rows(dt / "Character" / "DT_PalMonsterParameter.json")
    pal_ids = resolve([k for k in pal_rows if is_giveable_pal(k)], "pals", pak)

    def pal_entry(i: str) -> dict:
        row = pal_rows.get(i, {})
        # BOSS_/variant rows point OverrideNameTextID at the base PAL_NAME key;
        # otherwise derive PAL_NAME_<id>.
        override = row.get("OverrideNameTextID")
        key = override[len("PAL_NAME_"):] if override and override.startswith("PAL_NAME_") else i
        n = pal_names.get(key)
        return {"id": i, "name": n} if n else {"id": i}

    item_entries = [item_entry(i) for i in item_ids]
    egg_entries = [item_entry(i) for i in egg_ids]
    pal_entries = [pal_entry(i) for i in pal_ids]

    # --- Icons (optional) ---
    if args.icons:
        content = dt.parent.parent  # <extract>/Pal/Content
        tex = Path(args.texture_dir) if args.texture_dir else content / "Pal" / "Texture"
        # Item icons live in TWO places: weapons under Pal/Texture/Item/Weapon
        # (T_icon_<X>_UI), and everything else -- materials, eggs, accessories,
        # food, ... -- under Others/InventoryItemIcon/Texture (T_itemicon_<Cat>_<X>).
        item_png = index_pngs(tex / "Item", content / "Others" / "InventoryItemIcon" / "Texture")
        pal_png = index_pngs(tex / "PalIcon" / "Normal")
        item_icon = {i: item_rows.get(i, {}).get("IconName") for i in item_ids}
        item_index = build_item_icon_index(item_png)

        def item_resolve(iid):
            ic = item_icon.get(iid)
            if not ic or ic == "None":
                return None
            key = ic.lower()
            return item_index.get(ITEM_ICON_ALIASES.get(key, key))

        def pal_resolve(pid):
            base = pid[len("BOSS_"):] if pid.startswith("BOSS_") else pid
            return pal_png.get(f"t_{base}_icon_normal.png".lower())

        miss_item = attach_icons(item_entries, "item", item_resolve, bool(item_png))
        miss_egg = attach_icons(egg_entries, "item", item_resolve, bool(item_png))
        miss_pal = attach_icons(pal_entries, "pal", pal_resolve, bool(pal_png))

        def item_type(iid):
            r = item_rows.get(iid, {})
            # EPalItemTypeB::Accessory -> "Accessory" (the icon's likely subfolder)
            tb = (r.get("TypeB") or "").split("::")[-1]
            ta = (r.get("TypeA") or "").split("::")[-1]
            return tb or ta or "?"

        # Deduplicate item misses by IconName -- many items share one icon.
        item_by_icon = {}
        for i in miss_item:
            item_by_icon.setdefault(item_icon.get(i), []).append(i)

        report = DATA_DIR / "missing-icons.txt"
        with report.open("w", encoding="utf-8") as fh:
            fh.write("# Icon PNGs referenced by the datasets but ABSENT from the extraction.\n")
            fh.write("# WHERE TO GET THEM: extract these directories whole from the pak via\n")
            fh.write("# FModel (the DataExtract only has Texture/Item/Weapon right now):\n")
            fh.write("#   items -> Pal/Content/Pal/Texture/Item/**/T_icon_<IconName>_UI.png\n")
            fh.write("#            (subfolder tracks the item Type, shown below as a hint)\n")
            fh.write("#   pals  -> Pal/Content/Pal/Texture/PalIcon/Normal/T_<id>_icon_normal.png\n")
            fh.write("# Then push DataExtract and re-run with --icons.\n\n")

            fh.write(f"## items — {len(item_by_icon)} unique icons missing ({len(miss_item)} item ids)\n")
            fh.write("## file: T_icon_<IconName>_UI.png    likely subfolder: Texture/Item/<Type>/\n")
            for icon in sorted(x for x in item_by_icon if x):
                ids = item_by_icon[icon]
                fh.write(f"  T_icon_{icon}_UI.png\tType={item_type(ids[0])}\t({len(ids)} items, e.g. {ids[0]})\n")

            fh.write(f"\n## eggs — {len(miss_egg)} missing (Texture/Item/**/T_icon_<IconName>_UI.png)\n")
            for i in miss_egg:
                fh.write(f"  T_icon_{item_icon.get(i)}_UI.png\t({i})\n")

            fh.write(f"\n## pals — {len(miss_pal)} missing (Texture/PalIcon/Normal/T_<id>_icon_normal.png)\n")
            for i in miss_pal:
                base_id = i[len("BOSS_"):] if i.startswith("BOSS_") else i
                fh.write(f"  T_{base_id}_icon_normal.png\t({i})\n")
        print(f"icons: item {len(item_ids)-len(miss_item)}/{len(item_ids)}, "
              f"egg {len(egg_ids)-len(miss_egg)}/{len(egg_ids)}, "
              f"pal {len(pal_ids)-len(miss_pal)}/{len(pal_ids)} present; "
              f"missing list -> {report.relative_to(REPO)}", file=sys.stderr)

    write_dataset("items", item_entries)
    write_dataset("eggs", egg_entries)
    write_dataset("pals", pal_entries)
    return 0


if __name__ == "__main__":
    sys.exit(main())
