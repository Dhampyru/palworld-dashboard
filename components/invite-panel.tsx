'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
} from 'lucide-react'

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

      <ClientModsSection />
    </div>
  )
}

// ── Client-only mods (docs/specs/client-mod-sync.md §2c, Phase 2 intake) ──────
// Where the admin STAGES the mods a friend's client needs (cosmetic / UI / QoL mods
// that run on the client, not the server). These are NOT installed on the server; the
// loadout generator (next piece) packs the kept ones into a friend bundle.
type ClientMod = {
  id: string
  name: string
  source: 'nexus' | 'steam' | 'upload'
  sourceId: string | null
  url: string | null
  kind: 'ue4ss' | 'pak' | 'palschema' | 'unknown'
  version: string | null
  sizeBytes: number
  keep: boolean
  addedAt: number
}
type Suggestion = {
  source: 'nexus' | 'workshop'
  id: string
  name: string
  url: string
  category: string | null
  installOn: string
}

function detectSource(u: string): 'nexus' | 'steam' | null {
  if (/nexusmods\.com/i.test(u)) return 'nexus'
  if (/steamcommunity\.com|[?&]id=/i.test(u)) return 'steam'
  return null
}

const SOURCE_LABEL: Record<string, string> = { nexus: 'Nexus', steam: 'Steam', workshop: 'Steam', upload: 'Upload' }

