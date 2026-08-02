#!/usr/bin/env python3
"""Convert PalworldDataExtractor (PDE) output into the dashboard's picker datasets.

Reads a PDE `--out` directory (Pals/<tribe>/, L10N/en/) and writes
data/{items,pals,eggs}.json ({id, name?, image?}) plus copies Pal icons. This is
the runtime clean-room path: the operator's OWN game data, extracted at runtime
from their pak — nothing of Pocketpair's is redistributed by us. Item icons are
not in PDE output (it's Pal-focused), so items get names only.

Mirrors scripts/generate-datasets.py's filtering so the output is consistent
with the FModel path.
"""
import argparse
import json
import shutil
from pathlib import Path

# Pals: keep normal give targets; drop event/quest-only entities (same as the
# FModel generator).
_PAL_DROP_PREFIX = ("RAID_", "GYM_", "SUMMON_", "PVP_", "TowerBoss_", "MONSTER_")
_PAL_DROP_SUBSTR = ("_Quest_Enemy", "_Quest_Friend", "_Quest_", "_Avatar")

_NAME_PLACEHOLDERS = {"en text", "none", ""}


def is_giveable_pal(pal_id: str) -> bool:
    if not pal_id or pal_id == "None":
        return False
    if pal_id.startswith(_PAL_DROP_PREFIX):
        return False
    return not any(s in pal_id for s in _PAL_DROP_SUBSTR)


def is_real_item(item_id: str) -> bool:
    return bool(item_id) and item_id != "None" and not item_id.startswith("Test")


def clean_name(name):
    return name if name and name.strip().lower() not in _NAME_PLACEHOLDERS else None


def l10n_fields(pde: Path, filename: str) -> dict:
    path = pde / "L10N" / "en" / filename
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8")).get("fields", {})


def pal_base(pal_id: str) -> str:
    # BOSS_/variant rows share the base's PAL_NAME key.
    return pal_id[len("BOSS_"):] if pal_id.startswith("BOSS_") else pal_id


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pde-dir", required=True, help="PalworldDataExtractor output dir")
    ap.add_argument("--out-data", required=True, help="where to write {items,pals,eggs}.json")
    ap.add_argument("--out-icons", required=True, help="where to copy icons (…/pal/*.png)")
    args = ap.parse_args()

    pde = Path(args.pde_dir)
    out_data = Path(args.out_data)
    out_icons = Path(args.out_icons)
    out_data.mkdir(parents=True, exist_ok=True)

    pal_names = {
        k[len("PAL_NAME_"):]: v
        for k, v in l10n_fields(pde, "DT_PalNameText_Common.json").items()
        if k.startswith("PAL_NAME_")
    }
    item_names = {
        k[len("ITEM_NAME_"):]: v
        for k, v in l10n_fields(pde, "DT_ItemNameText_Common.json").items()
        if k.startswith("ITEM_NAME_")
    }

    # --- Pals: iterate Pals/<tribe>/, each *.json in a folder is a pal id ---
    pal_entries = []
    pal_dir = pde / "Pals"
    if pal_dir.is_dir():
        pal_icon_dest = out_icons / "pal"
        pal_icon_dest.mkdir(parents=True, exist_ok=True)
        for tribe_dir in sorted(p for p in pal_dir.iterdir() if p.is_dir()):
            tribe = tribe_dir.name
            image = None
            icon_src = tribe_dir / f"{tribe}.png"
            # Only emit an icon when the PNG actually has bytes. The extractor
            # can write 0-byte icons when CUE4Parse can't decode a Pal texture
            # (Palworld's cooked FTexturePlatformData deserializes to 0 mips on
            # the pinned CUE4Parse — a known limitation), and a broken <img> is
            # worse than none: the picker just shows the name/ID.
            if icon_src.is_file() and icon_src.stat().st_size > 0:
                dest = pal_icon_dest / f"{tribe}.png"
                if not dest.exists():
                    shutil.copy2(icon_src, dest)
                image = f"/palworld-icons/pal/{tribe}.png"
            for jf in sorted(tribe_dir.glob("*.json")):
                pid = jf.stem
                if not is_giveable_pal(pid):
                    continue
                entry = {"id": pid}
                name = clean_name(pal_names.get(pal_base(pid)))
                if name:
                    entry["name"] = name
                if image:
                    entry["image"] = image
                pal_entries.append(entry)

    # --- Items: id + name from L10N (no icons in PDE output) ---
    item_entries = []
    for iid, nm in item_names.items():
        if not is_real_item(iid):
            continue
        entry = {"id": iid}
        name = clean_name(nm)
        if name:
            entry["name"] = name
        item_entries.append(entry)
    egg_entries = [e for e in item_entries if e["id"].startswith("PalEgg")]

    def write(name, entries):
        deduped = sorted({e["id"]: e for e in entries}.values(), key=lambda e: e["id"])
        (out_data / f"{name}.json").write_text(json.dumps(deduped, indent=2) + "\n", encoding="utf-8")
        named = sum(1 for e in deduped if e.get("name"))
        iconned = sum(1 for e in deduped if e.get("image"))
        print(f"  {name}.json: {len(deduped)} ids ({named} named, {iconned} iconned)")

    write("items", item_entries)
    write("eggs", egg_entries)
    write("pals", pal_entries)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
