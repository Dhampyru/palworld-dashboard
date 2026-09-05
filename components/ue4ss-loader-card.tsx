'use client'

// UE4SS Loader card — hoisted ABOVE the Mods tabs (mods redesign). Self-contained: it owns
// its own UE4SS status + install/swap/rollback state and fetches on mount, so it can live
// outside GameModsPanel. Mirrors the loader that used to sit inside that panel (spec
// docs/specs/ue4ss-loader.md); the risky official/beta build swaps use a native confirm
// (the panel used an AlertDialog), and installing PalSchema after a palschema-build swap is
// offered inline. `onChanged` bumps the parent so the Server-tab lists refresh.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { CpuIcon, UploadIcon } from 'lucide-react'
import type { ModRegime, Ue4ssSource } from '@/lib/game-mods'

type Ue4ssStatus = {
  installed: boolean
  enabled: boolean
  running: boolean
  regime?: ModRegime
  injection?: 'dwmapi' | 'official'
  stagedSource: Ue4ssSource | null
  stagedVersion: string | null
  loaded: boolean
  source: Ue4ssSource | null
  version: string | null
  sha: string | null
  buildConfig: string | null
  pendingRestart: boolean
}

const SOURCE_LABEL: Record<Ue4ssSource, string> = {
  'experimental-palworld': 'PalSchema build',
  official: 'Official (Stable)',
  beta: 'Official (Experimental)',
  unknown: 'Custom / uploaded',
}

