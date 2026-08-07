'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { CheckIcon, CopyIcon, DownloadIcon, PackageIcon, RefreshCwIcon, UsersIcon } from 'lucide-react'

// PATCH (not upstream): client mod-sync, Phase 1 (docs/specs/client-mod-sync.md).
// A read-only "invite / server requirements" surface: shows what a joining client
// needs and generates a copy-paste onboarding packet the admin shares with friends.
// No client automation yet (that's Phase 2). The connect address is admin-entered
// — the server doesn't know its own public IP (PublicIP is blank).

type Manifest = {
  serverName: string | null
  gameVersion: string | null
  port: number
  ue4ss: { source: string | null; sha: string | null; version: string | null }
  palschema: { installed: boolean; version: string | null }
  clientMods: { file: string; sizeBytes: number; sha256: string }[]
  generatedAt: string
}

const HOST_KEY = 'inviteConnectHost'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function InvitePanel() {
  const { config } = useServer()
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [loading, setLoading] = useState(false)
  const [host, setHost] = useState('')
  const [copied, setCopied] = useState(false)
  const [downloading, setDownloading] = useState<string | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Client-mod loadout builder (moved here from the Client-mods tab — this is the
  // onboarding/align-friends area). keptCount is fetched for the button label/gate.
  const [keptCount, setKeptCount] = useState<number | null>(null)
  const [includeUe4ss, setIncludeUe4ss] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [lastLoadout, setLastLoadout] = useState<string | null>(null)

  useEffect(() => {
    try {
      const s = localStorage.getItem(HOST_KEY)
      if (s) setHost(s)
    } catch {
      /* ignore */
    }
  }, [])

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    try {
      const res = await fetch('/api/manifest', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      setManifest(json as Manifest)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load manifest')
    } finally {
      setLoading(false)
    }
    // How many client mods are kept (for the loadout button label + gate). Best-effort.
    try {
      const cm = await fetch('/api/client-mods', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      if (cm.ok) {
        const j = await cm.json()
        setKeptCount((j.mods ?? []).filter((m: { keep?: boolean }) => m.keep).length)
      }
    } catch {
      /* ignore */
    }
  }, [config])

  useEffect(() => {
    void load()
  }, [load])

  const onHostChange = (v: string) => {
    setHost(v)
    try {
      localStorage.setItem(HOST_KEY, v)
    } catch {
      /* ignore */
    }
  }

  const downloadPak = useCallback(
    async (file: string) => {
      if (!config) return
      setDownloading(file)
      try {
        const res = await fetch(`/api/game-mods/pak?name=${encodeURIComponent(file)}`, {
          headers: buildPalworldProxyHeaders(config),
          cache: 'no-store',
        })
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
        const url = URL.createObjectURL(await res.blob())
        const a = document.createElement('a')
        a.href = url
        a.download = file
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Download failed')
      } finally {
        setDownloading(null)
      }
    },
    [config],
  )

  const generateLoadout = useCallback(async () => {
    if (!config) return
    setGenerating(true)
    setLastLoadout(null)
    try {
      // Generate the bundle server-side → one-time download token → stream to disk.
      const res = await fetch(`/api/client-mods/loadout?ue4ss=${includeUe4ss ? '1' : '0'}`, {
        method: 'POST',
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      const s = json.summary ?? {}
      const sizeMb = (Number(s.sizeBytes ?? 0) / 1024 / 1024).toFixed(0)
      const summary = `${s.luaMods?.length ?? '?'} Lua + ${s.pakFiles?.length ?? '?'} pak · ${sizeMb} MB · UE4SS ${s.includedUe4ss ? 'included' : 'excluded'}${s.configOverrides ? ` · ${s.configOverrides} config` : ''}${s.skipped?.length ? ` · ${s.skipped.length} skipped (see manifest.json)` : ''}`
      setLastLoadout(summary)
      const a = document.createElement('a')
      a.href = `/api/client-mods/loadout?token=${encodeURIComponent(json.token)}`
      a.download = json.fileName ?? 'palworld-client-loadout.zip'
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast.success(`Loadout built — ${summary}. Download starting…`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Loadout generation failed')
    } finally {
      setGenerating(false)
    }
  }, [config, includeUe4ss])

  const inviteText = useMemo(() => {
    if (!manifest) return ''
    const name = manifest.serverName ?? 'the server'
    const connect = host.trim() ? `${host.trim()}:${manifest.port}` : `<your public IP>:${manifest.port}`
    const lines: string[] = []
    lines.push(`Join ${name}!`)
    lines.push('')
    lines.push(`Connect address: ${connect}`)
    if (manifest.gameVersion) {
      lines.push(`Palworld version: ${manifest.gameVersion} — update via Steam if yours differs (you can't join otherwise).`)
    }
    lines.push('')
    if (manifest.clientMods.length === 0) {
      lines.push('No client-side mods required — just connect.')
    } else {
      lines.push('Required mods — drop these .pak files into:')
      lines.push('  …\\Steam\\steamapps\\common\\Palworld\\Pal\\Content\\Paks\\~mods\\')
      for (const m of manifest.clientMods) lines.push(`  • ${m.file} (${formatBytes(m.sizeBytes)})`)
      lines.push('')
      lines.push('Ask me for the mod files (or the download links) — then relaunch Palworld.')
    }
    return lines.join('\n')
  }, [manifest, host])

  const copyInvite = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteText)
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
      toast.success('Invite copied to clipboard')
    } catch {
      toast.error('Could not copy — select the text and copy manually')
    }
  }, [inviteText])

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UsersIcon className="size-5" />
          <h2 className="text-lg font-semibold">Invite &amp; Align Friends</h2>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:bg-muted disabled:opacity-50"
        >
          <RefreshCwIcon className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          Refresh
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        What a friend needs to join this modded server. Clients only need the game (matching version)
        and the <span className="font-medium">pak</span> files below — UE4SS/PalSchema run server-side.
      </p>

      {!manifest ? (
        <p className="text-sm text-muted-foreground">
          {loading ? 'Loading server requirements…' : 'No manifest loaded.'}
        </p>
      ) : (
        <>
          {/* Server + versions */}
          <div className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-2">
            <div>
              <span className="text-muted-foreground">Server:</span>{' '}
              <span className="font-medium">{manifest.serverName ?? 'unknown'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Game version:</span>{' '}
              <span className="font-mono">{manifest.gameVersion ?? 'unknown'}</span>
            </div>
            <div>
              <span className="text-muted-foreground">UE4SS:</span>{' '}
              <span className="font-mono text-xs">
                {manifest.ue4ss.version ?? '—'}
                {manifest.ue4ss.sha ? ` #${manifest.ue4ss.sha}` : ''}
              </span>{' '}
              <span className="text-xs text-muted-foreground">(server-side)</span>
            </div>
            <div>
              <span className="text-muted-foreground">PalSchema:</span>{' '}
              <span className="font-mono text-xs">
                {manifest.palschema.installed ? (manifest.palschema.version ?? 'installed') : 'not installed'}
              </span>{' '}
              <span className="text-xs text-muted-foreground">(server-side)</span>
            </div>
          </div>

          {/* Connect address (admin-entered — the server doesn't know its public IP) */}
          <div className="flex flex-col gap-1.5 rounded-md border p-3">
            <label className="text-sm font-medium">Connect address</label>
            <div className="flex items-center gap-2">
              <Input
                placeholder="your public IP or domain"
                value={host}
                onChange={(e) => onHostChange(e.target.value)}
                className="max-w-xs"
              />
              <span className="font-mono text-sm text-muted-foreground">:{manifest.port}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              The dashboard can&apos;t detect your public IP — enter what friends use to connect. Saved locally.
            </p>
          </div>

          {/* Client-required mods */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Client-required mods ({manifest.clientMods.length})</span>
            {manifest.clientMods.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None — no pak mods installed. Friends just need the matching game version.
              </p>
            ) : (
              <ul className="flex flex-col divide-y rounded-md border">
                {manifest.clientMods.map((m) => (
                  <li key={m.file} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-sm">{m.file}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {formatBytes(m.sizeBytes)} · sha256 {m.sha256.slice(0, 12)}…
                      </div>
                    </div>
                    <button
                      onClick={() => downloadPak(m.file)}
                      disabled={downloading === m.file}
                      title={`Download ${m.file} to hand out`}
                      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-primary/10 hover:text-primary disabled:opacity-40"
                    >
                      {downloading === m.file ? <Spinner className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
                      Download
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Hybrid/pak mods must be on each player&apos;s client too — download them here and share the files.
            </p>
          </div>

          {/* Shareable invite packet */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Shareable invite</span>
              <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={copyInvite}>
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
                {copied ? 'Copied' : 'Copy invite text'}
              </Button>
            </div>
            <textarea
              readOnly
              value={inviteText}
              rows={Math.min(14, inviteText.split('\n').length + 1)}
              className="w-full resize-y rounded-md border bg-muted/20 p-3 font-mono text-xs"
            />
          </div>
        </>
      )}

      {/* Build friend loadout — the onboarding payoff (moved here from the Client-mods tab) */}
      <div className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-3">
        <div className="flex items-center gap-2">
          <PackageIcon className="size-4 text-primary" />
          <span className="text-sm font-semibold">Build friend loadout</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Packages your kept client mods
          {keptCount != null ? (
            <>
              {' '}(<span className="font-medium text-foreground">{keptCount}</span>)
            </>
          ) : (
            ''
          )}{' '}
          into a Classic-UE4SS bundle your friend extracts over their Palworld install — no Steam Workshop or Nexus
          needed on their end. Includes an <span className="font-mono">INSTALL.txt</span> +{' '}
          <span className="font-mono">install.ps1</span>. Stage which mods to include under{' '}
          <span className="font-medium text-foreground">Mods → Client mods</span>.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            className="h-9 gap-1.5 text-xs"
            onClick={generateLoadout}
            disabled={generating || keptCount === 0}
          >
            {generating ? <Spinner className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
            {generating ? 'Building…' : 'Generate & download'}
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={includeUe4ss}
              onChange={(e) => setIncludeUe4ss(e.target.checked)}
              className="size-4 accent-primary"
            />
            Include UE4SS loader (self-contained)
          </label>
        </div>
        {generating && (
          <p className="text-[11px] text-muted-foreground">
            Assembling on the server — a large set can take a minute and download as a big .zip.
          </p>
        )}
        {lastLoadout && <p className="text-[11px] text-emerald-600 dark:text-emerald-400">Last build: {lastLoadout}</p>}
      </div>
    </div>
  )
}
