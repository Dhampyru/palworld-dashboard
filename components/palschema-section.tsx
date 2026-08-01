'use client'

import { useCallback, useEffect, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
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
import { toast } from 'sonner'
import { DownloadIcon, LayersIcon, ShieldAlertIcon, ShieldCheckIcon, Trash2Icon } from 'lucide-react'

// PATCH (not upstream): PalSchema section (docs/specs/palschema-support.md). A
// distinct Mods-tab section, deliberately not folded into the UE4SS handling.
// PalSchema mods are folders of JSON/JSONC one level deeper than UE4SS mods
// (ue4ss/Mods/PalSchema/Mods/<name>/), with no per-mod toggle (presence =
// active). PalSchema itself is a version-locked pair with its UE4SS build, so the
// install affordance only appears once the loader reports the matching build.

type PalSchemaStatus = { installed: boolean; version: string | null; submodCount: number }
type PalSchemaSubmod = { name: string; fileCount: number; sizeBytes: number; modifiedAt: string | null }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

export function PalSchemaSection({
  palschemaLoaded,
  buildStaged,
  pendingRestart,
  ue4ssEnabled,
  reloadSignal,
  embedded,
}: {
  // PalSchema is genuinely running on the matching build RIGHT NOW (drives green).
  palschemaLoaded: boolean
  // The PalSchema UE4SS build is staged on disk (may not be loaded yet).
  buildStaged: boolean
  // A swap is staged but not yet loaded (restart needed).
  pendingRestart: boolean
  ue4ssEnabled: boolean
  // Bumped by the parent after it installs PalSchema via the chained flow, so
  // this section re-fetches and flips from the install affordance to the manager.
  reloadSignal?: number
  // When true, render without the outer card border/padding so it can sit inside a
  // shared "Installed Mods" card.
  embedded?: boolean
}) {
  const { config } = useServer()
  const [status, setStatus] = useState<PalSchemaStatus | null>(null)
  const [submods, setSubmods] = useState<PalSchemaSubmod[]>([])
  const [pinnedTag, setPinnedTag] = useState('0.6.1')
  const [busy, setBusy] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/game-mods/palschema', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok) {
        setStatus(json.status as PalSchemaStatus)
        setSubmods((json.submods as PalSchemaSubmod[]) ?? [])
        if (typeof json.pinnedTag === 'string') setPinnedTag(json.pinnedTag)
      }
    } catch {
      /* leave as-is */
    }
  }, [config])

  useEffect(() => {
    void load()
  }, [load, reloadSignal])

  const runAction = useCallback(
    async (key: string, init: RequestInit, loadingMsg = 'Working…') => {
      if (!config) return
      setBusy(key)
      const toastId = toast.loading(loadingMsg)
      try {
        const res = await fetch('/api/game-mods/palschema', {
          ...init,
          headers: { ...buildPalworldProxyHeaders(config), ...(init.headers ?? {}) },
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        if (json.status) setStatus(json.status as PalSchemaStatus)
        if (json.submods) setSubmods(json.submods as PalSchemaSubmod[])
        toast.success((json.note as string) ?? 'Done', { id: toastId })
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Failed', { id: toastId })
      } finally {
        setBusy(null)
      }
    },
    [config],
  )

  const downloadLoader = useCallback(
    () =>
      runAction(
        'dl-loader',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'downloadLoader' }),
        },
        'Downloading & installing PalSchema…',
      ),
    [runAction],
  )

  const confirmRemove = useCallback(async () => {
    const name = removeTarget
    setRemoveTarget(null)
    if (!name) return
    await runAction(
      `rm:${name}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', name }),
      },
      `Removing ${name}…`,
    )
  }, [removeTarget, runAction])

  const installed = status?.installed ?? false

  return (
    <div className={`flex flex-col gap-2 ${embedded ? '' : 'rounded-md border p-3'}`}>
      {/* When embedded in the shared "Installed Mods" card, the header row (icon +
          "PalSchema" title + version chip) is dropped: it duplicates the status
          bar below (which already states "PalSchema v… — active"). */}
      {!embedded && (
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <LayersIcon className="size-4" /> PalSchema
          </h3>
          {installed && (
            <span className="text-xs text-muted-foreground">
              {status?.version ? `v${status.version}` : 'version unknown'}
            </span>
          )}
        </div>
      )}

      {status === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !installed ? (
        // ── Not installed ─────────────────────────────────────────────────────
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            PalSchema lets mods edit Palworld data tables (Pals, items, drops…) via JSON, without
            repacking game assets. It is a UE4SS mod that pins to one specific UE4SS build.
          </p>
          {!buildStaged ? (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Blocked — PalSchema requires the <span className="font-medium">experimental-palworld</span>{' '}
              UE4SS build. Swap to it in the UE4SS Loader above, then install PalSchema here.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-8 gap-1.5 text-xs"
                disabled={!!busy}
                onClick={downloadLoader}
                title="Download PalSchema from Okaetsu/PalSchema and install it as a UE4SS mod"
              >
                {busy === 'dl-loader' && <Spinner className="size-3.5" />}
                <DownloadIcon className="size-3.5" /> Install PalSchema {pinnedTag}
              </Button>
              <span className="text-xs text-muted-foreground">matches the installed UE4SS build</span>
            </div>
          )}
        </div>
      ) : (
        // ── Installed ─────────────────────────────────────────────────────────
        <div className="flex flex-col gap-3">
          {/* At-a-glance state, mirroring the PalDefender status bar. Green ONLY
              when PalSchema is genuinely loaded on the matching build right now —
              not merely installed/staged. */}
          {palschemaLoaded ? (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
              <ShieldCheckIcon className="size-4 shrink-0" />
              PalSchema {status?.version ? `v${status.version} ` : ''}— active
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
              <ShieldAlertIcon className="size-4 shrink-0" />
              PalSchema {status?.version ? `v${status.version} ` : ''}installed — not loading:{' '}
              {!ue4ssEnabled
                ? 'UE4SS is disabled'
                : pendingRestart && buildStaged
                  ? 'the PalSchema build is staged — restart the server to load it'
                  : !buildStaged
                    ? 'the loaded UE4SS build is not the PalSchema build'
                    : 'UE4SS did not load on this boot'}
              . Fix it in the UE4SS Loader above.
            </div>
          )}
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            PalSchema and UE4SS are a version-locked pair — always update them together. A mismatch
            is the most common breakage.
          </p>

          {/* Sub-mods — dimmed while UE4SS is off, since PalSchema (and thus its
              mods) can't load until the loader is re-enabled. */}
          <div className={`flex flex-col gap-2${!ue4ssEnabled ? ' opacity-50' : ''}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">PalSchema mods ({submods.length})</span>
            </div>
            <p className="text-xs text-muted-foreground">
              These are PalSchema data-table mods — JSON patches that tweak Palworld&apos;s data (Pals,
              items, drops, appearance…) without repacking game assets. They&apos;re a separate layer from
              the .pak and UE4SS mods in the list below, so one mod can appear in both places (a .pak for
              its assets plus a PalSchema patch for the data). Presence here means active — there&apos;s no
              per-mod toggle; remove one to disable it.
            </p>
            {submods.length === 0 ? (
              <p className="text-xs text-muted-foreground">No PalSchema mods installed yet.</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-md border">
                {submods.map((m) => (
                  <li key={m.name} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      {/* A "PalSchema" badge (parallel to the main list's pak/UE4SS
                          badges) so a mod that ships BOTH a .pak and a PalSchema
                          data-table (e.g. William_MoreHairs_P) isn't mistaken here
                          for its .pak — this row is the JSON data-table component. */}
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="gap-1 border-sky-500/50 text-sky-600 dark:text-sky-400">
                          <LayersIcon className="size-3" /> PalSchema
                        </Badge>
                        <span className="truncate text-sm font-medium">{m.name}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {m.fileCount} file{m.fileCount === 1 ? '' : 's'} · {formatBytes(m.sizeBytes)} ·{' '}
                        {formatDate(m.modifiedAt)}
                      </div>
                    </div>
                    <button
                      onClick={() => setRemoveTarget(m.name)}
                      disabled={!!busy}
                      title="Remove (backed up first)"
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30"
                    >
                      {busy === `rm:${m.name}` ? <Spinner className="size-4" /> : <Trash2Icon className="size-4" />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {/* Installing PalSchema mods is handled by the shared "Install a Mod"
                section below (its PalSchema tab); this section only lists/removes. */}
          </div>
        </div>
      )}

      <AlertDialog open={removeTarget !== null} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget}?</AlertDialogTitle>
            <AlertDialogDescription>
              The mod folder is backed up to the backups area first (palschema-{removeTarget}-…tar.gz),
              so you can restore it by hand. Takes effect on next server restart.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRemove}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