export function Ue4ssLoaderCard({ onChanged }: { onChanged?: () => void }) {
  const { config, connectionStatus } = useServer()
  const [ue4ss, setUe4ss] = useState<Ue4ssStatus | null>(null)
  const [toggling, setToggling] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [backups, setBackups] = useState<{ file: string; sizeBytes: number; modifiedAt: string | null; sha: string | null; version: string | null }[]>([])
  const [rollbackTarget, setRollbackTarget] = useState('')
  const [offerPalSchema, setOfferPalSchema] = useState(false)
  const swapFileRef = useRef<HTMLInputElement>(null)

  const loadUe4ss = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/game-mods/ue4ss', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setUe4ss(json.status as Ue4ssStatus)
    } catch {
      /* leave null */
    }
  }, [config])

  const loadBackups = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/game-mods/ue4ss/install', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setBackups(json.backups ?? [])
    } catch {
      /* ignore */
    }
  }, [config])

  useEffect(() => {
    void loadUe4ss()
    void loadBackups()
  }, [loadUe4ss, loadBackups])

  // Re-fetch when the server (re)connects — e.g. after a restart that loads a swapped/updated UE4SS
  // build. Without this the card kept showing the pre-restart (pending) state until a manual page
  // refresh, because it otherwise only polls on mount and after its own actions.
  useEffect(() => {
    if (connectionStatus === 'connected') void loadUe4ss()
  }, [connectionStatus, loadUe4ss])

  const toggle = useCallback(
    async (enabled: boolean) => {
      if (!config) return
      setToggling(true)
      const toastId = toast.loading(enabled ? 'Enabling UE4SS…' : 'Disabling UE4SS…')
      try {
        const res = await fetch('/api/game-mods/ue4ss', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        setUe4ss(json.status as Ue4ssStatus)
        toast.success((json.note as string) ?? 'Done', { id: toastId })
        onChanged?.()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Failed', { id: toastId })
      } finally {
        setToggling(false)
      }
    },
    [config, onChanged],
  )

  const runAction = useCallback(
    async (key: string, init: RequestInit): Promise<boolean> => {
      if (!config) return false
      setBusy(key)
      const toastId = toast.loading('Working… (this can take a moment)')
      try {
        const res = await fetch('/api/game-mods/ue4ss/install', { ...init, headers: { ...buildPalworldProxyHeaders(config), ...(init.headers ?? {}) } })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        if (json.status) setUe4ss(json.status as Ue4ssStatus)
        toast.success((json.note as string) ?? 'Done', { id: toastId })
        await loadBackups()
        onChanged?.()
        return true
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Failed', { id: toastId })
        return false
      } finally {
        setBusy(null)
      }
    },
    [config, loadBackups, onChanged],
  )

  const downloadUe4ss = useCallback(
    async (source: 'official' | 'beta' | 'palschema') => {
      // Official/beta builds lack Palworld's MemberVariableLayout.ini and often fail to
      // inject on this game — confirm before swapping to one (the panel used a dialog).
      if (source !== 'palschema') {
        const label = source === 'official' ? 'UE4SS (Stable)' : 'UE4SS (Experimental)'
        if (!window.confirm(`Swap to ${label}? It runs classic Lua/Blueprint mods but does NOT support PalSchema, and on this game may fail to inject. The current UE4SS is backed up first. Server must be stopped; takes effect on restart.`)) return
      }
      const ok = await runAction(`dl:${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'download', source }),
      })
      if (ok && source === 'palschema' && config) {
        try {
          const res = await fetch('/api/game-mods/palschema', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
          const json = await res.json()
          if (res.ok && !json.status?.installed) setOfferPalSchema(true)
        } catch {
          /* best-effort */
        }
      }
    },
    [runAction, config],
  )

  const installPalSchemaNow = useCallback(async () => {
    setOfferPalSchema(false)
    if (!config) return
    const toastId = toast.loading('Downloading & installing PalSchema…')
    try {
      const res = await fetch('/api/game-mods/palschema', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'downloadLoader' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      toast.success((json.note as string) ?? 'PalSchema installed', { id: toastId })
      onChanged?.()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed', { id: toastId })
    }
  }, [config, onChanged])

  const uploadUe4ss = useCallback(async () => {
    const f = swapFileRef.current?.files?.[0]
    if (!f) {
      toast.error('Choose a UE4SS build zip first')
      return
    }
    const body = new FormData()
    body.set('file', f)
    await runAction('upload', { method: 'POST', body })
    if (swapFileRef.current) swapFileRef.current.value = ''
  }, [runAction])

  const doRollback = useCallback(
    (file: string) => runAction('rb', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rollback', backupFile: file }) }),
    [runAction],
  )

  // Which named build is staged, for the "active" badge on the buttons.
  const activeSource = useMemo<'official' | 'beta' | 'palschema' | null>(() => {
    switch (ue4ss?.stagedSource) {
      case 'experimental-palworld':
        return 'palschema'
      case 'official':
        return 'official'
      case 'beta':
        return 'beta'
      default:
        return null
    }
  }, [ue4ss?.stagedSource])
  const activeBadge = <Badge variant="secondary" className="ml-1 text-[10px]">active</Badge>
  const recommendedBadge = <Badge className="ml-1 text-[10px]">recommended</Badge>

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <CpuIcon className="size-4" /> UE4SS Loader
        </h3>
        {ue4ss?.installed && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {ue4ss.enabled ? 'Enabled' : 'Disabled'}
            <Switch checked={ue4ss.enabled} disabled={toggling} onCheckedChange={(v) => toggle(v)} aria-label="Enable UE4SS" />
          </div>
        )}
      </div>

      {!ue4ss ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : !ue4ss.installed ? (
        <p className="text-xs text-muted-foreground">UE4SS is not installed.</p>
      ) : !ue4ss.enabled ? (
        <p className="text-xs text-muted-foreground">
          UE4SS is <span className="font-medium">disabled</span>{' '}
          {ue4ss.regime === 'workshop' ? '(bGlobalEnableMod is off in PalModSettings).' : '(the dwmapi proxy is renamed aside).'} Enable it and restart the server to load mods.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Installed:</span>
            {ue4ss.regime === 'workshop' ? (
              <Badge variant="outline" className="border-sky-500/50 text-sky-500">Workshop layout</Badge>
            ) : (
              <Badge variant="outline" className={ue4ss.stagedSource === 'experimental-palworld' ? 'border-amber-500/50 text-amber-500' : 'text-muted-foreground'}>
                {ue4ss.stagedSource ? SOURCE_LABEL[ue4ss.stagedSource] : 'unknown'}
              </Badge>
            )}
            {/* Lead with the Git SHA — that's the part that actually changes between builds. UE4SS
                reports the same "v3.0.1 Beta #0" string for every experimental-palworld build, so it
                looks frozen; the SHA is the real identity. Staged build's SHA is unknown until it loads. */}
            {ue4ss.stagedVersion && (
              <span className="font-mono text-muted-foreground">
                {ue4ss.sha && !ue4ss.pendingRestart ? `#${ue4ss.sha} · ` : ''}UE4SS {ue4ss.stagedVersion}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
            <span>Regime:</span>
            <span className="font-medium text-foreground">
              {ue4ss.regime === 'workshop' ? 'Workshop layout — official loader (Mods/NativeMods)' : 'Community proxy — dwmapi (Win64/ue4ss)'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {!ue4ss.running ? (
              <span className="text-muted-foreground">Server stopped — the installed build loads on next start.</span>
            ) : ue4ss.loaded && !ue4ss.pendingRestart ? (
              <span className="text-emerald-600 dark:text-emerald-400">✓ Running {ue4ss.version}{ue4ss.sha ? ` #${ue4ss.sha}` : ''}{ue4ss.buildConfig ? ` · ${ue4ss.buildConfig}` : ''}</span>
            ) : ue4ss.loaded && ue4ss.pendingRestart ? (
              <span className="text-amber-600 dark:text-amber-400">⚠ Pending restart — running {ue4ss.version}{ue4ss.sha ? ` #${ue4ss.sha}` : ''}; restart to load the installed build.</span>
            ) : (
              <span className="text-destructive">⚠ UE4SS did not load on this boot — the installed build failed to inject, or a restart is still pending.</span>
            )}
          </div>
        </div>
      )}

      {ue4ss?.installed && (
        <div className="flex flex-col gap-2 border-t pt-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={!!busy} onClick={() => downloadUe4ss('official')} title="RE-UE4SS stable — classic Lua/Blueprint mods; no PalSchema">
              {busy === 'dl:official' && <Spinner className="size-3.5" />} UE4SS (Stable){activeSource === 'official' && activeBadge}
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={!!busy} onClick={() => downloadUe4ss('beta')} title="RE-UE4SS experimental pre-release — classic mods, not PalSchema">
              {busy === 'dl:beta' && <Spinner className="size-3.5" />} UE4SS (Experimental){activeSource === 'beta' && activeBadge}
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5 border-amber-500/50 bg-amber-500/15 text-xs text-amber-700 hover:bg-amber-500/25 dark:text-amber-400" disabled={!!busy} onClick={() => downloadUe4ss('palschema')} title="Okaetsu experimental-palworld — includes MemberVariableLayout.ini; required for PalSchema">
              {busy === 'dl:palschema' && <Spinner className="size-3.5" />} UE4SS (PalSchema){activeSource === 'palschema' ? activeBadge : recommendedBadge}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            All three report the same UE4SS version string (<span className="font-mono">{ue4ss.version ?? 'v3.0.1 Beta #0'}</span>) — it does <b>not</b> change between builds, so the <span className="font-mono">#SHA</span> / branch above is the real identity of what&apos;s installed. All run classic UE4SS Lua/Blueprint mods; only <span className="text-amber-600 dark:text-amber-400">UE4SS (PalSchema)</span> supports PalSchema.
          </p>

          {offerPalSchema && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
              <span className="text-amber-700 dark:text-amber-400">PalSchema build installed — install the PalSchema mod itself now?</span>
              <Button size="sm" className="h-7 text-xs" onClick={installPalSchemaNow}>Install PalSchema</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOfferPalSchema(false)}>Later</Button>
            </div>
          )}

          <details className="rounded-md border border-border/60 bg-muted/20 p-2">
            <summary className="cursor-pointer text-[11px] text-muted-foreground">Manual upload — supply your own UE4SS build zip</summary>
            <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">You vet this build. It replaces the loader and can break joins — the current UE4SS is backed up first, and rollback is below.</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <input ref={swapFileRef} type="file" accept=".zip" className="text-xs file:mr-2 file:rounded file:border file:bg-muted file:px-2 file:py-0.5 file:text-xs" />
              <Button size="sm" className="h-8 gap-1.5 text-xs" disabled={!!busy} onClick={uploadUe4ss}>
                {busy === 'upload' ? <Spinner className="size-3.5" /> : <UploadIcon className="size-3.5" />} Install upload
              </Button>
            </div>
          </details>

          {backups.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Rollback to:</span>
              <select value={rollbackTarget || backups[0].file} onChange={(e) => setRollbackTarget(e.target.value)} className="max-w-[20rem] truncate rounded-md border bg-background px-2 py-1 text-xs">
                {backups.map((b) => {
                  const when = b.modifiedAt ? new Date(b.modifiedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
                  const build = b.sha ? `#${b.sha}` : 'build unknown'
                  return (
                    <option key={b.file} value={b.file}>{build}{when ? ` · ${when}` : ''}</option>
                  )
                })}
              </select>
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={!!busy} onClick={() => doRollback(rollbackTarget || backups[0].file)}>
                {busy === 'rb' && <Spinner className="size-3.5" />} Rollback
              </Button>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">All version actions require the server <span className="font-medium">stopped</span> and take effect on the next restart.</p>
        </div>
      )}
    </div>
  )
}
