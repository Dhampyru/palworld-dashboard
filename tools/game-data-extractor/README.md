# Game-data extractor

Turns your **own** Palworld game files into the dashboard's picker datasets
(names) — the runtime clean-room path. Nothing of Pocketpair's is
redistributed: the pak and usmap are yours, mounted at run time, and only your
extracted data is written out.

Built on a ported fork of
[PalworldDataExtractor](https://github.com/Dhampyru/PalworldDataExtractor) (MIT;
CUE4Parse Apache-2.0) pinned by SHA, paired with `scripts/pde/convert.py`.

## Prerequisite: a `mappings.usmap`

You must supply a `.usmap` for your game version. It **can't** be generated on a
headless server — make it on a Windows PC with UE4SS after each game update and
copy it over. This is the one manual step.

UE4SS's dumper writes a versioned file like
`Pal-5.1.1-0+++UE5+Release-5.1-<hash>.usmap` to
`…\Steam\steamapps\common\Palworld\Pal\Binaries\Win64\ue4ss\usmap\` on the
client. Copy that over — any filename works; point the tool at it via the
`/mappings.usmap` mount (or `USMAP_FILE`).

## Use

```bash
# build (context = repo root)
docker build -f tools/game-data-extractor/Dockerfile -t palworld-data-extractor .

# run: mount your paks (ro), your usmap (ro), and two output dirs
docker run --rm \
  -v /path/to/Pal/Content/Paks:/paks:ro \
  -v /path/to/mappings.usmap:/mappings.usmap:ro \
  -v "$PWD/extracted/data":/data \
  -v "$PWD/extracted/icons":/icons \
  palworld-data-extractor
```

Outputs `{items,pals,eggs}.json` (ids + English names). Pal icons are **not**
produced right now — see the icon note below.
Overrides via env: `PAK_NAME` (default `Pal-WindowsServer.pak`), `UE_VERSION`
(default `5.1`).

## Runtime — no rebuild

The dashboard loads picker names + icons **at runtime** from `PALWORLD_DATASETS_DIR`
and `PALWORLD_ICONS_DIR`. Point those at the output above (the full-stack compose
already mounts `./extracted/{data,icons}`), and the names + icons appear on the
next dashboard start — no rebuild. Re-run the extractor after a game update
(with a fresh usmap) to refresh.

Item icons aren't produced (PDE is Pal-focused). **Pal icons cannot be extracted
from a dedicated-SERVER pak** (`Pal-WindowsServer.pak`): a server never renders, so
UE strips texture pixel data at cook time — the texture's `ImportedSize` survives
but its platform data is empty (`Mips=0`), so no PNG is produced. This is inherent
to the server build, not a parser bug. So against a server pak this tool populates
**names only**. Icons require a CLIENT pak (a gaming PC), which keeps full texture
data — run this tool there to get `pal/*.png`.

## Notes

- **Icons** aren't produced right now (see above) — names only.
- Verified against a live 1.0 server pak: 707 pals / 1993 named items, English
  names matching the FModel path (icons omitted — see the icon note).
- To bump the parser after a game/CUE4Parse update, repin `PDE_SHA` in the
  Dockerfile (see `docs`/memory for the fork's port notes).
