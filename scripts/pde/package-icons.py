#!/usr/bin/env python3
"""Package an FModel icon export into an upload-ready icons.zip for the dashboard.

FModel exports icon textures named by their raw texture id
(``T_Anubis_icon_normal.png``, ``T_itemicon_Material_Stone.png``) and does NOT
produce a zip. The dashboard's Game Data upload wants ``pal/<id>.png`` and
``item/<id>.png`` (named by the Pal/item id). This script does that mapping +
zipping in one step, using the game's own icon DataTables as the authoritative
id -> texture map — no hand-renaming.

Usage:
    ./scripts/pde/package-icons.py --export-dir /path/to/FModel/Output/Exports \
        [--out icons.zip] [--pals-only | --items-only]

Then upload the resulting icons.zip in the dashboard's Game Data card.

What you must have exported from FModel (Save Properties as JSON + textures as PNG):
    - DT_PalCharacterIconDataTable(_Common)   (Pal id -> icon texture)
    - DT_ItemIconDataTable(_Common)           (item id -> icon texture)
    - Pal/Content/Pal/Texture/PalIcon/Normal  (Pal icon PNGs)
    - Pal/Content/Others/InventoryItemIcon    (item icon PNGs)
Pure standard library; run anywhere with Python 3.
"""
import argparse
import json
import os
import re
import sys
import zipfile

PAL_DT = ("DT_PalCharacterIconDataTable_Common.json", "DT_PalCharacterIconDataTable.json")
ITEM_DT = ("DT_ItemIconDataTable_Common.json", "DT_ItemIconDataTable.json")


def find_file(root, names):
    """First match (by exact basename, case-insensitive) anywhere under root."""
    wanted = {n.lower() for n in names}
    hits = {}
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            if f.lower() in wanted:
                hits[f.lower()] = os.path.join(dirpath, f)
    # honour the priority order in `names` (base table overrides _Common)
    for n in names:
        if n.lower() in hits:
            return hits[n.lower()]
    return None


def rows_from(path):
    """id -> icon texture basename (no extension), from an FModel DataTable JSON."""
    out = {}
    if not path:
        return out
    try:
        data = json.load(open(path, encoding="utf-8-sig"))
    except Exception as e:  # noqa: BLE001
        print(f"  warn: could not read {path}: {e}", file=sys.stderr)
        return out
    for obj in data if isinstance(data, list) else [data]:
        for rid, rv in (obj.get("Rows") or {}).items():
            ap = ((rv or {}).get("Icon") or {}).get("AssetPathName") or ""
            if not ap:
                continue
            # "/Game/.../T_x.T_x" -> "T_x"
            out[rid] = ap.split(".")[0].split("/")[-1]
    return out


def png_index(root):
    """basename(lower, no ext) -> full path, for every PNG under root."""
    idx = {}
    for dirpath, _dirs, files in os.walk(root):
        for f in files:
            if f.lower().endswith(".png"):
                idx.setdefault(f[:-4].lower(), os.path.join(dirpath, f))
    return idx


def build(cat, dt_names, export_dir, pngs, staging):
    dt = find_file(export_dir, dt_names)
    if not dt:
        print(f"  {cat}: no {dt_names[0]} found under export dir — skipping", file=sys.stderr)
        return 0
    mapping = rows_from(dt)
    out_dir = os.path.join(staging, cat)
    os.makedirs(out_dir, exist_ok=True)
    n = 0
    for rid, tex in mapping.items():
        src = pngs.get(tex.lower())
        if src and os.path.getsize(src) > 0:
            # sanitise the id into a safe filename (dashboard requires this)
            safe = re.sub(r"[^A-Za-z0-9_.-]", "", rid)
            if safe:
                with open(src, "rb") as a, open(os.path.join(out_dir, f"{safe}.png"), "wb") as b:
                    b.write(a.read())
                n += 1
    print(f"  {cat}: packed {n}/{len(mapping)} icons")
    return n


def main():
    ap = argparse.ArgumentParser(description="Package FModel icons into icons.zip")
    ap.add_argument("--export-dir", required=True, help="FModel Exports root (contains Pal/Content/...)")
    ap.add_argument("--out", default="icons.zip", help="output zip (default icons.zip)")
    ap.add_argument("--pals-only", action="store_true")
    ap.add_argument("--items-only", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(args.export_dir):
        sys.exit(f"error: --export-dir not found: {args.export_dir}")

    print(f"Indexing PNGs under {args.export_dir} …")
    pngs = png_index(args.export_dir)
    print(f"  {len(pngs)} PNG textures found")

    staging = os.path.join(os.path.dirname(os.path.abspath(args.out)) or ".", ".icons-staging")
    if os.path.isdir(staging):
        import shutil

        shutil.rmtree(staging)
    os.makedirs(staging, exist_ok=True)

    total = 0
    if not args.items_only:
        total += build("pal", PAL_DT, args.export_dir, pngs, staging)
    if not args.pals_only:
        total += build("item", ITEM_DT, args.export_dir, pngs, staging)

    if total == 0:
        sys.exit("error: packed 0 icons — check that you exported the DataTables + texture folders")

    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as z:
        for cat in ("pal", "item"):
            d = os.path.join(staging, cat)
            if os.path.isdir(d):
                for f in sorted(os.listdir(d)):
                    z.write(os.path.join(d, f), f"{cat}/{f}")

    import shutil

    shutil.rmtree(staging, ignore_errors=True)
    size_kb = os.path.getsize(args.out) // 1024
    print(f"\nWrote {args.out} ({total} icons, {size_kb} KB). Upload it in Game Data → Choose icons .zip.")


if __name__ == "__main__":
    main()
