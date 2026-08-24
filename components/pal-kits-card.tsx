'use client'

// PATCH (not upstream): reusable Pal-team kits (docs/specs/give-kits.md). Define named teams
// (Pal + level + count) and hand one to an online player via repeated PalDefender `givepal`
// calls. Pal ids are picked from the operator's extracted dataset (searchable by name) and
// validated server-side. Admin-only (the route enforces it). Mirrors GiveKitsCard.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { fetchDatasets, type DatasetEntry } from '@/lib/rcon-datasets'
import { ItemPicker } from '@/components/give-kits-card'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { PawPrintIcon, PlusIcon, Trash2Icon, PencilIcon, XIcon, UsersRoundIcon, RefreshCwIcon } from 'lucide-react'

type KitPal = { palId: string; level: number; count: number }
type PalKit = { id: string; name: string; pals: KitPal[] }

export function PalKitsCard() {
  const { config, players } = useServer()
  const [kits, setKits] = useState<PalKit[]>([])
  const [pals, setPals] = useState<DatasetEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [target, setTarget] = useState('')
  const [givingId, setGivingId] = useState<string | null>(null)
  const [editing, setEditing] = useState<PalKit | null>(null)

  const nameById = useMemo(() => new Map(pals.map((p) => [p.id, p.name ?? p.id])), [pals])

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    try {
      const res = await fetch('/api/give-kits', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? res.statusText)
      setKits(j.palKits ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load Pal teams')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    void load()
    void fetchDatasets().then((d) => setPals(d.pals ?? []))
  }, [load])

  useEffect(() => {
    if (!target && players.length) setTarget(players[0].userId)
  }, [players, target])

  const give = useCallback(
    async (kit: PalKit) => {
      if (!config) return
      if (!target) return toast.error('Pick a target player first')
      setGivingId(kit.id)
      try {
        const res = await fetch('/api/give-kits', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'givePal', kitId: kit.id, userId: target }),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? res.statusText)
        const who = players.find((p) => p.userId === target)?.name ?? target
        const msg = `Gave ${j.given} Pal${j.given === 1 ? '' : 's'} from "${kit.name}" to ${who}`
        if (j.unknownPalIds?.length) toast.warning(`${msg}. Unknown ids skipped: ${j.unknownPalIds.join(', ')}`)
        else toast.success(msg)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Give failed')
      } finally {
        setGivingId(null)
      }
    },
    [config, target, players],
  )

  const remove = useCallback(
    async (kit: PalKit) => {
      if (!config) return
      try {
        const res = await fetch('/api/give-kits', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'deletePal', id: kit.id }),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? res.statusText)
        setKits(j.palKits ?? [])
        toast.success(`Deleted "${kit.name}"`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Delete failed')
      }
    },
    [config],
  )

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <PawPrintIcon className="size-3.5" /> Pal Teams
        </h3>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={load} className="gap-1.5" aria-label="Refresh Pal teams">
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing({ id: '', name: '', pals: [{ palId: '', level: 1, count: 1 }] })} className="gap-1.5">
            <PlusIcon className="size-3.5" /> New team
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Hand a whole Pal team to a player via PalDefender <code className="font-mono">givepal</code>. Party holds 5 — extras go to the Palbox. Admin-only.
      </p>

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

      {loading && !kits.length ? (
        <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground"><Spinner className="size-4" /> Loading…</div>
      ) : (
        <div className="flex flex-col gap-2">
          {kits.length === 0 && <p className="text-sm text-muted-foreground">No Pal teams yet — create one.</p>}
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
                  <Button size="sm" onClick={() => give(kit)} disabled={givingId === kit.id || !target} className="h-7 gap-1.5 px-2.5">
                    {givingId === kit.id ? <Spinner className="size-3.5" /> : <PawPrintIcon className="size-3.5" />} Give
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {kit.pals.map((p, i) => (
                  <span key={i} className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground" title={p.palId}>
                    {nameById.get(p.palId) ?? p.palId} Lv{p.level}{p.count > 1 ? ` ×${p.count}` : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <PalKitEditor kit={editing} pals={pals} onCancel={() => setEditing(null)} onSaved={(k) => { setKits(k); setEditing(null) }} config={config} />
      )}
    </div>
  )
}

function PalKitEditor({
  kit,
  pals,
  onCancel,
  onSaved,
  config,
}: {
  kit: PalKit
  pals: DatasetEntry[]
  onCancel: () => void
  onSaved: (kits: PalKit[]) => void
  config: ReturnType<typeof useServer>['config']
}) {
  const [name, setName] = useState(kit.name)
  const [rows, setRows] = useState<KitPal[]>(kit.pals.length ? kit.pals : [{ palId: '', level: 1, count: 1 }])
  const [saving, setSaving] = useState(false)

  const setRow = (i: number, patch: Partial<KitPal>) => setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)))
  const addRow = () => setRows((r) => [...r, { palId: '', level: 1, count: 1 }])
  const delRow = (i: number) => setRows((r) => r.filter((_, idx) => idx !== i))

  const save = async () => {
    if (!config) return
    const clean = rows.filter((r) => r.palId.trim())
    if (!name.trim()) return toast.error('Name the team')
    if (!clean.length) return toast.error('Add at least one Pal')
    setSaving(true)
    try {
      const res = await fetch('/api/give-kits', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'savePal', palKit: { id: kit.id || undefined, name: name.trim(), pals: clean } }),
      })
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? res.statusText)
      onSaved(j.palKits ?? [])
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
        <span className="flex items-center gap-1.5 text-sm font-medium"><UsersRoundIcon className="size-4" /> {kit.id ? 'Edit team' : 'New team'}</span>
        <Button size="sm" variant="ghost" onClick={onCancel} className="h-7 px-2" aria-label="Close editor"><XIcon className="size-4" /></Button>
      </div>
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name (e.g. Starter Team)" />
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <ItemPicker items={pals} value={row.palId} onChange={(id) => setRow(i, { palId: id })} />
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Lv
              <Input
                type="number" min={1} max={60} value={row.level}
                onChange={(e) => setRow(i, { level: Math.max(1, Math.min(60, Math.floor(Number(e.target.value) || 1))) })}
                className="w-16" aria-label="Level"
              />
            </label>
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              ×
              <Input
                type="number" min={1} max={10} value={row.count}
                onChange={(e) => setRow(i, { count: Math.max(1, Math.min(10, Math.floor(Number(e.target.value) || 1))) })}
                className="w-14" aria-label="Count"
              />
            </label>
            <Button size="sm" variant="ghost" onClick={() => delRow(i)} className="h-8 px-2 text-destructive" aria-label="Remove Pal"><Trash2Icon className="size-3.5" /></Button>
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={addRow} className="gap-1.5 self-start"><PlusIcon className="size-3.5" /> Add Pal</Button>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">{saving ? <Spinner className="size-3.5" /> : null} Save team</Button>
      </div>
    </div>
  )
}
