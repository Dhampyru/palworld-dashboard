# Game-data extractor

Turns your **own** Palworld game files into the dashboard's picker datasets
(names) + Pal icons — the runtime clean-room path. Nothing of Pocketpair's is
redistributed: the pak and usmap are yours, mounted at run time, and only your
extracted data is written out.

Built on a ported fork of
[PalworldDataExtractor](https://github.com/Dhampyru/PalworldDataExtractor) (MIT;
CUE4Parse Apache-2.0) pinned by SHA, paired with `scripts/pde/convert.py`.

## Prerequisite: a `mappings.usmap`

You must supply a `.usmap` for your game version. It **can't** be generated on a
headless server — make it on a Windows PC with UE4SS after each game update and
copy it over. This is the one manual step.

## Use

```bash
# build (context = repo root)
docker build -f tools/game-data-extractor/Dockerfile -t palworld-data-extractor .

# run: mount your paks (ro), your usmap (ro), and two output dirs
docker run --rm \
  -v /path/to/Pal/Content/Paks:/paks:ro \
  -v /path/to/mappings.usmap:/mappings.usmap:ro \
  -v "$PWD/data":/data \
  -v "$PWD/public/palworld-icons":/icons \
  palworld-data-extractor
```

Outputs `data/{items,pals,eggs}.json` (ids + English names) and
`public/palworld-icons/pal/*.png`. Overrides via env: `PAK_NAME`
(default `Pal-WindowsServer.pak`), `UE_VERSION` (default `5.1`).

## Notes

- **Item icons** aren't produced (PDE is Pal-focused) — items get names only;
  Pal icons are included.
- Verified against a live 1.0 server pak: 707 pals / 1993 named items / 293 Pal
  icons, English names matching the FModel path.
- To bump the parser after a game/CUE4Parse update, repin `PDE_SHA` in the
  Dockerfile (see `docs`/memory for the fork's port notes).
