'use client'

// PATCH (not upstream): UE4SS + PalSchema update checks with update-and-rollback
// (docs/specs/framework-updates.md). PalSchema is a clean semver check (hard "update
// available"); UE4SS tracks a rolling tag so it's shown informationally (latest release +
// link) without a false badge. Every action takes a backup; rollbacks are listed. Admin-only.

import { useCallback, useEffect, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { RefreshCwIcon, ArrowUpCircleIcon, RotateCcwIcon, ExternalLinkIcon, PackageIcon } from 'lucide-react'

type Backup = { file: string; sizeBytes: number; modifiedAt: string | null; sha?: string | null; version?: string | null }
type Data = {
  updates: {
    ue4ss: {
      installed: { version: string | null; sha: string | null; source: string | null }
      latest: { tag: string | null; publishedAt: string | null; url: string | null; basedOn: string | null }
      workshop: {
        itemId: string
        baselineAt: number | null
        latestAt: number | null
        updateAvailable: boolean
      } | null
      updateAvailable: boolean | null
      note: string
    }
    palschema: {
      installed: string | null
      installedFlag: boolean
      latest: string | null
      publishedAt: string | null
      url: string | null
      updateAvailable: boolean
    }
    checkedAt: string
  }
  palschemaBackups: Backup[]
  ue4ssBackups: Backup[]
}

const fmtDate = (s: string | null) => (s ? new Date(s).toLocaleDateString() : '—')

export function FrameworkUpdatesCard() {
  const { config, connectionStatus, refreshModUpdates } = useServer()
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [psRollback, setPsRollback] = useState('')
  const [ueRollback, setUeRollback] = useState('')

  const load = useCallback(
    async (refresh = false) => {
      if (!config) return
      setLoading(true)
      try {
        const res = await fetch(`/api/framework-updates${refresh ? '?refresh=1' : ''}`, {
          headers: buildPalworldProxyHeaders(config),
          cache: 'no-store',
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? res.statusText)
        setData(j)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to check framework updates')
      } finally {
        setLoading(false)
      }
    },
    [config],
  )
  useEffect(() => {
    void load()
  }, [load])

  // Re-check (fresh, bypassing the server-side TTL) when the server reconnects after a restart —
  // e.g. a UE4SS swap loads on the next boot — so the framework details aren't stale until refresh.
  useEffect(() => {
    if (connectionStatus === 'connected') void load(true)
  }, [connectionStatus, load])

  const post = useCallback(
    async (url: string, body: unknown, label: string) => {
      if (!config) return
      setBusy(label)
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = await res.json()
        if (!res.ok) throw new Error(j.error ?? res.statusText)
        toast.success(j.note ?? 'Done — restart the server to apply.')
        await load(true)
        refreshModUpdates()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Action failed')
      } finally {
        setBusy(null)
      }
    },
    [config, load, refreshModUpdates],
  )

  const ue4ssSource = (src: string | null) => (src === 'experimental-palworld' ? 'palschema' : src === 'beta' ? 'beta' : 'official')

  const u = data?.updates
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <PackageIcon className="size-3.5" /> Framework Updates
        </h3>
        <div className="flex items-center gap-2">
          {u && <span className="text-[11px] text-muted-foreground">checked {fmtDate(u.checkedAt)}</span>}
          <Button size="sm" variant="ghost" onClick={() => load(true)} disabled={loading} className="gap-1.5" aria-label="Re-check">
            {loading ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
          </Button>
        </div>
      </div>

      {!u ? (
        <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
          {loading ? <><Spinner className="size-4" /> Checking GitHub…</> : 'No data.'}
        </div>
      ) : (
        <>
          {/* PalSchema — clean semver */}
          <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">PalSchema</span>
              {u.palschema.updateAvailable ? (
                <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">update available</Badge>
              ) : u.palschema.installedFlag ? (
                <Badge variant="outline" className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400">up to date</Badge>
              ) : (
                <Badge variant="outline">not installed</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              installed <span className="font-mono text-foreground">{u.palschema.installed ?? '—'}</span>
              {' · '}latest{' '}
              {u.palschema.url ? (
                <a href={u.palschema.url} target="_blank" rel="noreferrer" className="font-mono text-foreground underline decoration-dotted">
                  {u.palschema.latest ?? '—'}
                </a>
              ) : (
                <span className="font-mono text-foreground">{u.palschema.latest ?? '—'}</span>
              )}
              {u.palschema.publishedAt ? ` (${fmtDate(u.palschema.publishedAt)})` : ''}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {u.palschema.updateAvailable && u.palschema.latest && (
                <Button
                  size="sm"
                  onClick={() => post('/api/framework-updates', { action: 'palschemaUpdate', tag: u.palschema.latest }, 'ps-update')}
                  disabled={!!busy}
                  className="h-7 gap-1.5 px-2.5"
                >
                  {busy === 'ps-update' ? <Spinner className="size-3.5" /> : <ArrowUpCircleIcon className="size-3.5" />}
                  Update to {u.palschema.latest} (backup taken)
                </Button>
              )}
              {(data?.palschemaBackups.length ?? 0) > 0 && (
                <div className="flex items-center gap-1.5">
                  <select
                    value={psRollback}
                    onChange={(e) => setPsRollback(e.target.value)}
                    className="h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground [&>option]:bg-background [&>option]:text-foreground"
                    aria-label="PalSchema backup to restore"
                  >
                    <option value="">Rollback to…</option>
                    {data!.palschemaBackups.map((b) => (
                      <option key={b.file} value={b.file}>{b.file.replace(/^palschema-loader-/, '').replace(/\.tar\.gz$/, '')}</option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!psRollback || !!busy}
                    onClick={() => post('/api/framework-updates', { action: 'palschemaRollback', file: psRollback }, 'ps-roll')}
                    className="h-7 gap-1.5 px-2"
                  >
                    {busy === 'ps-roll' ? <Spinner className="size-3.5" /> : <RotateCcwIcon className="size-3.5" />}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* UE4SS — reliable Workshop-time check (experimental-palworld); rolling tag otherwise */}
          <div className="flex flex-col gap-2 rounded-md border bg-muted/20 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">UE4SS</span>
              {u.ue4ss.workshop?.updateAvailable ? (
                <Badge className="border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-400">update available</Badge>
              ) : u.ue4ss.workshop ? (
                <Badge variant="outline" className="text-emerald-600 dark:text-emerald-400">up to date</Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">rolling tag</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {/* Lead with the branch/line + commit — the meaningful identity. The engine version
                  (v3.0.1 Beta #0) is identical across builds, so it's a trailing detail. */}
              installed{' '}
              <span className="font-mono text-foreground">
                {u.ue4ss.installed.source && u.ue4ss.installed.source !== 'unknown'
                  ? u.ue4ss.installed.source
                  : (u.ue4ss.installed.version ?? '—')}
              </span>
              {u.ue4ss.installed.sha ? <span className="font-mono text-foreground"> · {u.ue4ss.installed.sha}</span> : ''}
              {u.ue4ss.installed.source && u.ue4ss.installed.source !== 'unknown' && u.ue4ss.installed.version ? (
                <span> (UE4SS {u.ue4ss.installed.version})</span>
              ) : (
                ''
              )}
              {u.ue4ss.latest.basedOn ? <span> · based on Palworld {u.ue4ss.latest.basedOn}</span> : ''}
              {' · '}latest{' '}
              {u.ue4ss.latest.url ? (
                <a href={u.ue4ss.latest.url} target="_blank" rel="noreferrer" className="font-mono text-foreground underline decoration-dotted">
                  {u.ue4ss.latest.tag ?? '—'} <ExternalLinkIcon className="inline size-3" />
                </a>
              ) : (
                <span className="font-mono text-foreground">{u.ue4ss.latest.tag ?? '—'}</span>
              )}
              {u.ue4ss.latest.publishedAt ? ` (${fmtDate(u.ue4ss.latest.publishedAt)})` : ''}
            </div>
            <p className={u.ue4ss.workshop?.updateAvailable ? 'text-[11px] font-medium text-amber-600 dark:text-amber-400' : 'text-[11px] text-muted-foreground'}>
              {u.ue4ss.note}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => post('/api/game-mods/ue4ss/install', { action: 'download', source: ue4ssSource(u.ue4ss.installed.source) }, 'ue-update')}
                disabled={!!busy}
                title="Downloads + installs the latest build for the installed line, backs up the current one, and clears the update flag. The server must be stopped first."
                className={
                  u.ue4ss.workshop?.updateAvailable
                    ? 'h-7 gap-1.5 px-2.5 border-amber-500/50 bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300'
                    : 'h-7 gap-1.5 px-2.5'
                }
              >
                {busy === 'ue-update' ? <Spinner className="size-3.5" /> : <ArrowUpCircleIcon className="size-3.5" />}
                {u.ue4ss.workshop?.updateAvailable ? 'Update to latest (backup taken)' : 'Reinstall latest (backup taken)'}
              </Button>
              {(data?.ue4ssBackups.length ?? 0) > 0 && (
                <div className="flex items-center gap-1.5">
                  <select
                    value={ueRollback}
                    onChange={(e) => setUeRollback(e.target.value)}
                    className="h-7 rounded-md border border-input bg-background px-1.5 text-xs text-foreground [&>option]:bg-background [&>option]:text-foreground"
                    aria-label="UE4SS backup to restore"
                  >
                    <option value="">Rollback to…</option>
                    {data!.ue4ssBackups.map((b) => {
                      const when = b.modifiedAt ? new Date(b.modifiedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
                      const build = b.sha ? `#${b.sha}` : 'build unknown'
                      return (
                        <option key={b.file} value={b.file}>{build}{when ? ` · ${when}` : ''}</option>
                      )
                    })}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!ueRollback || !!busy}
                    onClick={() => post('/api/game-mods/ue4ss/install', { action: 'rollback', backupFile: ueRollback }, 'ue-roll')}
                    className="h-7 gap-1.5 px-2"
                  >
                    {busy === 'ue-roll' ? <Spinner className="size-3.5" /> : <RotateCcwIcon className="size-3.5" />}
                  </Button>
                </div>
              )}
              {u.ue4ss.workshop && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => post('/api/framework-updates', { action: 'markUe4ssInstalled' }, 'ue-ack')}
                  disabled={!!busy}
                  className="h-7 gap-1.5 px-2.5 text-muted-foreground"
                  title="Re-baseline the update check to the current build — use after you've updated UE4SS (or to dismiss)"
                >
                  {busy === 'ue-ack' ? <Spinner className="size-3.5" /> : null}
                  Mark up to date
                </Button>
              )}
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Framework changes take effect on the next server restart. Both frameworks are fragile — an update is a
            deliberate action, and every update takes a backup you can roll back to here.
          </p>
        </>
      )}
    </div>
  )
}
