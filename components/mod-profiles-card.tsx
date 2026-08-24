'use client'

import { useCallback, useEffect, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
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
import { BookmarkIcon, RotateCcwIcon, PencilIcon, Trash2Icon, PowerIcon, PowerOffIcon, TriangleAlertIcon } from 'lucide-react'

// PATCH (not upstream): unified mod profiles (lib/mod-profiles.ts, app/api/mod-profiles).
// Sits above the Server/Client sub-tabs since it spans both: a saved profile is a named
// snapshot of the server mod on/off state AND the client loadout selection. Also hosts the
// Enable-all / Disable-all bulk toggle. The server↔client drift/sync UI lives in its own
// block (components/mod-sync-card.tsx).

type ProfileEntry = { id: string; name: string; kind?: string; source: string | null; sourceId: string | null; enabled: boolean }
type ModProfile = {
  id: string
  name: string
  createdAt: number
  note?: string
  server: ProfileEntry[]
  client: ProfileEntry[]
  // Captured mods no longer installed (annotated by the GET). Flagged on the row so a stale
  // profile is obvious before you restore it.
  missing?: { server: ProfileEntry[]; client: ProfileEntry[] }
}
type RestoreReport = {
  server: { applied: number; missing: ProfileEntry[] }
  client: { applied: number; missing: ProfileEntry[] }
  extras: { server: { id: string; name: string }[]; client: { id: string; name: string }[] }
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function counts(entries: ProfileEntry[]): { on: number; off: number } {
  let on = 0
  for (const e of entries) if (e.enabled) on++
  return { on, off: entries.length - on }
}

export function ModProfilesCard({ reloadKey, onChanged }: { reloadKey?: number; onChanged?: () => void } = {}) {
  const { config } = useServer()
  const [profiles, setProfiles] = useState<ModProfile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveName, setSaveName] = useState('')
  const [busy, setBusy] = useState<string | null>(null) // action key currently running
  const [restoreTarget, setRestoreTarget] = useState<ModProfile | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ModProfile | null>(null)
  const [renameTarget, setRenameTarget] = useState<ModProfile | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [bulkTarget, setBulkTarget] = useState<boolean | null>(null) // true = enable all, false = disable all

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/mod-profiles', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to load profiles')
      setProfiles(Array.isArray(data.profiles) ? data.profiles : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load profiles')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const post = useCallback(
    async (body: Record<string, unknown>) => {
      if (!config) throw new Error('Not connected')
      const res = await fetch('/api/mod-profiles', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Request failed')
      return data
    },
    [config],
  )

  const save = useCallback(async () => {
    const name = saveName.trim()
    if (!name) return
    setBusy('save')
    try {
      const data = await post({ action: 'save', name })
      setSaveName('')
      toast.success(data?.note || `Saved profile "${name}".`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(null)
    }
  }, [saveName, post, load])

  const restore = useCallback(
    async (p: ModProfile) => {
      setBusy(`restore:${p.id}`)
      try {
        const data = await post({ action: 'restore', id: p.id })
        const r = data?.report as RestoreReport | undefined
        const applied = (r?.server.applied ?? 0) + (r?.client.applied ?? 0)
        const missing = (r?.server.missing.length ?? 0) + (r?.client.missing.length ?? 0)
        toast.success(
          `Restored "${p.name}" — ${applied} mod(s) set${missing ? `, ${missing} no longer installed` : ''}. ` +
            `Effective on next server restart.`,
        )
        setRestoreTarget(null)
        await load()
        onChanged?.()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Restore failed')
      } finally {
        setBusy(null)
      }
    },
    [post, load, onChanged],
  )

  const remove = useCallback(
    async (p: ModProfile) => {
      setBusy(`delete:${p.id}`)
      try {
        await post({ action: 'delete', id: p.id })
        toast.success(`Deleted "${p.name}".`)
        setDeleteTarget(null)
        await load()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Delete failed')
      } finally {
        setBusy(null)
      }
    },
    [post, load],
  )

  const rename = useCallback(async () => {
    if (!renameTarget) return
    const name = renameValue.trim()
    if (!name) return
    setBusy(`rename:${renameTarget.id}`)
    try {
      await post({ action: 'rename', id: renameTarget.id, name })
      toast.success('Renamed.')
      setRenameTarget(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rename failed')
    } finally {
      setBusy(null)
    }
  }, [renameTarget, renameValue, post, load])

  const applyBulk = useCallback(
    async (enabled: boolean) => {
      setBusy('bulk')
      try {
        const data = await post({ action: 'setAll', enabled })
        const r = data?.result as { server: number; client: number; skippedBuiltins: number } | undefined
        toast.success(
          `${enabled ? 'Enabled' : 'Disabled'} ${r?.server ?? 0} server + ${r?.client ?? 0} client mod(s)` +
            `${r?.skippedBuiltins ? `, ${r.skippedBuiltins} built-in(s) left on` : ''}. Effective on next server restart.`,
        )
        setBulkTarget(null)
        await load()
        onChanged?.()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Bulk toggle failed')
      } finally {
        setBusy(null)
      }
    },
    [post, load, onChanged],
  )

  if (!config) return null

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <BookmarkIcon className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">Mod profiles</h3>
        {loading ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={!!busy}
            onClick={() => setBulkTarget(true)}
            title="Enable every content mod on server + client"
          >
            <PowerIcon className="mr-1 size-3.5" /> Enable all
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs"
            disabled={!!busy}
            onClick={() => setBulkTarget(false)}
            title="Disable every content mod on server + client (built-ins left on)"
          >
            <PowerOffIcon className="mr-1 size-3.5" /> Disable all
          </Button>
        </div>
      </div>

      <div className="space-y-3 p-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {/* ── Save current ── */}
        <div className="flex gap-2">
          <Input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Name this loadout (e.g. “Stable — no client graphics”)"
            className="h-8 text-sm"
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
            }}
          />
          <Button size="sm" className="h-8 shrink-0" disabled={!saveName.trim() || busy === 'save'} onClick={save}>
            {busy === 'save' ? <Spinner className="mr-1 size-3.5" /> : <BookmarkIcon className="mr-1 size-3.5" />}
            Save current
          </Button>
        </div>

        {/* ── Saved profiles ── */}
        {profiles.length === 0 ? (
          <p className="text-xs text-muted-foreground">No saved profiles yet. Save the current set to return to it later.</p>
        ) : (
          <div className="space-y-1.5">
            {profiles.map((p) => {
              const s = counts(p.server)
              const c = counts(p.client)
              const missingList = [...(p.missing?.server ?? []), ...(p.missing?.client ?? [])]
              return (
                <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-2.5 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">saved {timeAgo(p.createdAt)}</div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" className="text-[11px]">
                      server {s.on} on{s.off ? ` / ${s.off} off` : ''}
                    </Badge>
                    <Badge variant="outline" className="text-[11px]">
                      client {c.on} kept{c.off ? ` / ${c.off} off` : ''}
                    </Badge>
                    {missingList.length > 0 ? (
                      <Badge
                        variant="outline"
                        className="gap-1 border-amber-500/50 text-[11px] text-amber-600 dark:text-amber-400"
                        title={'No longer installed (will be skipped on restore):\n' + missingList.map((e) => `• ${e.name}`).join('\n')}
                      >
                        <TriangleAlertIcon className="size-3" />
                        {missingList.length} missing
                      </Badge>
                    ) : null}
                  </div>
                  <div className="ml-auto flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      disabled={!!busy}
                      onClick={() => setRestoreTarget(p)}
                      title="Re-apply this profile's on/off state"
                    >
                      <RotateCcwIcon className="mr-1 size-3" /> Restore
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      disabled={!!busy}
                      onClick={() => {
                        setRenameTarget(p)
                        setRenameValue(p.name)
                      }}
                      title="Rename"
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive hover:text-destructive"
                      disabled={!!busy}
                      onClick={() => setDeleteTarget(p)}
                      title="Delete"
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Enable/Disable all confirm */}
      <AlertDialog open={bulkTarget !== null} onOpenChange={(o) => !o && !busy && setBulkTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{bulkTarget ? 'Enable all mods?' : 'Disable all mods?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {bulkTarget ? 'Enables' : 'Disables'} every content mod on both the server AND the client loadout.
              Framework built-ins (PalDefender and the UE4SS loader components) are left as they are. Server changes
              take effect on the next restart; client changes on the next bundle. You can save a profile first if you
              want to return to the current set.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => bulkTarget !== null && applyBulk(bulkTarget)} disabled={!!busy}>
              {busy === 'bulk' ? <Spinner className="mr-2 size-4" /> : null}
              {bulkTarget ? 'Enable all' : 'Disable all'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restore confirm */}
      <AlertDialog open={!!restoreTarget} onOpenChange={(o) => !o && !busy && setRestoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore “{restoreTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Re-applies the saved on/off state to every mod still installed — on the server AND in the client
              loadout. It never installs or removes a mod; anything in the profile that&apos;s no longer installed is
              reported and skipped. Server changes take effect on the next restart; client changes on the next bundle.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => restoreTarget && restore(restoreTarget)} disabled={!!busy}>
              {busy?.startsWith('restore:') ? <Spinner className="mr-2 size-4" /> : null}
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && !busy && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved profile only. Your installed mods and their current on/off state are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && remove(deleteTarget)}
              disabled={!!busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy?.startsWith('delete:') ? <Spinner className="mr-2 size-4" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Rename */}
      <AlertDialog open={!!renameTarget} onOpenChange={(o) => !o && !busy && setRenameTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rename profile</AlertDialogTitle>
          </AlertDialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            className="h-9"
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename()
            }}
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={rename} disabled={!!busy || !renameValue.trim()}>
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
