'use client'

// PATCH (not upstream): Saves & backups panel (roadmap item 5, docs/specs/
// saves-backups-spec.md). Lists worlds (active/size/players/last-modified) and
// backup tarballs, and drives the /api/saves POST actions: create backup,
// switch active world, restore, delete, plus authed download. Deliberately does
// NOT restart/stop the server -- switch and restore both tell the operator to
// use the header's lifecycle controls, matching the backend's decoupling.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { RestartAutomationCard } from '@/components/restart-automation-card'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DatabaseIcon,
  RefreshCwIcon,
  DownloadIcon,
  Trash2Icon,
  RotateCcwIcon,
  GlobeIcon,
  ArchiveIcon,
  CheckIcon,
  TriangleAlertIcon,
  UsersIcon,
  FileSearchIcon,
  PackageIcon,
  PencilIcon,
  SaveIcon,
  HeartPulseIcon,
  TimerIcon,
  PlusIcon,
  HardDriveIcon,
} from 'lucide-react'

type WorldInfo = {
  id: string
  active: boolean
  sizeBytes: number
  modifiedAt: string | null
  playerCount: number
}
type BackupInfo = { file: string; sizeBytes: number; modifiedAt: string | null }
type BackupSchedule = {
  enabled: boolean
  intervalMinutes: number
  keep: number
  skipWhenEmpty: boolean
  lastRunAt: string | null
  lastCheckAt: string | null
  lastStatus: 'ok' | 'skipped-empty' | 'error' | null
  lastMessage: string | null
}
type PlayerSaveInfo = { playerUid: string; sizeBytes: number; modifiedAt: string | null }
type WorldPlayer = { uid: string; nickname: string; level: number | null; pal_count: number; guild_id: string | null }
type WorldPal = {
  instance_id: string
  character_id: string
  character_key: string
  nickname: string | null
  owner_uid: string | null
  gender: string | null
  level: number
}
type WorldGuild = {
  id: string
  name: string | null
  admin_player_uid: string | null
  player_count: number
}
type WorldData = { players: WorldPlayer[]; pals: WorldPal[]; guilds: WorldGuild[] }
type InvSlot = {
  slot: number
  id: string
  count: number
  category?: string
  type?: string
  rarity?: number
  durability?: number
  bullets?: number
  passives?: string[]
}
type InvContainer = { kind: string; slots: InvSlot[] }
type PlayerInventory = {
  uid: string
  nickname: string
  level: number
  exp: number
  hp: number
  stomach: number
  sanity: number
  status_points: Record<string, number>
  containers: InvContainer[]
}
type PlayerEditValues = {
  level: number
  exp: number
  hp: number
  stomach: number
  sanity: number
  status_points: Record<string, number>
  pal_levels: Record<string, number>
  heal_pals: boolean
  item_counts: Record<string, Record<number, number>>
}
type InspectResult = { playerUid: string; player: WorldPlayer | null; pals: WorldPal[] }
type SavesData = {
  worlds: WorldInfo[]
  backups: BackupInfo[]
  playerSaves: PlayerSaveInfo[]
  activeWorldId: string | null
  disk: { totalBytes: number; freeBytes: number; usedBytes: number } | null
}

