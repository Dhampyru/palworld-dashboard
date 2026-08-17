# Give-Items Kits (+ Pal Teams)

Reusable "kits" that hand a bundle of items to a player in one PalDefender
`giveitems <UserId> ItemId:Amount ItemId:Amount …` call. Built 2026-08-17 at the
owner's request (an alternative to a "free building" mod — hand out the mats
instead of zeroing build costs).

**Pal teams (2026-08-17):** the same feature, for Pals — a named team of
`{palId, level, count}` handed out via one `givepal <UserId> <PalId> <level>` per
Pal (repeated `count` times, capped at 30 calls/kit so a team can't flood). Party
holds 5; extras overflow to the Palbox. Seeds **Starter Team**, **Worker Team**
(base-suitability workers), **Combat Team** (top-tier). Backed by `lib/give-kits.ts`
(`listPalKits`/`savePalKit`/`deletePalKit`/`givePalKit`, `loadPals` for the picker +
validation), the same `app/api/give-kits` route (`savePal`/`deletePal`/`givePal`
actions; GET also returns `palKits`), and `components/pal-kits-card.tsx` (mounted
under the item card in the PalDefender tab; reuses the item card's exported
`ItemPicker` over the pals dataset; rows carry level 1–60 + count 1–10). Pal ids are
regex-guarded before interpolation. The store `data/give-kits.json` gained a
`palKits` array; a pre-existing item-only store auto-seeds the pal half on next read.

## Pieces
- **`lib/give-kits.ts`** — kit model `{ id, name, items: {itemId, amount}[] }`,
  persisted to `data/give-kits.json` (data volume; operational, backed up). Seeds five
  default kits on first read — **Building Materials**, **Starter Kit**, **Capture Kit
  (Spheres)**, **Combat Kit**, **Food Kit** — all ids verified against the live dataset.
  (New kits added to an EXISTING store don't re-seed; they were pushed to the live store
  via the save API so code defaults and the live file stay in sync.) `loadItems()`
  reads `items.json` from the active instance's extracted datasets, falling back to
  the baked `PALWORLD_DATASETS_DIR` (the operator's populated copy). `giveKit()`
  builds the `giveitems` string and runs it via the shared `lib/rcon-exec.ts`
  transport; item ids are checked against the dataset and any unknown-in-dataset ids
  are reported back (a warning, not a hard block — the dataset may be incomplete).
- **`app/api/give-kits/route.ts`** — GET lists kits; POST `save`/`delete`/`give`.
  Admin-only (same gate as the RCON console — `giveitems` is an admin-cheat command).
  Instance-scoped via `runWithInstance`.
- **`components/give-kits-card.tsx`** — a card in the **PalDefender tab** (shown when
  PalDefender is detected; hidden while the settings search box is active). Target
  player dropdown (online roster), a kit list with **Give** per kit, and an inline
  editor (name + item rows with a name/id typeahead over the extracted dataset +
  amounts). Reuses `fetchDatasets`/`searchDataset` for the item picker.

## Notes
- Item ids come from the operator's own extracted dataset (`data/items.json`,
  clean-room — ships empty; populated on this box). No Pocketpair data is shipped.
- `giveitems` targets a connected player by UserId; offline delivery isn't supported
  by the command, so the target picker lists the online roster.
- Amounts clamp to 1..99999; item ids must match `[A-Za-z0-9_]+`.
