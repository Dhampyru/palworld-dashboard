// PATCH (not upstream): dataset plumbing for the RCON console's typeahead
// pickers (docs/specs/rcon-console.md §6/§9).
//
// The datasets in data/*.json ship EMPTY -- see data/README.md for why, and for
// how to fill them. Everything here is written so that an empty dataset is a
// normal state, not a broken one: pickers degrade to free-text ID entry, which
// accepts any valid identifier. Filling a dataset in later is a data change,
// not a code change.

import itemsData from '@/data/items.json'
import palsData from '@/data/pals.json'
import eggsData from '@/data/eggs.json'

// Only `id` is required, so a dataset can start as bare identifiers and gain
// display names or icons later without touching the picker.
export type DatasetEntry = {
  id: string
  name?: string
  image?: string
}

export type DatasetKey = 'items' | 'pals' | 'eggs' | 'tech'

const STATIC_DATASETS: Record<'items' | 'pals' | 'eggs', DatasetEntry[]> = {
  items: itemsData as DatasetEntry[],
  pals: palsData as DatasetEntry[],
  eggs: eggsData as DatasetEntry[],
}

export function staticDataset(key: 'items' | 'pals' | 'eggs'): DatasetEntry[] {
  return STATIC_DATASETS[key]
}

// Search id and name together, so a dataset with no display names is still
// searchable -- most Palworld identifiers are readable English.
// Matched entries, sorted by display name (falling back to id) so browsing a
// large set isn't dominated by whichever ids sort first (e.g. all Accessory_*).
// Returns ALL matches; the caller decides how many to render.
export function searchDataset(entries: DatasetEntry[], query: string): DatasetEntry[] {
  const needle = query.trim().toLowerCase()
  const matched = needle
    ? entries.filter((entry) => `${entry.id} ${entry.name ?? ''}`.toLowerCase().includes(needle))
    : entries
  return [...matched].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
}

// PalDefender's `gettechids` returns a JSON array of technology IDs from the
// running server. That makes it the ideal dataset source: correct for the
// operator's exact build, and with no redistribution question at all, since
// their own server produced it. `getskinids` has the same shape if skins ever
// get a picker.
export function parseIdListResponse(response: string): DatasetEntry[] {
  const trimmed = response.trim()
  if (!trimmed.startsWith('[')) return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((id) => ({ id }))
  } catch {
    // A truncated or non-JSON response is a missing dataset, not an error --
    // the picker falls back to free text.
    return []
  }
}