// A player save's filename is the Palworld PlayerUId (8 significant hex chars +
// zero padding). Reduce any id to its significant hex so a save can be matched
// to a live roster entry regardless of formatting/padding. A steam id (decimal)
// simply won't collide with an 8-hex PlayerUId, so cross-field matching is safe.
function sigUid(id: string | undefined | null): string {
  return (id ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase().replace(/0+$/, '')
}

// 32-hex PlayerUId (the .sav filename) -> canonical UUID (matches world player.uid).
function uidToUuid(hex: string): string {
  return (
    hex.length === 32
      ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      : hex
  ).toLowerCase()
}

// Friendly labels for the snake_case status-point stat keys the save uses.
const STAT_LABELS: Record<string, string> = {
  max_hp: 'Max HP',
  max_sp: 'Max SP',
  attack: 'Attack',
  weight: 'Weight',
  capture_rate: 'Capture Rate',
  work_speed: 'Work Speed',
}

// "Unnamed Guild" (or blank) is the game's auto-created default a solo player
// never renamed; anything else is a guild the operator likely cares about.
function isNamedGuild(name: string | null): boolean {
  const t = (name ?? '').trim()
  return t.length > 0 && t !== 'Unnamed Guild'
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(1)} GB`
  return `${(n / 1024 ** 4).toFixed(2)} TB`
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function SavesPanel() {
  const { config, players } = useServer()
  const [data, setData] = useState<SavesData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [schedule, setSchedule] = useState<BackupSchedule | null>(null)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [testingSchedule, setTestingSchedule] = useState(false)

  const [confirmSwitch, setConfirmSwitch] = useState<WorldInfo | null>(null)
  const [confirmNewWorld, setConfirmNewWorld] = useState(false)
  const [confirmDeleteWorld, setConfirmDeleteWorld] = useState<WorldInfo | null>(null)
  const [confirmRestore, setConfirmRestore] = useState<BackupInfo | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<BackupInfo | null>(null)
  const [confirmDeletePlayer, setConfirmDeletePlayer] = useState<PlayerSaveInfo | null>(null)
  const [worldData, setWorldData] = useState<WorldData | null>(null)
  const [inspect, setInspect] = useState<InspectResult | null>(null)
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [inventory, setInventory] = useState<PlayerInventory | null>(null)
  const [invLoading, setInvLoading] = useState(false)
  const [editValues, setEditValues] = useState<PlayerEditValues | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)

  // Load & cache the world's players + Pals (Level.sav via psp-inspect). Heavier
  // than the file listing, so it's fetched lazily on the first Inspect click.
  const loadWorldData = useCallback(async (): Promise<WorldData | null> => {
    if (worldData) return worldData
    if (!config) return null
    const res = await fetch('/api/saves/world', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? res.statusText)
    const wd: WorldData = { players: json.players ?? [], pals: json.pals ?? [], guilds: json.guilds ?? [] }
    setWorldData(wd)
    return wd
  }, [config, worldData])

  const runInspect = useCallback(
    async (ps: PlayerSaveInfo) => {
      if (!config) return
      setInspecting(ps.playerUid)
      setInventory(null)
      setEditValues(null)
      let hasCharacter = false
      try {
        const wd = await loadWorldData()
        if (!wd) return
        const target = uidToUuid(ps.playerUid)
        const player = wd.players.find((p) => p.uid.toLowerCase() === target) ?? null
        const pals = wd.pals.filter((pal) => (pal.owner_uid ?? '').toLowerCase() === target)
        setInspect({ playerUid: ps.playerUid, player, pals })
        hasCharacter = player !== null
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Failed to inspect world')
        return
      } finally {
        setInspecting(null)
      }
      // Inventory is a separate, heavier per-player parse -- fetch it lazily and
      // only when the player actually has a character, so the dialog shows level
      // + Pals immediately and the items stream in.
      if (!hasCharacter) return
      setInvLoading(true)
      try {
        const res = await fetch(`/api/saves/player?uid=${encodeURIComponent(ps.playerUid)}`, {
          headers: buildPalworldProxyHeaders(config),
          cache: 'no-store',
        })
        const json = await res.json()
        if (res.ok) setInventory(json as PlayerInventory)
        else toast.error(json.error ?? 'Failed to read inventory')
      } catch {
        toast.error('Failed to read inventory')
      } finally {
        setInvLoading(false)
      }
    },
    [config, loadWorldData],
  )

  // Enter edit mode: prefill the form from the just-loaded inventory (which
  // carries level/exp/hp/stomach/sanity + the stat-point map).
  const startEdit = useCallback(() => {
    if (!inventory) return
    const palLevels: Record<string, number> = {}
    for (const pal of inspect?.pals ?? []) palLevels[pal.instance_id] = pal.level
    const itemCounts: Record<string, Record<number, number>> = {}
    for (const c of inventory.containers) {
      itemCounts[c.kind] = {}
      for (const s of c.slots) itemCounts[c.kind][s.slot] = s.count
    }
    setEditValues({
      level: inventory.level,
      exp: inventory.exp,
      hp: inventory.hp,
      stomach: Math.round(inventory.stomach),
      sanity: Math.round(inventory.sanity),
      status_points: { ...inventory.status_points },
      pal_levels: palLevels,
      heal_pals: false,
      item_counts: itemCounts,
    })
  }, [inventory, inspect])

  // Persist the edit. Level.sav WRITE -- the server must be stopped (the route
  // returns 409 otherwise) and an automatic pre-edit backup is taken.
  const saveEdit = useCallback(async () => {
    if (!config || !inspect || !editValues) return
    setSavingEdit(true)
    const toastId = toast.loading('Saving…')
    try {
      // Only send Pal levels that actually changed from what's on screen.
      const changedLevels: Record<string, number> = {}
      for (const pal of inspect.pals) {
        const next = editValues.pal_levels[pal.instance_id]
        if (typeof next === 'number' && next !== pal.level) changedLevels[pal.instance_id] = next
      }
      // Only send item counts that changed from what's on screen.
      const itemPatch: Record<string, Record<string, number>> = {}
      for (const c of inventory?.containers ?? []) {
        for (const s of c.slots) {
          const next = editValues.item_counts[c.kind]?.[s.slot]
          if (typeof next === 'number' && next !== s.count) {
            ;(itemPatch[c.kind] ??= {})[String(s.slot)] = next
          }
        }
      }
      const edit = {
        level: editValues.level,
        exp: editValues.exp,
        hp: editValues.hp,
        stomach: editValues.stomach,
        sanity: editValues.sanity,
        status_points: editValues.status_points,
        pals: { heal_all: editValues.heal_pals, levels: changedLevels },
        items: itemPatch,
      }
      const res = await fetch('/api/saves', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'editPlayer', playerUid: inspect.playerUid, edit }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      toast.success((json.note as string) ?? 'Saved', { id: toastId })
      // Reflect the applied (clamped) values back into the view, including the
      // edited item counts (0 = removed). Counts the backend may have clamped
      // (max-stack) still refresh on the next Inspect via the dropped cache.
      setInventory((inv) =>
        inv
          ? {
              ...inv,
              level: json.level,
              exp: json.exp,
              hp: json.hp,
              stomach: json.stomach,
              sanity: json.sanity,
              status_points: json.status_points,
              containers: inv.containers.map((c) => ({
                ...c,
                slots: c.slots
                  .map((s) => ({ ...s, count: editValues.item_counts[c.kind]?.[s.slot] ?? s.count }))
                  .filter((s) => s.count > 0),
              })),
            }
          : inv,
      )
      // Reflect new Pal levels into the open dialog's list.
      setInspect((cur) =>
        cur
          ? {
              ...cur,
              pals: cur.pals.map((p) =>
                p.instance_id in changedLevels ? { ...p, level: changedLevels[p.instance_id] } : p,
              ),
            }
          : cur,
      )
      setWorldData(null) // drop the cache so a re-inspect reloads fresh levels
      setEditValues(null)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Save failed', { id: toastId })
    } finally {
      setSavingEdit(false)
    }
  }, [config, inspect, editValues])

  // Has the operator changed anything vs the loaded values? Drives whether the
  // bottom Save/Cancel bar shows at all.
  const editDirty = useMemo(() => {
    if (!editValues || !inventory) return false
    if (
      editValues.level !== inventory.level ||
      editValues.exp !== inventory.exp ||
      editValues.hp !== inventory.hp ||
      editValues.stomach !== Math.round(inventory.stomach) ||
      editValues.sanity !== Math.round(inventory.sanity) ||
      editValues.heal_pals
    ) {
      return true
    }
    for (const k of Object.keys(editValues.status_points)) {
      if (editValues.status_points[k] !== inventory.status_points[k]) return true
    }
    for (const p of inspect?.pals ?? []) {
      if (editValues.pal_levels[p.instance_id] !== p.level) return true
    }
    for (const c of inventory.containers) {
      for (const s of c.slots) {
        if (editValues.item_counts[c.kind]?.[s.slot] !== s.count) return true
      }
    }
    return false
  }, [editValues, inventory, inspect])

  // Name a player save even when the player is OFFLINE. The world save
  // (Level.sav, loaded eagerly below) carries every character's nickname, so
  // prefer that; fall back to the live roster (online only), then null (raw UID).
  const nameForUid = useCallback(
    (playerUid: string): string | null => {
      const uuid = uidToUuid(playerUid)
      const fromWorld = worldData?.players.find((p) => p.uid.toLowerCase() === uuid)?.nickname
      if (fromWorld) return fromWorld
      const target = sigUid(playerUid)
      if (!target) return null
      const match = players.find((p) => [p.playerId, p.userId].some((id) => sigUid(id) === target))
      return match?.name ?? null
    },
    [players, worldData],
  )

  // Is the save's owner currently connected? A player save persists after they
  // leave, so match the file's UID against the live roster to show at a glance
  // whether they're on the server right now (offline is the safe time to delete).
  const isOnlineUid = useCallback(
    (playerUid: string): boolean => {
      const target = sigUid(playerUid)
      if (!target) return false
      return players.some((p) => [p.playerId, p.userId].some((id) => sigUid(id) === target))
    },
    [players],
  )

  // Resolve the player's guild from the world save, so the delete confirm can
  // warn before acting: a named guild is one the operator likely cares about,
  // and a multi-member guild's admin can't be deleted (the backend refuses).
  const guildForUid = useCallback(
    (playerUid: string): { guild: WorldGuild; isAdmin: boolean } | null => {
      if (!worldData) return null
      const uuid = uidToUuid(playerUid)
      const player = worldData.players.find((p) => p.uid.toLowerCase() === uuid)
      if (!player?.guild_id) return null
      const gid = player.guild_id.toLowerCase()
      const guild = worldData.guilds.find((g) => g.id.toLowerCase() === gid)
      if (!guild) return null
      return { guild, isAdmin: (guild.admin_player_uid ?? '').toLowerCase() === uuid }
    },
    [worldData],
  )

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/saves', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      setData(json as SavesData)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load saves')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    load()
  }, [load])

  // Load the auto-backup schedule settings once on mount.
  const loadSchedule = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/saves/schedule', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok) setSchedule(json.schedule as BackupSchedule)
    } catch {
      /* leave null -- the card shows a loading state */
    }
  }, [config])

  useEffect(() => {
    void loadSchedule()
  }, [loadSchedule])

  const patchSchedule = useCallback((patch: Partial<BackupSchedule>) => {
    setSchedule((s) => (s ? { ...s, ...patch } : s))
  }, [])

  const saveSchedule = useCallback(async () => {
    if (!config || !schedule) return
    setSavingSchedule(true)
    const toastId = toast.loading('Saving…')
    try {
      const res = await fetch('/api/saves/schedule', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          settings: {
            enabled: schedule.enabled,
            intervalMinutes: schedule.intervalMinutes,
            keep: schedule.keep,
            skipWhenEmpty: schedule.skipWhenEmpty,
          },
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      setSchedule(json.schedule as BackupSchedule)
      toast.success((json.note as string) ?? 'Saved', { id: toastId })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Save failed', { id: toastId })
    } finally {
      setSavingSchedule(false)
    }
  }, [config, schedule])

  const testSchedule = useCallback(async () => {
    if (!config) return
    setTestingSchedule(true)
    const toastId = toast.loading('Running test backup…')
    try {
      const res = await fetch('/api/saves/schedule', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      setSchedule(json.schedule as BackupSchedule)
      toast.success((json.note as string) ?? 'Test finished', { id: toastId })
      await load() // a new auto-backup now shows in the Backups list
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Test failed', { id: toastId })
    } finally {
      setTestingSchedule(false)
    }
  }, [config, load])

  // Eagerly load the world summary once player saves are known, so each save
  // shows its owner's name even while they're offline -- no Inspect needed.
  // Best-effort: on failure, rows just fall back to the roster/raw UID.
  useEffect(() => {
    if (data?.playerSaves?.length) void loadWorldData().catch(() => {})
  }, [data?.playerSaves?.length, loadWorldData])

  const runAction = useCallback(
    async (key: string, body: Record<string, unknown>, onOk: (data: Record<string, unknown>) => void) => {
      if (!config) return
      setBusy(key)
      const toastId = toast.loading('Working…')
      try {
        const res = await fetch('/api/saves', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        // A 200 with success:false is a soft refusal (e.g. guild admin) -- the
        // note explains why nothing changed; don't dress it up as a success.
        if (json.success === false) {
          toast.warning((json.note as string) ?? 'No change made', { id: toastId })
        } else {
          toast.success((json.note as string) ?? 'Done', { id: toastId })
        }
        onOk(json)
        await load()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Action failed', { id: toastId })
      } finally {
        setBusy(null)
      }
    },
    [config, load],
  )

  const download = useCallback(
    async (file: string) => {
      if (!config) return
      setBusy(`dl:${file}`)
      try {
        const res = await fetch(`/api/saves/download?file=${encodeURIComponent(file)}`, {
          headers: buildPalworldProxyHeaders(config),
          cache: 'no-store',
        })
        if (!res.ok) throw new Error('download failed')
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = file
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      } catch {
        toast.error('Failed to download backup')
      } finally {
        setBusy(null)
      }
    },
    [config],
  )

  return (
    <div className="flex h-full min-h-[30rem] flex-col p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <DatabaseIcon className="size-5" />
          <h2 className="text-lg font-semibold">Maintenance</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => runAction('backup', { action: 'backup' }, () => {})}
            disabled={busy !== null}
            className="gap-1.5"
          >
            {busy === 'backup' ? <Spinner className="size-4" /> : <ArchiveIcon className="size-3.5" />}
            Back up now
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
            <RefreshCwIcon className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} /> Refresh
          </Button>
        </div>
      </div>

      <p className="mt-1 text-sm text-muted-foreground">
        Back up and restore worlds. Switching a world or restoring a backup takes effect on the next
        server restart — use the header controls to restart or stop the server.
      </p>

      {data?.disk && data.disk.totalBytes > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
          <HardDriveIcon className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Disk</span>
          <span className="font-medium text-foreground">{fmtBytes(data.disk.freeBytes)}</span>
          <span className="text-muted-foreground">free of {fmtBytes(data.disk.totalBytes)}</span>
          {(() => {
            const pct = Math.min(100, Math.max(0, Math.round((data.disk.usedBytes / data.disk.totalBytes) * 100)))
            return (
              <>
                <div className="ml-1 h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                  <div
                    className={pct >= 90 ? 'h-full bg-destructive' : 'h-full bg-primary'}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className={pct >= 90 ? 'text-destructive' : 'text-muted-foreground'}>{pct}% used</span>
              </>
            )
          })()}
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <ScrollArea className="mt-3 min-h-0 flex-1">
        <div className="flex flex-col gap-5 pr-2">
          {/* Restart automation (roadmap #6) — pinned to the top */}
          <RestartAutomationCard />

          {/* ── Saves & Backups category ── */}
          <div className="flex items-center gap-2 border-t pt-4">
            <DatabaseIcon className="size-4" />
            <h3 className="text-sm font-semibold">Saves &amp; Backups</h3>
          </div>

          {/* Auto-backup schedule */}
          <section className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <TimerIcon className="size-3.5" /> Auto-backup
              </h3>
              {schedule && (
                <Switch
                  checked={schedule.enabled}
                  onCheckedChange={(v) => patchSchedule({ enabled: v })}
                  aria-label="Enable auto-backup"
                />
              )}
            </div>

            {!schedule ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : (
              <>
                <div className={`flex flex-col gap-3 ${schedule.enabled ? '' : 'pointer-events-none opacity-50'}`}>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col gap-1">
                      <Label className="text-[11px] text-muted-foreground">Every (minutes)</Label>
                      <Input
                        type="number"
                        min={5}
                        max={1440}
                        className="h-8 text-xs"
                        value={schedule.intervalMinutes}
                        onChange={(e) => patchSchedule({ intervalMinutes: Number(e.target.value) })}
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-[11px] text-muted-foreground">Keep (newest N)</Label>
                      <Input
                        type="number"
                        min={1}
                        max={200}
                        className="h-8 text-xs"
                        value={schedule.keep}
                        onChange={(e) => patchSchedule({ keep: Number(e.target.value) })}
                      />
                    </div>
                  </div>
                  <label className="flex items-start gap-2">
                    <Switch
                      checked={schedule.skipWhenEmpty}
                      onCheckedChange={(v) => patchSchedule({ skipWhenEmpty: v })}
                      className="mt-0.5"
                    />
                    <span className="text-xs text-muted-foreground">
                      Skip when no players are online{' '}
                      <span className="text-[11px]">(avoids stacking identical backups)</span>
                    </span>
                  </label>
                </div>

                <p className="text-[11px] text-muted-foreground">
                  Last auto-backup:{' '}
                  <span className="text-foreground">
                    {schedule.lastRunAt ? fmtDate(schedule.lastRunAt) : 'never'}
                  </span>
                  {schedule.lastStatus && schedule.lastStatus !== 'ok' && schedule.lastCheckAt && (
                    <>
                      {' '}
                      · last check{' '}
                      <span className={schedule.lastStatus === 'error' ? 'text-destructive' : ''}>
                        {schedule.lastStatus === 'skipped-empty' ? 'skipped (empty)' : 'error'}
                      </span>{' '}
                      {fmtDate(schedule.lastCheckAt)}
                    </>
                  )}
                  {schedule.enabled && (
                    <>
                      {' '}
                      · keeps the newest {schedule.keep} auto-backup{schedule.keep === 1 ? '' : 's'}
                    </>
                  )}
                </p>

                <div className="flex items-center gap-2">
                  <Button size="sm" className="h-8 gap-1.5" onClick={saveSchedule} disabled={savingSchedule}>
                    {savingSchedule ? <Spinner className="size-3.5" /> : <SaveIcon className="size-3.5" />}
                    Save settings
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5"
                    onClick={testSchedule}
                    disabled={testingSchedule}
                  >
                    {testingSchedule ? <Spinner className="size-3.5" /> : <ArchiveIcon className="size-3.5" />}
                    Test now
                  </Button>
                </div>
              </>
            )}
          </section>

          {/* Worlds */}
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <GlobeIcon className="size-3.5" /> Worlds ({data?.worlds.length ?? 0})
              </h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmNewWorld(true)}
                disabled={busy !== null}
                className="gap-1.5"
                title="Start a fresh world (your current world is kept)"
              >
                <PlusIcon className="size-3.5" /> New world
              </Button>
            </div>
            {data?.worlds.length ? (
              data.worlds.map((w) => (
                <div key={w.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                  <div className="flex min-w-0 flex-col">
                    <div className="flex items-center gap-2">
                      <code className="truncate font-mono text-xs">{w.id}</code>
                      {w.active && (
                        <Badge className="bg-emerald-500/15 text-[10px] text-emerald-600 dark:text-emerald-400">
                          active
                        </Badge>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground">
                      {fmtBytes(w.sizeBytes)} · {w.playerCount} player{w.playerCount === 1 ? '' : 's'} · modified{' '}
                      {fmtDate(w.modifiedAt)}
                    </span>
                  </div>
                  {!w.active && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirmSwitch(w)}
                        disabled={busy !== null}
                        className="gap-1.5"
                      >
                        <CheckIcon className="size-3.5" /> Make active
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setConfirmDeleteWorld(w)}
                        disabled={busy !== null}
                        className="text-destructive hover:text-destructive"
                        title="Delete this world (permanent)"
                      >
                        {busy === `deleteWorld:${w.id}` ? (
                          <Spinner className="size-3.5" />
                        ) : (
                          <Trash2Icon className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : 'No worlds found.'}</p>
            )}
          </section>

          {/* Backups */}
          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ArchiveIcon className="size-3.5" /> Backups ({data?.backups.length ?? 0})
            </h3>
            {data?.backups.length ? (
              data.backups.map((b) => (
                <div key={b.file} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                  <div className="flex min-w-0 flex-col">
                    <code className="truncate font-mono text-xs">{b.file}</code>
                    <span className="text-[11px] text-muted-foreground">
                      {fmtBytes(b.sizeBytes)} · {fmtDate(b.modifiedAt)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => download(b.file)}
                      disabled={busy !== null}
                      className="gap-1.5"
                    >
                      {busy === `dl:${b.file}` ? <Spinner className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
                      <span className="hidden sm:inline">Download</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmRestore(b)}
                      disabled={busy !== null}
                      className="gap-1.5"
                    >
                      <RotateCcwIcon className="size-3.5" />
                      <span className="hidden sm:inline">Restore</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setConfirmDelete(b)}
                      disabled={busy !== null}
                      aria-label="Delete backup"
                      className="size-8 text-destructive hover:bg-destructive/10"
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : 'No backups yet.'}</p>
            )}
          </section>

          {/* Player saves (active world) */}
          <section className="flex flex-col gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <UsersIcon className="size-3.5" /> Player saves ({data?.playerSaves.length ?? 0})
            </h3>
            <p className="text-[11px] text-muted-foreground">
              One per player who has loaded the active world. <span className="font-medium">Delete player</span>{' '}
              wipes their character, Pals, inventory and base from the world save so they start fresh at
              character creation on next join. The server must be <span className="font-medium">stopped</span>{' '}
              first, a backup is taken automatically, and a guild admin can’t be deleted until their guild is gone.
            </p>
            {data?.playerSaves.length ? (
              data.playerSaves.map((ps) => {
                const name = nameForUid(ps.playerUid)
                const online = isOnlineUid(ps.playerUid)
                return (
                  <div key={ps.playerUid} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm">
                        {name ?? <span className="text-muted-foreground">Unknown player</span>}
                        {online ? (
                          <span className="ml-1.5 text-[11px] font-normal text-emerald-600 dark:text-emerald-400">
                            online
                          </span>
                        ) : (
                          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">(offline)</span>
                        )}
                      </span>
                      <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {ps.playerUid} · {fmtBytes(ps.sizeBytes)} · {fmtDate(ps.modifiedAt)}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => runInspect(ps)}
                        disabled={inspecting !== null}
                        className="gap-1.5"
                      >
                        {inspecting === ps.playerUid ? <Spinner className="size-3.5" /> : <FileSearchIcon className="size-3.5" />}
                        <span className="hidden sm:inline">Inspect</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setConfirmDeletePlayer(ps)}
                        disabled={busy !== null}
                        className="gap-1.5 text-destructive hover:bg-destructive/10"
                      >
                        <Trash2Icon className="size-3.5" /> <span className="hidden sm:inline">Delete player</span>
                      </Button>
                    </div>
                  </div>
                )
              })
            ) : (
              <p className="text-sm text-muted-foreground">
                {loading ? 'Loading…' : 'No player saves in the active world.'}
              </p>
            )}
          </section>
        </div>
      </ScrollArea>

      {/* Switch confirm */}
      <AlertDialog open={confirmSwitch !== null} onOpenChange={(o) => !o && setConfirmSwitch(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make this world active?</AlertDialogTitle>
            <AlertDialogDescription>
              Sets <code className="font-mono text-xs">{confirmSwitch?.id}</code> as the active world. It loads on
              the next server restart — the current world keeps running until then.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmSwitch) runAction('switch', { action: 'switch', worldId: confirmSwitch.id }, () => {})
                setConfirmSwitch(null)
              }}
            >
              Make active
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* New world confirm — non-destructive (current world is kept) */}
      <AlertDialog open={confirmNewWorld} onOpenChange={setConfirmNewWorld}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Start a new world?</AlertDialogTitle>
            <AlertDialogDescription>
              Creates a fresh, empty world and sets it active. It&apos;s generated on the next server{' '}
              <strong>restart</strong> — players joining after that start over. Your current world is{' '}
              <strong>kept</strong> and stays under Worlds, so you can switch back to it (or delete it) anytime.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                runAction('newWorld', { action: 'newWorld' }, () => {})
                setConfirmNewWorld(false)
              }}
            >
              Create new world
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete world confirm — destructive */}
      <AlertDialog open={confirmDeleteWorld !== null} onOpenChange={(o) => !o && setConfirmDeleteWorld(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this world?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently deletes <code className="font-mono text-xs">{confirmDeleteWorld?.id}</code> and all its save
              data ({confirmDeleteWorld ? fmtBytes(confirmDeleteWorld.sizeBytes) : ''},{' '}
              {confirmDeleteWorld?.playerCount ?? 0} player{confirmDeleteWorld?.playerCount === 1 ? '' : 's'}). A full{' '}
              <code className="font-mono text-xs">preworlddelete</code> backup is taken first, so it&apos;s recoverable
              via Restore. This is not the active world.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmDeleteWorld)
                  runAction(
                    `deleteWorld:${confirmDeleteWorld.id}`,
                    { action: 'deleteWorld', worldId: confirmDeleteWorld.id },
                    () => {},
                  )
                setConfirmDeleteWorld(null)
              }}
            >
              Delete world
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restore confirm — the dangerous one */}
      <AlertDialog open={confirmRestore !== null} onOpenChange={(o) => !o && setConfirmRestore(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlertIcon className="size-4 text-amber-500" /> Restore this backup?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This overwrites the current SaveGames with{' '}
              <code className="font-mono text-xs">{confirmRestore?.file}</code>. The server must be{' '}
              <span className="font-semibold">stopped</span> first (restore is refused while it is running). Your
              current world is snapshotted to a new <code className="font-mono text-xs">prerestore</code> backup
              before anything is overwritten, so this is reversible. Start the server afterward to load it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 hover:bg-amber-600/90"
              onClick={() => {
                if (confirmRestore) runAction('restore', { action: 'restore', file: confirmRestore.file }, () => {})
                setConfirmRestore(null)
              }}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently removes <code className="font-mono text-xs">{confirmDelete?.file}</code>. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (confirmDelete) runAction('delete', { action: 'delete', file: confirmDelete.file }, () => {})
                setConfirmDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete player save confirm */}
      <AlertDialog open={confirmDeletePlayer !== null} onOpenChange={(o) => !o && setConfirmDeletePlayer(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlertIcon className="size-4 text-destructive" /> Delete this player from the world?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeletePlayer && nameForUid(confirmDeletePlayer.playerUid) ? (
                <>
                  <span className="font-semibold">{nameForUid(confirmDeletePlayer.playerUid)}</span>&apos;s
                </>
              ) : (
                <>This player&apos;s</>
              )}{' '}
              character, Pals, inventory and base are removed from the world save (
              <code className="font-mono text-xs">{confirmDeletePlayer?.playerUid}</code>), so they start over at
              character creation on next join. The server must be <span className="font-semibold">stopped</span>{' '}
              first (this is refused while it is running). A <code className="font-mono text-xs">predelete</code>{' '}
              backup is taken automatically before anything is changed, so it&apos;s reversible via Restore. Their own
              one-person guild is removed with them; the admin of a shared multi-member guild can&apos;t be deleted
              until that guild is transferred or removed.
            </AlertDialogDescription>
            {confirmDeletePlayer &&
              (() => {
                const g = guildForUid(confirmDeletePlayer.playerUid)
                if (!g) return null
                const named = isNamedGuild(g.guild.name)
                const multi = g.guild.player_count > 1
                if (!named && !multi) return null // solo Unnamed guild — the default text already covers it
                return (
                  <div className="mt-1 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      {multi && g.isAdmin ? (
                        <>
                          This player is the <span className="font-semibold">admin</span> of{' '}
                          {named ? <>the guild “{g.guild.name}”</> : <>a guild</>} with {g.guild.player_count}{' '}
                          members — deletion will be <span className="font-semibold">refused</span>. Transfer or
                          remove that guild first.
                        </>
                      ) : named ? (
                        <>
                          Belongs to the named guild “<span className="font-semibold">{g.guild.name}</span>”
                          {multi ? ` (${g.guild.player_count} members)` : ''}.{' '}
                          {multi
                            ? 'Only this player is removed; the guild and its other members stay.'
                            : 'This one-person guild will be removed along with them.'}
                        </>
                      ) : (
                        <>
                          Shares a guild with {g.guild.player_count - 1} other member
                          {g.guild.player_count - 1 === 1 ? '' : 's'} — only this player is removed; the others stay.
                        </>
                      )}
                    </span>
                  </div>
                )
              })()}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (confirmDeletePlayer)
                  runAction(
                    'resetPlayer',
                    { action: 'resetPlayer', playerUid: confirmDeletePlayer.playerUid },
                    () => {},
                  )
                setConfirmDeletePlayer(null)
              }}
            >
              Delete player
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Save Inspector — a player's level + their Pals, read from Level.sav */}
      <AlertDialog
        open={inspect !== null}
        onOpenChange={(o) => {
          if (!o) {
            setInspect(null)
            setEditValues(null)
          }
        }}
      >
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <FileSearchIcon className="size-4" /> {inspect?.player?.nickname || 'Player'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {inspect?.player
                ? `Level ${inspect.player.level ?? '—'} · ${inspect.player.pal_count} Pal${inspect.player.pal_count === 1 ? '' : 's'} — read from the world save.`
                : 'No matching character in the world save (no character created yet).'}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
            {/* Stats (view + Stage 3 edit) */}
            {inspect?.player && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Stats
                  </div>
                  {!editValues && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 gap-1.5 text-xs"
                      disabled={!inventory}
                      onClick={startEdit}
                    >
                      <PencilIcon className="size-3.5" /> Edit
                    </Button>
                  )}
                </div>

                {editValues ? (
                  <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2.5">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {(
                        [
                          ['Level', 'level'],
                          ['Exp', 'exp'],
                          ['HP', 'hp'],
                          ['Stomach', 'stomach'],
                          ['Sanity', 'sanity'],
                        ] as const
                      ).map(([label, key]) => (
                        <label key={key} className="flex flex-col gap-0.5 text-[10px] text-muted-foreground">
                          {label}
                          <Input
                            type="number"
                            className="h-8 text-xs"
                            value={editValues[key]}
                            onChange={(e) =>
                              setEditValues((v) => (v ? { ...v, [key]: Number(e.target.value) } : v))
                            }
                          />
                        </label>
                      ))}
                    </div>
                    {Object.keys(editValues.status_points).length > 0 && (
                      <div className="flex flex-col gap-1">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Stat points
                        </div>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {Object.keys(editValues.status_points).map((stat) => (
                            <label
                              key={stat}
                              className="flex flex-col gap-0.5 text-[10px] text-muted-foreground"
                            >
                              {STAT_LABELS[stat] ?? stat}
                              <Input
                                type="number"
                                className="h-8 text-xs"
                                value={editValues.status_points[stat]}
                                onChange={(e) =>
                                  setEditValues((v) =>
                                    v
                                      ? {
                                          ...v,
                                          status_points: {
                                            ...v.status_points,
                                            [stat]: Number(e.target.value),
                                          },
                                        }
                                      : v,
                                  )
                                }
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : invLoading ? (
                  <p className="text-xs text-muted-foreground">Loading stats…</p>
                ) : inventory ? (
                  <p className="text-xs text-muted-foreground">
                    Level {inventory.level} · Exp {inventory.exp} · HP {inventory.hp} · Stomach{' '}
                    {Math.round(inventory.stomach)} · Sanity {Math.round(inventory.sanity)}
                  </p>
                ) : null}
              </div>
            )}

            {/* Pals */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <UsersIcon className="size-3.5" /> Pals
                </div>
                {editValues && inspect && inspect.pals.length > 0 && (
                  <Button
                    size="sm"
                    variant={editValues.heal_pals ? 'default' : 'outline'}
                    className="h-6 gap-1.5 text-[11px]"
                    onClick={() => setEditValues((v) => (v ? { ...v, heal_pals: !v.heal_pals } : v))}
                  >
                    <HeartPulseIcon className="size-3.5" />
                    {editValues.heal_pals ? 'Will heal on save' : 'Heal all Pals'}
                  </Button>
                )}
              </div>
              {inspect && inspect.pals.length > 0 ? (
                <div className="overflow-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted/40">
                      <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="p-1.5 text-left">Pal</th>
                        <th className="p-1.5 text-left">Lvl</th>
                        <th className="p-1.5 text-left">Nickname</th>
                        <th className="p-1.5 text-left">Sex</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspect.pals.map((pal) => (
                        <tr key={pal.instance_id} className="border-t">
                          <td className="p-1.5 font-mono">{pal.character_key || pal.character_id}</td>
                          <td className="p-1.5 tabular-nums">
                            {editValues ? (
                              <Input
                                type="number"
                                className="h-7 w-16 text-xs"
                                value={editValues.pal_levels[pal.instance_id] ?? pal.level}
                                onChange={(e) =>
                                  setEditValues((v) =>
                                    v
                                      ? {
                                          ...v,
                                          pal_levels: {
                                            ...v.pal_levels,
                                            [pal.instance_id]: Number(e.target.value),
                                          },
                                        }
                                      : v,
                                  )
                                }
                              />
                            ) : (
                              pal.level
                            )}
                          </td>
                          <td className="p-1.5">{pal.nickname || '—'}</td>
                          <td className="p-1.5">{pal.gender ? pal.gender[0].toUpperCase() : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No Pals owned by this player in the world save.</p>
              )}
            </div>

            {/* Inventory (lazy) */}
            {inspect?.player && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <PackageIcon className="size-3.5" /> Inventory
                </div>
                {invLoading ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner className="size-3.5" /> Reading inventory…
                  </p>
                ) : inventory && inventory.containers.some((c) => c.slots.length > 0) ? (
                  <div className="flex flex-col gap-2">
                    {inventory.containers
                      .filter((c) => c.slots.length > 0)
                      .map((c) => (
                        <div key={c.kind} className="rounded-md border">
                          <div className="border-b bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {c.kind} ({c.slots.length})
                          </div>
                          <div className="divide-y">
                            {c.slots.map((s) => (
                              <div
                                key={`${c.kind}-${s.slot}`}
                                className="flex items-center justify-between gap-2 px-2 py-1 text-xs"
                              >
                                <span className="min-w-0 truncate font-mono" title={s.id}>
                                  {s.id}
                                </span>
                                <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                                  {s.category && (
                                    <span className="rounded bg-muted px-1 py-0.5">{s.category}</span>
                                  )}
                                  {typeof s.durability === 'number' && <span title="Durability">dur {Math.round(s.durability)}</span>}
                                  {typeof s.bullets === 'number' && <span title="Ammo loaded">{s.bullets} rd</span>}
                                  {editValues ? (
                                    <Input
                                      type="number"
                                      className="h-7 w-20 text-xs"
                                      title="Count (0 removes it)"
                                      value={editValues.item_counts[c.kind]?.[s.slot] ?? s.count}
                                      onChange={(e) =>
                                        setEditValues((v) =>
                                          v
                                            ? {
                                                ...v,
                                                item_counts: {
                                                  ...v.item_counts,
                                                  [c.kind]: {
                                                    ...v.item_counts[c.kind],
                                                    [s.slot]: Number(e.target.value),
                                                  },
                                                },
                                              }
                                            : v,
                                        )
                                      }
                                    />
                                  ) : (
                                    <span className="tabular-nums text-foreground">×{s.count}</span>
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                  </div>
                ) : inventory ? (
                  <p className="text-xs text-muted-foreground">Empty inventory.</p>
                ) : (
                  <p className="text-xs text-muted-foreground">Inventory unavailable.</p>
                )}
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              Decoded natively from Level.sav via psp-core (MIT). Items show their game IDs — the bundled
              data has no localized names.
            </p>
          </div>

          {/* Edit action bar — pinned to the bottom, shown only once something
              has actually changed (keeps the read view uncluttered). */}
          {editValues && editDirty && (
            <div className="flex flex-col gap-2 border-t pt-3">
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                Writes Level.sav — the server must be <span className="font-semibold">stopped</span> (refused
                otherwise). A <code className="font-mono">preedit</code> backup is taken automatically.
              </p>
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-8 gap-1.5" onClick={saveEdit} disabled={savingEdit}>
                  {savingEdit ? <Spinner className="size-3.5" /> : <SaveIcon className="size-3.5" />}
                  Save changes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => setEditValues(null)}
                  disabled={savingEdit}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
