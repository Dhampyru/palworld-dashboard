'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
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
  AlertTriangleIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UploadIcon,
} from 'lucide-react'

type ClientConfigFile = {
  id: string
  relWithin: string
  modFolder: string
  format: 'json' | 'jsonc' | 'ini' | 'lua' | 'text'
  content: string
  overridden: boolean
}

// PATCH (not upstream): client-only mod staging (docs/specs/client-mod-sync.md §2c, Phase
// 2 intake), the "Client mods" sub-tab of the Mods page. Where the admin STAGES the mods a
// friend's client needs — cosmetic / UI / QoL mods that run on the client, NOT the server.
// These are never installed on the server; they feed the friend-loadout generator + the
// onboarding packet in the Invite tab. Mirrors the server Mods tab's single + bulk install.

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
  warn?: string | null
}
type Suggestion = {
  source: 'nexus' | 'workshop'
  id: string
  name: string
  url: string
  category: string | null
  installOn: string
}
type BulkResult = { input: string; ok: boolean; name?: string; kind?: string; warn?: string | null; error?: string }

const SOURCE_LABEL: Record<string, string> = { nexus: 'Nexus', steam: 'Steam', workshop: 'Steam', upload: 'Upload' }

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function detectSource(u: string): 'nexus' | 'steam' | null {
  if (/nexusmods\.com/i.test(u)) return 'nexus'
  if (/steamcommunity\.com|[?&]id=/i.test(u)) return 'steam'
  return null
}

