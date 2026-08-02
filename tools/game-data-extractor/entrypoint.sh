#!/usr/bin/env bash
# Extract the operator's own game data + icons, then convert to the dashboard's
# picker datasets. Everything is a mount; nothing is baked in.
#
#   docker run --rm \
#     -v /path/to/Pal/Content/Paks:/paks:ro \
#     -v /path/to/mappings.usmap:/mappings.usmap:ro \
#     -v /path/to/out/data:/data \
#     -v /path/to/out/icons:/icons \
#     palworld-data-extractor
set -euo pipefail

PAKS_DIR="${PAKS_DIR:-/paks}"
USMAP_FILE="${USMAP_FILE:-/mappings.usmap}"
PAK_NAME="${PAK_NAME:-Pal-WindowsServer.pak}"
UE_VERSION="${UE_VERSION:-5.1}"
OUT_DATA="${OUT_DATA:-/data}"
OUT_ICONS="${OUT_ICONS:-/icons}"
TMP_OUT="${TMP_OUT:-/tmp/pde-out}"

log() { printf '\033[36;1m[extract]\033[0m %s\n' "$*"; }

[ -d "$PAKS_DIR" ] || { echo "error: paks dir not mounted at $PAKS_DIR" >&2; exit 2; }
[ -f "$USMAP_FILE" ] || { echo "error: usmap not mounted at $USMAP_FILE (generate on a Windows PC with UE4SS)" >&2; exit 2; }

log "Extracting from $PAKS_DIR/$PAK_NAME (usmap $USMAP_FILE)…"
rm -rf "$TMP_OUT"
/opt/extractor/PalworldDataExtractor "$PAKS_DIR" \
  --pak "$PAK_NAME" --usmap "$USMAP_FILE" --out "$TMP_OUT" --ue-version "$UE_VERSION"

log "Converting to dashboard datasets → $OUT_DATA (icons → $OUT_ICONS)…"
python3 /opt/convert.py --pde-dir "$TMP_OUT" --out-data "$OUT_DATA" --out-icons "$OUT_ICONS"

log "Done. Mount $OUT_DATA + $OUT_ICONS into the dashboard (or copy into data/ + public/palworld-icons/)."