function ClientModsSection() {
  const { config } = useServer()
  const [mods, setMods] = useState<ClientMod[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [catalogAvailable, setCatalogAvailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // id or 'add'/'upload'
  const [url, setUrl] = useState('')
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [filter, setFilter] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    try {
      const res = await fetch('/api/client-mods', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      setMods(json.mods ?? [])
      setSuggestions(json.suggestions ?? [])
      setCatalogAvailable(Boolean(json.catalogAvailable))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load client mods')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    void load()
  }, [load])

  const postJson = useCallback(
    async (body: Record<string, unknown>) => {
      if (!config) return null
      const res = await fetch('/api/client-mods', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      return json
    },
    [config],
  )

  const addByUrl = useCallback(async () => {
    const u = url.trim()
    if (!u) return
    const src = detectSource(u)
    if (!src) {
      toast.error('Paste a full Nexus or Steam Workshop URL')
      return
    }
    setBusy('add')
    try {
      const json = await postJson({ action: src === 'nexus' ? 'addNexus' : 'addSteam', url: u })
      toast.success(json?.note ?? 'Staged for clients')
      setUrl('')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Add failed')
    } finally {
      setBusy(null)
    }
  }, [url, postJson, load])

  const addCatalog = useCallback(
    async (s: Suggestion) => {
      setBusy(`sug:${s.source}:${s.id}`)
      try {
        const json = await postJson({ action: 'addCatalog', source: s.source, id: s.id })
        toast.success(json?.note ?? `Staged ${s.name}`)
        await load()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Add failed')
      } finally {
        setBusy(null)
      }
    },
    [postJson, load],
  )

  const upload = useCallback(
    async (file: File) => {
      if (!config) return
      setBusy('upload')
      try {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch('/api/client-mods', {
          method: 'POST',
          headers: buildPalworldProxyHeaders(config), // no Content-Type — the browser sets the multipart boundary
          body: fd,
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        toast.success(json?.note ?? 'Staged for clients')
        await load()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed')
      } finally {
        setBusy(null)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [config, load],
  )

  const toggleKeep = useCallback(
    async (m: ClientMod) => {
      setBusy(m.id)
      try {
        await postJson({ action: 'setKeep', id: m.id, keep: !m.keep })
        setMods((prev) => prev.map((x) => (x.id === m.id ? { ...x, keep: !x.keep } : x)))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Update failed')
      } finally {
        setBusy(null)
      }
    },
    [postJson],
  )

  const remove = useCallback(
    async (m: ClientMod) => {
      if (!window.confirm(`Remove "${m.name}" from the client-mod set? (Does not affect the server.)`)) return
      setBusy(m.id)
      try {
        await postJson({ action: 'remove', id: m.id })
        await load()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Remove failed')
      } finally {
        setBusy(null)
      }
    },
    [postJson, load],
  )

  const filteredSuggestions = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return f ? suggestions.filter((s) => s.name.toLowerCase().includes(f)) : suggestions
  }, [suggestions, filter])

  const keptCount = mods.filter((m) => m.keep).length

  return (
    <div className="mt-2 flex flex-col gap-3 rounded-md border border-primary/20 p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MonitorIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">Client-only mods ({mods.length})</h3>
          {keptCount !== mods.length && (
            <span className="text-xs text-muted-foreground">· {keptCount} kept for loadout</span>
          )}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          <RefreshCwIcon className={loading ? 'size-3 animate-spin' : 'size-3'} />
          Refresh
        </button>
      </div>

      <p className="text-xs text-muted-foreground">
        Cosmetic / UI / QoL mods that run on a <span className="font-medium">friend&apos;s client</span>, not the
        server. Staged here (not installed on the server); the friend-loadout generator packs the kept ones next.
      </p>

      {/* Add by URL + upload */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          placeholder="Nexus or Steam Workshop URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addByUrl()
          }}
          className="sm:max-w-sm"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-9 gap-1.5 text-xs" onClick={addByUrl} disabled={busy === 'add' || !url.trim()}>
            {busy === 'add' ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5" />}
            Add
          </Button>
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy === 'upload'}
            className="inline-flex h-9 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            {busy === 'upload' ? <Spinner className="size-3.5" /> : <UploadIcon className="size-3.5" />}
            Upload
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.rar,.7z,.pak"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload(f)
            }}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Nexus auto-download needs a Premium key; Steam needs a connected account (Panel Settings). No key? Upload a
        .zip / .rar / .7z / .pak.
      </p>

      {/* Staged list */}
      {mods.length > 0 && (
        <ul className="flex flex-col divide-y rounded-md border">
          {mods.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <label className="flex min-w-0 items-center gap-2">
                <input
                  type="checkbox"
                  checked={m.keep}
                  disabled={busy === m.id}
                  onChange={() => toggleKeep(m)}
                  title={m.keep ? 'In the friend loadout — click to exclude' : 'Excluded — click to include'}
                  className="size-4 shrink-0 accent-primary"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`truncate text-sm ${m.keep ? 'font-medium' : 'text-muted-foreground line-through'}`}>
                      {m.name}
                    </span>
                    {m.url && (
                      <a href={m.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary">
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {SOURCE_LABEL[m.source] ?? m.source} · {m.kind}
                    {m.version ? ` · v${m.version}` : ''} · {formatBytes(m.sizeBytes)}
                  </div>
                </div>
              </label>
              <button
                onClick={() => remove(m)}
                disabled={busy === m.id}
                title="Remove from the client-mod set"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
              >
                {busy === m.id ? <Spinner className="size-3.5" /> : <Trash2Icon className="size-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Catalog suggestions */}
      {catalogAvailable && suggestions.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            onClick={() => setShowSuggestions((s) => !s)}
            className="flex items-center gap-1.5 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDownIcon className={showSuggestions ? 'size-3.5 rotate-180 transition-transform' : 'size-3.5 transition-transform'} />
            Suggested from your mod catalog ({suggestions.length})
          </button>
          {showSuggestions && (
            <div className="flex flex-col gap-2">
              <Input
                placeholder="Filter suggestions…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="h-8 max-w-xs text-xs"
              />
              <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
                {filteredSuggestions.map((s) => {
                  const bid = `sug:${s.source}:${s.id}`
                  return (
                    <li key={bid} className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm">{s.name}</span>
                          {s.url && (
                            <a href={s.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-primary">
                              <ExternalLinkIcon className="size-3" />
                            </a>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {SOURCE_LABEL[s.source] ?? s.source} · {s.installOn}
                        </div>
                      </div>
                      <button
                        onClick={() => addCatalog(s)}
                        disabled={busy === bid}
                        title={`Stage ${s.name} for clients`}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-primary/10 hover:text-primary disabled:opacity-40"
                      >
                        {busy === bid ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5" />}
                        Add
                      </button>
                    </li>
                  )
                })}
                {filteredSuggestions.length === 0 && (
                  <li className="px-3 py-2 text-xs text-muted-foreground">No matches.</li>
                )}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
