// Fleet-wide game-data scope id. Kept in this dependency-free module (no node/
// server imports) so both the client (fleet-view) and server (instances, routes)
// can import it without pulling server-only code into the client bundle.
export const GAMEDATA_SHARED_ID = '_shared'

// Ordered icon-id candidates for a dataset id, so ONE base icon can cover a
// family of variants that share the same art in-game. The linker (and the
// coverage counter) try these in order against the uploaded icon set and use the
// first that exists. Keeps uploaded icon sets small: a packaging tool only needs
// the base textures the game's DataTables reference, not one file per variant id.

// Pals: BOSS_/GYM_/RAID_/PREDATOR_ variants reuse the base tribe's icon.
export function palIconCandidates(id: string): string[] {
  const out = [id]
  const base = id.replace(/^(BOSS_|GYM_|RAID_|PREDATOR_|Boss_|Predator_)/, '')
  if (base !== id) out.push(base)
  return out
}

// Items: tier/quality suffixes (_1, _Tier_02, _Default3, _Good…) reuse the base.
export function itemIconCandidates(id: string): string[] {
  const out = [id]
  const strips = [
    id.replace(/_\d+$/, ''),
    id.replace(/_Tier_?\d+$/i, ''),
    id.replace(/_Default\d+$/i, ''),
    id.replace(/_(Good|Normal|Super|Cheap|Legend|Uncommon|Rare|Epic)$/i, ''),
  ]
  for (const s of strips) if (s !== id && !out.includes(s)) out.push(s)
  return out
}

export function iconCandidates(cat: 'pal' | 'item', id: string): string[] {
  return cat === 'pal' ? palIconCandidates(id) : itemIconCandidates(id)
}
