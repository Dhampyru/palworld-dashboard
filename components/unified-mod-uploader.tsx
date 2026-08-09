'use client'

// Unified mod uploader (docs/specs/client-mod-sync.md — mods redesign). ONE place to add a
// mod, whether it's a file, a Nexus URL, or a Steam Workshop URL. It SCANS first (parses
// the archive contents, or mines the Nexus page description) to decide where the mod
// belongs — server, client loadout, or both — shows that with the reasoning, lets the admin
// override, and only then installs. Sits ABOVE the Server/Client tabs; those are now just
// lists. Server/file commit goes through /api/game-mods/{scan,commit}; Nexus/Steam reuse
// the existing install + client-staging endpoints.
import { useEffect, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { UploadIcon, LinkIcon, ServerIcon, MonitorIcon, LayersIcon, ScanSearchIcon, XIcon, ListPlusIcon } from 'lucide-react'
import type { ModAnalysis, ModTarget } from '@/lib/mod-targeting'

type Mode = 'file' | 'nexus' | 'steam' | 'bulk'
type BulkRow = { scope: 'server' | 'client'; label: string; ok: boolean; note: string }

// Conservative cap on Steam URLs per bulk — each is a separate SteamCMD pull, and Steam
// rate-limits anonymous Workshop downloads (no hard figure known; 10 is a safe default).
const STEAM_BULK_MAX = 10
type NexusFileOption = { fileId: number; name: string; version: string | null; category: string | null }
type ScanResult = {
  source: 'upload' | 'nexus' | 'steam'
  token?: string
  url?: string
  modId?: number
  fileId?: number | null
  files?: NexusFileOption[] // Nexus: selectable versions for the picker
  itemId?: string // Steam workshop id (for reject-purge of its cache)
  modName: string
  analysis: ModAnalysis
}

const jsonHeaders = (config: Parameters<typeof buildPalworldProxyHeaders>[0]) => ({
  ...buildPalworldProxyHeaders(config),
  'Content-Type': 'application/json',
})

const TARGETS: { value: ModTarget; label: string; icon: React.ReactNode; hint: string }[] = [
  { value: 'server', label: 'Server', icon: <ServerIcon className="size-4" />, hint: 'Install on the live server only' },
  { value: 'client', label: 'Client', icon: <MonitorIcon className="size-4" />, hint: 'Stage into the friend loadout only' },
  { value: 'both', label: 'Both', icon: <LayersIcon className="size-4" />, hint: 'Server + client loadout' },
]

function SignalChips({ a }: { a: ModAnalysis }) {
  const chips: string[] = []
  if (a.kind) chips.push(a.kind === 'ue4ss' ? 'UE4SS/Lua' : a.kind === 'pak' ? 'Pak' : 'PalSchema')
  if (a.signals.hasPalSchemaData && a.kind !== 'palschema') chips.push('+PalSchema')
  if (a.signals.hasPak && a.kind !== 'pak') chips.push('+pak')
  if (a.signals.hasLogicMods) chips.push('LogicMods')
  if (a.signals.hasConfigMenu) chips.push('Config menu')
  if (a.signals.isFomod) chips.push('FOMOD')
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => (
        <Badge key={c} variant="secondary" className="text-[10px]">{c}</Badge>
      ))}
    </div>
  )
}

