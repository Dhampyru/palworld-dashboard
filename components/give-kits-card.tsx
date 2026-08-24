'use client'

// PATCH (not upstream): reusable give-items kits (docs/specs/give-kits.md). Define named
// kits (item + amount lists) and hand one to an online player in a single PalDefender
// `giveitems` call. Item ids are picked from the operator's extracted dataset (searchable by
// name) and validated server-side. Admin-only (the route enforces it).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { fetchDatasets, searchDataset, type DatasetEntry } from '@/lib/rcon-datasets'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { GiftIcon, PlusIcon, Trash2Icon, PencilIcon, XIcon, PackagePlusIcon, RefreshCwIcon } from 'lucide-react'

type KitItem = { itemId: string; amount: number }
type GiveKit = { id: string; name: string; items: KitItem[] }

export function GiveKitsCard() {
  const { config, players } = useServer()
  const [kits, setKits] = useState<GiveKit[]>([])
  const [items, setItems] = useState<DatasetEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [target, setTarget] = useState('') // UserId
  const [givingId, setGivingId] = useState<string | null>(null)
  const [editing, setEditing] = useState<GiveKit | null>(null)

  const nameById = useMemo(() => new Map(items.map((i) => [i.id, i.name ?? i.id])), [items])

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    try {
      const res = await fetch('/api/give-kits', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? res.statusText)
      setKits(j.kits ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load kits')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    void load()
    void fetchDatasets().then((d) => setItems(d.items ?? []))
  }, [load])

  // Default the target to the first online player once the roster arrives.
  useEffect(() => {
    if (!target && players.length) setTarget(players[0].userId)
  }, [players, target])

  const give = useCallback(
    async (kit: GiveKit) => {
      if (!config) return
      if (!target) {
        toast.error('Pick a target player first')
        return
      }
      setGivingId(kit.id)
      try {
        const res = await fetch('/api/give-kits', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'give', kitId: kit.id, userId: target }),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? res.statusText)
        const who = players.find((p) => p.userId === target)?.name ?? target
        if (j.unknownItemIds?.length) {
          toast.warning(`Sent "${kit.name}" to ${who}. Unknown ids skipped by the server may include: ${j.unknownItemIds.join(', ')}`)
        } else {
          toast.success(`Gave "${kit.name}" to ${who}`)
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Give failed')
      } finally {
        setGivingId(null)
      }
    },
    [config, target, players],
  )

  const remove = useCallback(
    async (kit: GiveKit) => {
      if (!config) return
      try {
        const res = await fetch('/api/give-kits', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', id: kit.id }),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? res.statusText)
        setKits(j.kits ?? [])
        toast.success(`Deleted "${kit.name}"`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Delete failed')
      }
    },
    [config],
  )

  const onSaved = (updated: GiveKit[]) => {
    setKits(updated)
    setEditing(null)
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <GiftIcon className="size-3.5" /> Give-Items Kits
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={load} className="gap-1.5" aria-label="Refresh kits">
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing({ id: '', name: '', items: [{ itemId: '', amount: 1 }] })} className="gap-1.5">
            <PlusIcon className="size-3.5" /> New kit
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Hand a bundle of items to a player in one PalDefender <code className="font-mono">giveitems</code> call. Admin-only.
      </p>

      {/* Target player */}
      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium text-muted-foreground">Give to</span>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground [&>option]:bg-background [&>option]:text-foreground"
          aria-label="Target player"
        >
          {players.length === 0 && <option value="">No players online</option>}
          {players.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name} ({p.userId})
            </option>
          ))}
        </select>
      </label>

      {/* Kit list */}
      {loading && !kits.length ? (
        <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground"><Spinner className="size-4" /> Loading…</div>
      ) : (
        <div className="flex flex-col gap-2">
          {kits.length === 0 && <p className="text-sm text-muted-foreground">No kits yet — create one.</p>}
          {kits.map((kit) => (
            <div key={kit.id} className="flex flex-col gap-1.5 rounded-md border bg-muted/20 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{kit.name}</span>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(kit)} className="h-7 gap-1 px-2" aria-label={`Edit ${kit.name}`}>
                    <PencilIcon className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove(kit)} className="h-7 gap-1 px-2 text-destructive" aria-label={`Delete ${kit.name}`}>
                    <Trash2Icon className="size-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => give(kit)}
                    disabled={givingId === kit.id || !target}
                    className="h-7 gap-1.5 px-2.5"
                  >
                    {givingId === kit.id ? <Spinner className="size-3.5" /> : <GiftIcon className="size-3.5" />} Give
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {kit.items.map((it, i) => (
                  <span key={i} className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground" title={it.itemId}>
                    {nameById.get(it.itemId) ?? it.itemId} ×{it.amount}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <KitEditor
          kit={editing}
          items={items}
          onCancel={() => setEditing(null)}
          onSaved={onSaved}
          config={config}
        />
      )}
    </div>
  )
}

// ---- inline editor -----------------------------------------------------------------------
function KitEditor({
  kit,
  items,
  onCancel,
  onSaved,
  config,
}: {
  kit: GiveKit
  items: DatasetEntry[]
  onCancel: () => void
  onSaved: (kits: GiveKit[]) => void
  config: ReturnType<typeof useServer>['config']
}) {
  const [name, setName] = useState(kit.name)
  const [rows, setRows] = useState<KitItem[]>(kit.items.length ? kit.items : [{ itemId: '', amount: 1 }])
  const [saving, setSaving] = useState(false)

  const setRow = (i: number, patch: Partial<KitItem>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  const addRow = () => setRows((r) => [...r, { itemId: '', amount: 1 }])
  const delRow = (i: number) => setRows((r) => r.filter((_, idx) => idx !== i))

  const save = async () => {
    if (!config) return
    const cleanItems = rows.filter((r) => r.itemId.trim())
    if (!name.trim()) return toast.error('Name the kit')
    if (!cleanItems.length) return toast.error('Add at least one item')
    setSaving(true)
    try {
      const res = await fetch('/api/give-kits', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', kit: { id: kit.id || undefined, name: name.trim(), items: cleanItems } }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? res.statusText)
      onSaved(j.kits ?? [])
      toast.success(`Saved "${name.trim()}"`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-sm font-medium"><PackagePlusIcon className="size-4" /> {kit.id ? 'Edit kit' : 'New kit'}</span>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 px-2" aria-label="Close editor"><XIcon className="size-4" /></Button>
      </div>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Kit name (e.g. Building Materials)" />
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <ItemPicker items={items} value={row.itemId} onChange={(id) => setRow(i, { itemId: id })} />
            <Input
              type="number"
              min={1}
              max={99999}
              value={row.amount}
              onChange={(e) => setRow(i, { amount: Math.max(1, Math.min(99999, Math.floor(Number(e.target.value) || 1))) })}
              className="w-24"
              aria-label="Amount"
            />
            <Button size="sm" variant="ghost" onClick={() => delRow(i)} className="h-8 px-2 text-destructive" aria-label="Remove item"><Trash2Icon className="size-3.5" /></Button>
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={addRow} className="gap-1.5 self-start"><PlusIcon className="size-3.5" /> Add item</Button>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">{saving ? <Spinner className="size-3.5" /> : null} Save kit</Button>
      </div>
    </div>
  )
}

// ---- entity typeahead (search by name or id) — reused for items AND pals -----------------
export function ItemPicker({ items, value, onChange }: { items: DatasetEntry[]; value: string; onChange: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const selectedName = useMemo(() => items.find((i) => i.id === value)?.name, [items, value])
  const results = useMemo(() => (open && query ? searchDataset(items, query).slice(0, 8) : []), [items, query, open])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div ref={wrapRef} className="relative flex-1">
      <Input
        value={open ? query : value ? `${selectedName ?? value}` : query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          setQuery('')
          setOpen(true)
        }}
        placeholder="Search item by name or id…"
        aria-label="Item"
      />
      {value && !open && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground">{value}</span>
      )}
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border bg-popover shadow-md">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onChange(r.id)
                setOpen(false)
              }}
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <span>{r.name ?? r.id}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{r.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