export function ClientModsPanel() {
  const { config, requestTab } = useServer()
  const [mods, setMods] = useState<ClientMod[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [catalogAvailable, setCatalogAvailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // id or 'add'/'upload'/'bulk'
  const [confirmRemove, setConfirmRemove] = useState<ClientMod | null>(null)
  const [url, setUrl] = useState('')
  const [bulk, setBulk] = useState('')
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [filter, setFilter] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)

  // Account status — which auto-download sources are available (for the hints).
  const [nexus, setNexus] = useState<{ premium: boolean; name: string | null } | null>(null)
  const [steam, setSteam] = useState<{ connected: boolean; username: string | null } | null>(null)


  // Config editor.
  const [configMod, setConfigMod] = useState<ClientMod | null>(null)
  const [configFiles, setConfigFiles] = useState<ClientConfigFile[]>([])
  const [configLoading, setConfigLoading] = useState(false)
  const [configSel, setConfigSel] = useState<string | null>(null)
  const [configDraft, setConfigDraft] = useState('')
  const [configBusy, setConfigBusy] = useState(false)

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    try {
      const h = buildPalworldProxyHeaders(config)
      const [cmRes, nxRes, stRes] = await Promise.all([
        fetch('/api/client-mods', { headers: h, cache: 'no-store' }),
        fetch('/api/nexus', { headers: h, cache: 'no-store' }).catch(() => null),
        fetch('/api/steam', { headers: h, cache: 'no-store' }).catch(() => null),
      ])
      const json = await cmRes.json()
      if (!cmRes.ok) throw new Error(json.error ?? cmRes.statusText)
      setMods(json.mods ?? [])
      setSuggestions(json.suggestions ?? [])
      setCatalogAvailable(Boolean(json.catalogAvailable))
      if (nxRes?.ok) {
        const n = await nxRes.json()
        setNexus({ premium: Boolean(n.valid && n.isPremium), name: n.name ?? null })
      }
      if (stRes?.ok) {
        const s = (await stRes.json()).status ?? {}
        setSteam({ connected: Boolean(s.connected), username: s.username ?? null })
      }
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
      if (json?.mod?.warn) toast.warning(`Staged ${json.mod.name}, but: ${json.mod.warn}`, { duration: 8000 })
      else toast.success(json?.note ?? 'Staged for clients')
      setUrl('')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Add failed')
    } finally {
      setBusy(null)
    }
  }, [url, postJson, load])

  const addBulk = useCallback(async () => {
    const urls = bulk
      .split(/[\n,]/)
      .map((u) => u.trim())
      .filter(Boolean)
    if (!urls.length) return
    setBusy('bulk')
    setBulkResults(null)
    try {
      const json = await postJson({ action: 'bulk', urls })
      setBulkResults(json?.results ?? [])
      toast[json?.staged ? 'success' : 'message'](json?.note ?? 'Done')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk stage failed')
    } finally {
      setBusy(null)
    }
  }, [bulk, postJson, load])

  const addCatalog = useCallback(
    async (s: Suggestion) => {
      setBusy(`sug:${s.source}:${s.id}`)
      try {
        const json = await postJson({ action: 'addCatalog', source: s.source, id: s.id })
        if (json?.mod?.warn) toast.warning(`Staged ${json.mod.name}, but: ${json.mod.warn}`, { duration: 8000 })
        else toast.success(json?.note ?? `Staged ${s.name}`)
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
          headers: buildPalworldProxyHeaders(config), // no Content-Type — browser sets the multipart boundary
          body: fd,
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        if (json?.mod?.warn) toast.warning(`Staged ${json.mod.name}, but: ${json.mod.warn}`, { duration: 8000 })
        else toast.success(json?.note ?? 'Staged for clients')
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

  // Called from the confirm dialog (AlertDialog — replaces window.confirm, which blocked
  // the page thread and hung automated browsers).
  const remove = useCallback(
    async (m: ClientMod) => {
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

  const openConfig = useCallback(
    async (m: ClientMod) => {
      setConfigMod(m)
      setConfigFiles([])
      setConfigSel(null)
      setConfigDraft('')
      setConfigLoading(true)
      try {
        const json = await postJson({ action: 'configList', id: m.id })
        const files: ClientConfigFile[] = json?.configs ?? []
        setConfigFiles(files)
        if (files.length) {
          setConfigSel(files[0].id)
          setConfigDraft(files[0].content)
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not read config')
      } finally {
        setConfigLoading(false)
      }
    },
    [postJson],
  )

  const selectConfig = useCallback(
    (id: string) => {
      const f = configFiles.find((x) => x.id === id)
      if (!f) return
      setConfigSel(id)
      setConfigDraft(f.content)
    },
    [configFiles],
  )

  const saveConfig = useCallback(async () => {
    if (!configMod || !configSel) return
    setConfigBusy(true)
    try {
      await postJson({ action: 'configSave', id: configMod.id, cfg: configSel, content: configDraft })
      toast.success('Config saved — it ships in the loadout')
      setConfigFiles((prev) => prev.map((f) => (f.id === configSel ? { ...f, content: configDraft, overridden: true } : f)))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed (check the format)')
    } finally {
      setConfigBusy(false)
    }
  }, [configMod, configSel, configDraft, postJson])

  const resetConfig = useCallback(async () => {
    if (!configMod || !configSel) return
    setConfigBusy(true)
    try {
      await postJson({ action: 'configClear', id: configMod.id, cfg: configSel })
      // reload to pull the shipped default back in
      const json = await postJson({ action: 'configList', id: configMod.id })
      const files: ClientConfigFile[] = json?.configs ?? []
      setConfigFiles(files)
      const f = files.find((x) => x.id === configSel)
      if (f) setConfigDraft(f.content)
      toast.success('Reset to the mod’s shipped config')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setConfigBusy(false)
    }
  }, [configMod, configSel, postJson])

  const filteredSuggestions = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return f ? suggestions.filter((s) => s.name.toLowerCase().includes(f)) : suggestions
  }, [suggestions, filter])

  const keptCount = mods.filter((m) => m.keep).length

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MonitorIcon className="size-5 text-primary" />
          <h2 className="text-lg font-semibold">Client mods ({mods.length})</h2>
          {mods.length > 0 && keptCount !== mods.length && (
            <span className="text-xs text-muted-foreground">· {keptCount} kept for the loadout</span>
          )}
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

      {/* Explainer */}
      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">What is this?</p>
        <p>
          Mods that run on a <span className="font-medium text-foreground">friend&apos;s client</span> (cosmetics, UI,
          FOV, quality-of-life) — <span className="font-medium text-foreground">not</span> installed on the server.
          Stage the ones your friends should have here, then build &amp; download the bundle from the{' '}
          <button
            type="button"
            onClick={() => requestTab('invite')}
            className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
          >
            Invite friends tab
          </button>
          . The server&apos;s own mods live under the <span className="font-medium text-foreground">Server mods</span> tab.
        </p>
      </div>

      {/* Account status hints — neutral "checking…" until the status resolves, so the first
          paint never flashes a misleading "not Premium / not connected". */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Auto-download sources:</span>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
            nexus?.premium ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
          }`}
        >
          Nexus {nexus === null ? '· checking…' : nexus.premium ? `· Premium (${nexus.name ?? 'connected'})` : '· not Premium'}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${
            steam?.connected ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'
          }`}
        >
          Steam {steam === null ? '· checking…' : steam.connected ? `· ${steam.username ?? 'connected'}` : '· not connected'}
        </span>
      </div>
      {((nexus && !nexus.premium) || (steam && !steam.connected)) && (
        <p className="-mt-2 text-[11px] text-muted-foreground">
          {nexus && !nexus.premium && 'Nexus auto-download needs a Premium key (Panel Settings → Nexus). '}
          {steam && !steam.connected && 'Steam Workshop needs a connected account (Panel Settings → Steam). '}
          Without them, use <span className="font-medium">Upload</span> for those mods.
        </p>
      )}

      {/* Single add + upload */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Add a client mod</label>
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
      </div>

      {/* Bulk add */}
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium">Bulk add — paste many URLs</label>
        <textarea
          placeholder={'One Nexus or Steam Workshop URL per line…'}
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          rows={3}
          className="w-full resize-y rounded-md border bg-muted/20 p-2 font-mono text-xs"
        />
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={addBulk} disabled={busy === 'bulk' || !bulk.trim()}>
            {busy === 'bulk' ? <Spinner className="size-3.5" /> : <PlusIcon className="size-3.5" />}
            Stage all
          </Button>
          <span className="text-[11px] text-muted-foreground">Up to 50 at once · staged one by one</span>
        </div>
        {bulkResults && (
          <ul className="flex flex-col gap-1 rounded-md border p-2 text-xs">
            {bulkResults.map((r, i) => (
              <li key={i} className={r.ok ? (r.warn ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400') : 'text-destructive'}>
                {r.ok ? (r.warn ? '⚠' : '✓') : '✕'} {r.name ?? r.input}
                {r.ok ? (r.warn ? ` (${r.kind}) — ${r.warn}` : ` (${r.kind})`) : ` — ${r.error}`}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Staged list */}
      {mods.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Staged for friends ({mods.length})</span>
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
                      {m.warn && (
                        <span title={m.warn} className="text-amber-500">
                          <AlertTriangleIcon className="size-3.5" />
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {SOURCE_LABEL[m.source] ?? m.source} · {m.kind}
                      {m.version ? ` · v${m.version}` : ''} · {formatBytes(m.sizeBytes)}
                      {m.warn ? <span className="text-amber-500"> · won’t ship to clients</span> : ''}
                    </div>
                  </div>
                </label>
                <div className="flex items-center gap-1.5">
                  {m.kind !== 'pak' && (
                    <button
                      onClick={() => openConfig(m)}
                      title="Edit this mod's config (ships in the loadout)"
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
                    >
                      <SlidersHorizontalIcon className="size-3.5" />
                      Config
                    </button>
                  )}
                  <button
                    onClick={() => setConfirmRemove(m)}
                    disabled={busy === m.id}
                    title="Remove from the client-mod set"
                    className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  >
                    {busy === m.id ? <Spinner className="size-3.5" /> : <Trash2Icon className="size-3.5" />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Catalog suggestions */}
      {catalogAvailable && suggestions.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            onClick={() => setShowSuggestions((s) => !s)}
            className="flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDownIcon className={showSuggestions ? 'size-4 rotate-180 transition-transform' : 'size-4 transition-transform'} />
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
              <ul className="flex max-h-80 flex-col divide-y overflow-y-auto rounded-md border">
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

      {/* Config editor */}
      <Sheet open={!!configMod} onOpenChange={(o) => !o && setConfigMod(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <SlidersHorizontalIcon className="size-4 text-primary" />
              {configMod?.name} · config
            </SheetTitle>
          </SheetHeader>
          <p className="text-xs text-muted-foreground">
            Edits are stored as an override and shipped into every client&apos;s loadout — the mod&apos;s staged files
            aren&apos;t changed. Reset drops back to the mod&apos;s shipped config.
          </p>
          {configLoading ? (
            <p className="text-sm text-muted-foreground">Reading config…</p>
          ) : configFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No editable config file found in this mod. (Some mods generate their config only on first run.)
            </p>
          ) : (
            <>
              {configFiles.length > 1 && (
                <select
                  value={configSel ?? ''}
                  onChange={(e) => selectConfig(e.target.value)}
                  className="rounded-md border bg-background px-2 py-1.5 text-xs"
                >
                  {configFiles.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.relWithin}
                      {f.overridden ? ' (edited)' : ''}
                    </option>
                  ))}
                </select>
              )}
              {configSel && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="font-mono">{configSel}</span>
                  <span>{configFiles.find((f) => f.id === configSel)?.format}</span>
                </div>
              )}
              <textarea
                value={configDraft}
                onChange={(e) => setConfigDraft(e.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded-md border bg-muted/20 p-3 font-mono text-xs"
              />
              <div className="flex items-center gap-2">
                <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={saveConfig} disabled={configBusy}>
                  {configBusy ? <Spinner className="size-3.5" /> : null}
                  Save
                </Button>
                <button
                  onClick={resetConfig}
                  disabled={configBusy || !configFiles.find((f) => f.id === configSel)?.overridden}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs hover:bg-muted disabled:opacity-40"
                >
                  <RotateCcwIcon className="size-3.5" />
                  Reset to shipped
                </button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Remove confirm — the shared AlertDialog (not window.confirm) */}
      <AlertDialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this client mod?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRemove ? `"${confirmRemove.name}" will be removed from the client-mod set and won't ship in the loadout. This does not affect the server.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmRemove) void remove(confirmRemove)
                setConfirmRemove(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