export function UnifiedModUploader({ onInstalled }: { onInstalled?: () => void }) {
  const { config } = useServer()
  const [mode, setMode] = useState<Mode>('file')
  const [urlInput, setUrlInput] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [scanning, setScanning] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [target, setTarget] = useState<ModTarget>('both')
  const [modName, setModName] = useState('')
  // Bulk mode — 'auto' scans + routes each URL like the single flow; server/client/both
  // force the whole batch to one destination.
  const [bulkText, setBulkText] = useState('')
  const [bulkTarget, setBulkTarget] = useState<'auto' | ModTarget>('auto')
  const [bulkOverrideOpen, setBulkOverrideOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkRows, setBulkRows] = useState<BulkRow[] | null>(null)
  // Account status → warnings + gating (Nexus Premium enables server auto-download; Steam
  // needs a connected account).
  const [nx, setNx] = useState<{ connected: boolean; premium: boolean } | null>(null)
  const [stm, setStm] = useState<{ connected: boolean; username: string | null } | null>(null)
  useEffect(() => {
    if (!config) return
    const h = buildPalworldProxyHeaders(config)
    fetch('/api/nexus/mods', { headers: h, cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setNx({ connected: !!j.connected, premium: !!j.isPremium }))
      .catch(() => {})
    fetch('/api/steam', { headers: h, cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => setStm({ connected: !!j.status?.connected, username: j.status?.username ?? null }))
      .catch(() => {})
  }, [config])

  const applyScan = (r: ScanResult) => {
    setScan(r)
    setTarget(r.analysis.target)
    setModName(r.modName)
  }
  const reset = () => {
    // Reject cleanup: drop a file/Nexus stash, or purge a scanned-but-unused Steam download.
    // (Safe post-install too — the purge skips anything now recorded as installed.)
    if (scan && config) {
      const body = scan.source === 'steam' && scan.itemId ? { steamItemId: scan.itemId } : scan.token ? { token: scan.token } : null
      if (body) {
        fetch('/api/game-mods/scan', { method: 'DELETE', headers: jsonHeaders(config), body: JSON.stringify(body) }).catch(() => {})
      }
    }
    setScan(null)
    setUrlInput('')
    setModName('')
    if (fileRef.current) fileRef.current.value = ''
  }

  async function scanFile(file: File) {
    if (!config) return
    setScanning(true)
    try {
      const body = new FormData()
      body.set('file', file)
      const res = await fetch('/api/game-mods/scan', { method: 'POST', headers: buildPalworldProxyHeaders(config), body })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Scan failed')
      applyScan(data as ScanResult)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Scan failed')
    } finally {
      setScanning(false)
    }
  }

  async function scanUrl() {
    if (!config || !urlInput.trim()) return
    setScanning(true)
    try {
      const res = await fetch('/api/game-mods/scan', { method: 'POST', headers: jsonHeaders(config), body: JSON.stringify({ url: urlInput.trim() }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Scan failed')
      applyScan(data as ScanResult)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Scan failed')
    } finally {
      setScanning(false)
    }
  }

  // Re-scan a Nexus mod at a specific file/version (the version picker) — re-analyzes the
  // chosen file so the target preview reflects that exact version, and threads its fileId
  // into the install.
  async function rescanVersion(fileId: number) {
    if (!config || !scan?.url || fileId === scan.fileId) return
    setScanning(true)
    try {
      const res = await fetch('/api/game-mods/scan', {
        method: 'POST',
        headers: jsonHeaders(config),
        body: JSON.stringify({ url: scan.url, fileId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Scan failed')
      applyScan(data as ScanResult)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Scan failed')
    } finally {
      setScanning(false)
    }
  }

  async function confirmInstall() {
    if (!config || !scan) return
    const wantServer = target === 'server' || target === 'both'
    const wantClient = target === 'client' || target === 'both'
    setInstalling(true)
    const toastId = toast.loading('Installing…')
    try {
      if (scan.source === 'upload') {
        const res = await fetch('/api/game-mods/commit', {
          method: 'POST',
          headers: jsonHeaders(config),
          body: JSON.stringify({ token: scan.token, server: wantServer, client: wantClient, modName: modName.trim() }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Install failed')
        const parts: string[] = []
        if (data.server) parts.push(data.server.ok ? 'server ✓' : `server ✗ (${data.server.error})`)
        if (data.client) parts.push(data.client.ok ? 'client ✓' : `client ✗ (${data.client.error})`)
        if (data.ok) toast.success(`Installed — ${parts.join(', ')}`, { id: toastId })
        else toast.warning(`Partly done — ${parts.join(', ')}`, { id: toastId })
      } else {
        await commitUrl(scan, wantServer, wantClient, toastId)
      }
      reset()
      onInstalled?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Install failed', { id: toastId })
    } finally {
      setInstalling(false)
    }
  }

  // Nexus/Steam: reuse the existing server-install + client-staging endpoints.
  async function commitUrl(s: ScanResult, wantServer: boolean, wantClient: boolean, toastId: string | number) {
    if (!config) return
    const oks: string[] = []
    const errs: string[] = []
    if (wantServer) {
      try {
        if (s.source === 'nexus') {
          if (!s.fileId) throw new Error('no downloadable Nexus file (Premium key required)')
          const r = await fetch('/api/nexus/install', { method: 'POST', headers: jsonHeaders(config), body: JSON.stringify({ modId: s.modId, fileId: s.fileId }) })
          const j = await r.json()
          if (!r.ok) throw new Error(j.error ?? 'failed')
        } else {
          const r = await fetch('/api/steam/workshop', { method: 'POST', headers: jsonHeaders(config), body: JSON.stringify({ url: s.url }) })
          const j = await r.json()
          if (!r.ok) throw new Error(j.error ?? 'failed')
        }
        oks.push('server')
      } catch (e) {
        errs.push(`server: ${e instanceof Error ? e.message : 'failed'}`)
      }
    }
    if (wantClient) {
      try {
        const action = s.source === 'nexus' ? 'addNexus' : 'addSteam'
        const r = await fetch('/api/client-mods', { method: 'POST', headers: jsonHeaders(config), body: JSON.stringify({ action, url: s.url }) })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error ?? 'failed')
        oks.push('client')
      } catch (e) {
        errs.push(`client: ${e instanceof Error ? e.message : 'failed'}`)
      }
    }
    if (errs.length && !oks.length) throw new Error(errs.join('; '))
    if (errs.length) toast.warning(`Partly done — installed ${oks.join(' + ')}; ${errs.join('; ')}`, { id: toastId })
    else toast.success(`Installed (${oks.join(' + ')})`, { id: toastId })
  }

  // Bulk: paste many Nexus/Steam URLs, install all to the chosen target(s) via the existing
  // bulk endpoints (Nexus + Steam split for the server; one mixed endpoint for the client).
  async function runBulk() {
    if (!config || !bulkText.trim()) return
    const lines = bulkText.split('\n').map((s) => s.trim()).filter(Boolean)
    const isNexus = (u: string) => /nexusmods\.com/i.test(u)
    const isSteam = (u: string) => /steamcommunity\.com/i.test(u)
    const nexus = lines.filter(isNexus)
    const steamAll = lines.filter(isSteam)
    const steam = steamAll.slice(0, STEAM_BULK_MAX) // rate-limit guard (each is a SteamCMD pull)
    const steamSkipped = steamAll.slice(STEAM_BULK_MAX)
    const unknown = lines.filter((u) => !isNexus(u) && !isSteam(u))
    setBulkBusy(true)
    setBulkRows(null)
    const toastId = toast.loading(bulkTarget === 'auto' ? 'Scanning…' : 'Bulk installing…')
    const rows: BulkRow[] = []
    try {
      // 1. Resolve a target per URL. Auto = scan each Nexus page (same description-mining as
      //    the single flow); Steam falls back to Both (its contents need a download to
      //    inspect). A manual selection forces every URL to that one destination.
      const plan: { url: string; src: 'nexus' | 'steam'; target: ModTarget }[] = []
      if (bulkTarget === 'auto') {
        const all: { u: string; src: 'nexus' | 'steam' }[] = [
          ...nexus.map((u) => ({ u, src: 'nexus' as const })),
          ...steam.map((u) => ({ u, src: 'steam' as const })),
        ]
        let i = 0
        for (const { u, src } of all) {
          i += 1
          toast.loading(`Scanning ${i}/${all.length}…`, { id: toastId })
          let t: ModTarget = 'both'
          try {
            const r = await fetch('/api/game-mods/scan', { method: 'POST', headers: jsonHeaders(config), body: JSON.stringify({ url: u }) })
            const j = await r.json()
            if (r.ok && (j.analysis?.target as ModTarget)) t = j.analysis.target
          } catch {
            /* fall back to both */
          }
          plan.push({ url: u, src, target: t })
        }
        toast.loading('Installing…', { id: toastId })
      } else {
        for (const u of nexus) plan.push({ url: u, src: 'nexus', target: bulkTarget })
        for (const u of steam) plan.push({ url: u, src: 'steam', target: bulkTarget })
      }

      // 2. Group by destination (a "both" mod lands in both the server and client buckets).
      const serverNexus = plan.filter((p) => p.src === 'nexus' && p.target !== 'client').map((p) => p.url)
      const serverSteam = plan.filter((p) => p.src === 'steam' && p.target !== 'client').map((p) => p.url)
      const clientUrls = plan.filter((p) => p.target !== 'server').map((p) => p.url)

      // 3. Dispatch to the existing bulk endpoints.
      if (serverNexus.length) {
        const r = await fetch('/api/nexus/install', { method: 'POST', headers: jsonHeaders(config), body: JSON.stringify({ action: 'bulk', urls: serverNexus }) })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error ?? 'Nexus bulk failed')
        for (const x of j.results ?? []) rows.push({ scope: 'server', label: x.name ?? x.input, ok: !!x.ok, note: x.error ?? (x.kind ? `(${x.kind})` : '') })
      }
      if (serverSteam.length) {
        const r = await fetch('/api/steam/workshop', { method: 'POST', headers: jsonHeaders(config), body: JSON.stringify({ urls: serverSteam }) })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error ?? 'Steam bulk failed')
        for (const x of j.results ?? []) rows.push({ scope: 'server', label: x.name ?? x.url, ok: !!x.ok, note: x.error ?? '' })
      }
      if (clientUrls.length) {
        const r = await fetch('/api/client-mods', { method: 'POST', headers: jsonHeaders(config), body: JSON.stringify({ action: 'bulk', urls: clientUrls }) })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error ?? 'Client bulk failed')
        for (const x of j.results ?? []) rows.push({ scope: 'client', label: x.name ?? x.input, ok: !!x.ok, note: x.error ?? x.warn ?? (x.kind ? `(${x.kind})` : '') })
      }
      for (const u of unknown) rows.push({ scope: 'server', label: u, ok: false, note: 'Unrecognized — use a full Nexus or Steam URL' })
      for (const u of steamSkipped) rows.push({ scope: 'server', label: u, ok: false, note: `Skipped — Steam bulk is capped at ${STEAM_BULK_MAX} per run` })
      setBulkRows(rows)
      toast.success(`Bulk done — ${rows.filter((r) => r.ok).length}/${rows.length} ok`, { id: toastId })
      onInstalled?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk install failed', { id: toastId })
    } finally {
      setBulkBusy(false)
    }
  }

  const busy = scanning || installing
  const a = scan?.analysis

  return (
    <div className="rounded-lg border border-border/60 bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <UploadIcon className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">Add a mod</h3>
        <span className="text-xs text-muted-foreground">— scans first, then installs to server, client, or both</span>
      </div>

      {/* Source selector */}
      <div className="mb-2 inline-flex rounded-md border border-border/60 p-0.5 text-sm">
        {(['file', 'nexus', 'steam', 'bulk'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => { setMode(m); reset(); setBulkRows(null) }}
            disabled={busy || bulkBusy}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1 transition-colors ${mode === m ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {m === 'file' ? <UploadIcon className="size-3.5" /> : m === 'bulk' ? <ListPlusIcon className="size-3.5" /> : <LinkIcon className="size-3.5" />}
            {m === 'file' ? 'Upload file' : m === 'nexus' ? 'Nexus URL' : m === 'steam' ? 'Steam URL' : 'Bulk URLs'}
          </button>
        ))}
      </div>

      {/* Input row (hidden once a scan is shown) */}
      {mode !== 'bulk' && !scan && (
        <div className="flex flex-wrap items-center gap-2">
          {mode === 'file' ? (
            <input
              ref={fileRef}
              type="file"
              accept=".zip,.rar,.7z,.pak"
              disabled={!config || busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) scanFile(f) }}
              className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary"
            />
          ) : (
            <>
              <Input
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder={mode === 'nexus' ? 'https://www.nexusmods.com/palworld/mods/…' : 'https://steamcommunity.com/…/filedetails/?id=…'}
                disabled={!config || busy}
                className="max-w-md"
                onKeyDown={(e) => { if (e.key === 'Enter') scanUrl() }}
              />
              <Button size="sm" onClick={scanUrl} disabled={!config || busy || !urlInput.trim()}>
                {scanning ? <Spinner className="size-4" /> : <ScanSearchIcon className="size-4" />} Scan
              </Button>
            </>
          )}
          {scanning && mode === 'file' && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Spinner className="size-3.5" /> Scanning…</span>}
        </div>
      )}

      {/* Account status / warnings for the URL modes */}
      {mode === 'nexus' && !scan && nx && (
        <p className={`text-xs ${nx.premium ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-500'}`}>
          {nx.premium
            ? 'Nexus: Premium — server auto-install ready.'
            : nx.connected
              ? 'Nexus connected but not Premium — server auto-install needs Premium; free tier stages to the client loadout only.'
              : 'Nexus not connected — add an API key in Panel Settings.'}
        </p>
      )}
      {mode === 'steam' && !scan && stm && (
        <p className={`text-xs ${stm.connected ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-500'}`}>
          {stm.connected ? `Steam: connected${stm.username ? ` as ${stm.username}` : ''}.` : 'Steam not connected — connect an account in Panel Settings.'}
        </p>
      )}

      {/* Preview + target override + confirm */}
      {mode !== 'bulk' && scan && a && (
        <div className="mt-1 space-y-3 rounded-md border border-border/60 bg-muted/30 p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <Input value={modName} onChange={(e) => setModName(e.target.value)} className="h-7 max-w-xs text-sm font-medium" />
              <SignalChips a={a} />
            </div>
            <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={reset} disabled={installing} title="Cancel">
              <XIcon className="size-4" />
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">{a.reason}</p>
          {a.warn && <p className="text-xs text-amber-600 dark:text-amber-500">⚠ {a.warn}</p>}

          {scan.source === 'nexus' && scan.files && scan.files.length > 1 && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Version:</div>
              <select
                value={scan.fileId ?? ''}
                onChange={(e) => rescanVersion(Number(e.target.value))}
                disabled={scanning || installing}
                className="h-8 w-full max-w-xs rounded-md border border-border/60 bg-background px-2 text-sm disabled:opacity-50"
              >
                {scan.files.map((f) => (
                  <option key={f.fileId} value={f.fileId}>
                    {f.version ? `${f.version} — ` : ''}
                    {f.name}
                    {f.category && f.category.toUpperCase() !== 'MAIN' ? ` [${f.category}]` : ''}
                  </option>
                ))}
              </select>
              {scanning && <span className="ml-2 text-xs text-muted-foreground">re-scanning…</span>}
            </div>
          )}

          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">Install to:</div>
            <div className="inline-flex rounded-md border border-border/60 p-0.5">
              {TARGETS.map((t) => {
                const disabled =
                  (t.value === 'client' && !a.clientInstallable) || (t.value === 'server' && !a.serverInstallable && scan.source === 'upload')
                return (
                  <button
                    key={t.value}
                    onClick={() => setTarget(t.value)}
                    disabled={disabled || installing}
                    title={disabled ? 'Not available for this mod' : t.hint}
                    className={`inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm transition-colors disabled:opacity-40 ${target === t.value ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {t.icon} {t.label}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={confirmInstall} disabled={installing}>
              {installing ? <Spinner className="size-4" /> : null} Confirm &amp; install
            </Button>
            <span className="text-xs text-muted-foreground">{TARGETS.find((t) => t.value === target)?.hint}</span>
          </div>
        </div>
      )}

      {/* Bulk: paste many URLs, one target for the batch */}
      {mode === 'bulk' && (
        <div className="space-y-2">
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            placeholder={'Paste Nexus and/or Steam Workshop URLs — one per line…'}
            rows={4}
            disabled={!config || bulkBusy}
            className="w-full resize-y rounded-md border bg-muted/20 p-2 font-mono text-xs"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={runBulk} disabled={!config || bulkBusy || !bulkText.trim()}>
              {bulkBusy ? <Spinner className="size-4" /> : <ListPlusIcon className="size-4" />} Install all
            </Button>
            {bulkTarget === 'auto' ? (
              bulkOverrideOpen ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-xs text-muted-foreground">Force:</span>
                  <div className="inline-flex rounded-md border border-border/60 p-0.5">
                    {TARGETS.map((t) => (
                      <button
                        key={t.value}
                        onClick={() => { setBulkTarget(t.value); setBulkOverrideOpen(false) }}
                        disabled={bulkBusy}
                        title={`Force the whole batch: ${t.hint}`}
                        className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {t.icon} {t.label}
                      </button>
                    ))}
                  </div>
                  <button onClick={() => setBulkOverrideOpen(false)} className="text-muted-foreground hover:text-foreground" title="Cancel">
                    <XIcon className="size-3.5" />
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setBulkOverrideOpen(true)}
                  disabled={bulkBusy}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Override target…
                </button>
              )
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary">
                Forcing: {TARGETS.find((t) => t.value === bulkTarget)?.label}
                <button onClick={() => setBulkTarget('auto')} title="Back to Auto (scan each)">
                  <XIcon className="size-3.5" />
                </button>
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {bulkTarget === 'auto'
              ? 'Auto reads each mod’s Nexus/Steam page and routes it (Server / Client / Both).'
              : 'Forcing every mod to one destination.'}{' '}
            Up to 50. Steam URLs are capped at {STEAM_BULK_MAX} per run.
          </p>
          {nx && !nx.premium && (
            <p className="text-xs text-amber-600 dark:text-amber-500">Nexus links need Premium for server installs (free tier → client only).</p>
          )}
          {stm && !stm.connected && (
            <p className="text-xs text-amber-600 dark:text-amber-500">Steam links need a connected account.</p>
          )}
          {bulkRows && (
            <ul className="flex flex-col gap-1 rounded-md border p-2 text-xs">
              {bulkRows.map((r, i) => (
                <li key={i} className={r.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>
                  {r.ok ? '✓' : '✕'} <span className="text-muted-foreground">[{r.scope}]</span> {r.label}
                  {r.note ? ` — ${r.note}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!config && <p className="mt-2 text-xs text-muted-foreground">Connect to the server to add mods.</p>}
    </div>
  )
}
