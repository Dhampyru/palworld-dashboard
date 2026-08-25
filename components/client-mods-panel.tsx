'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { ModConfigForm, hasModConfigSchema, type ConfigJson } from '@/components/modconfig-form'
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
  FolderPlusIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UploadIcon,
  WandSparklesIcon,
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
  keepChangedAt?: number
  warn?: string | null
  updateAvailable?: boolean // newer upstream build available (nexus version / steam timestamp)
  latestVersion?: string | null // nexus: newest version seen, for the chip label
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

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function detectSource(u: string): 'nexus' | 'steam' | null {
  if (/nexusmods\.com/i.test(u)) return 'nexus'
  if (/steamcommunity\.com|[?&]id=/i.test(u)) return 'steam'
  return null
}

// `hideUploader` removes the client add/upload/bulk controls — the unified uploader above
// the tabs stages client mods now. `reloadKey` refreshes this list after it commits.
export function ClientModsPanel({ hideUploader = false, reloadKey }: { hideUploader?: boolean; reloadKey?: number } = {}) {
  const { config, requestTab, refreshModUpdates } = useServer()
  const [mods, setMods] = useState<ClientMod[]>([])
  const [listQuery, setListQuery] = useState('')
  // 'category' groups into collapsible genre sections (the default); every other value is a FLAT,
  // globally-sorted list so the sort actually orders the whole list (grouping + global sort fight).
  const [listSort, setListSort] = useState<'category' | 'name-asc' | 'name-desc' | 'added-desc' | 'added-asc' | 'source' | 'type'>('category')
  const [categories, setCategories] = useState<Record<string, string | null>>({})
  // EXPANDED category sections (names). Empty = all COLLAPSED (default); controlled so
  // Expand/Collapse-all work. Only meaningful when listSort === 'category'.
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set())
  const [showDisabled, setShowDisabled] = useState(false) // collapse the disabled (not-in-loadout) block
  const [conflictsOnly, setConflictsOnly] = useState(false) // filter the list to only mods with a keybind conflict
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [catalogAvailable, setCatalogAvailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // id or 'add'/'upload'/'bulk'
  const [confirmRemove, setConfirmRemove] = useState<ClientMod | null>(null)
  const [lastToggledId, setLastToggledId] = useState<string | null>(null) // highlight the row you just flipped
  type KeybindScan = { conflicts: { combo: string; mods: string[] }[]; perMod: Record<string, { combo: string; others: string[] }[]> }
  const [keybinds, setKeybinds] = useState<KeybindScan | null>(null)
  // Auto-remap: the fixed spec + whether it's currently applied (overrides in place).
  type RemapPlan = {
    remap: { modName: string; pairs: [string, string][] }[]
    payloadEdits: { modName: string; resolves: string }[]
    applied: boolean
  }
  const [remap, setRemap] = useState<RemapPlan | null>(null)
  const [remapBusy, setRemapBusy] = useState(false)
  const [remapOpen, setRemapOpen] = useState(false) // "what it changes" disclosure
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
  const [configView, setConfigView] = useState<'form' | 'raw'>('form') // .modconfig.json → form by default

  // Extra-files editor (upload operator files into a mod folder → ship in the loadout).
  type OverlayFile = { rel: string; name: string; bytes: number; duplicate?: boolean }
  const [filesMod, setFilesMod] = useState<ClientMod | null>(null)
  const [filesFolders, setFilesFolders] = useState<string[]>([])
  const [filesOverlay, setFilesOverlay] = useState<{ files: OverlayFile[]; totalBytes: number; duplicates: number }>({ files: [], totalBytes: 0, duplicates: 0 })
  const [filesRel, setFilesRel] = useState('')
  const [filesLoading, setFilesLoading] = useState(false)
  const [filesBusy, setFilesBusy] = useState(false)
  const [filesMax, setFilesMax] = useState(50 * 1024 * 1024)
  const filesInputRef = useRef<HTMLInputElement | null>(null)
  const zipInputRef = useRef<HTMLInputElement | null>(null)
  const [filesSel, setFilesSel] = useState<Set<string>>(new Set())
  const [clearAllConfirm, setClearAllConfirm] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileKey = (f: OverlayFile) => `${f.rel}|${f.name}`
  const ARCHIVE_RE = /\.(zip|7z|rar|tar|gz|tgz)$/i

  const loadFiles = useCallback(
    async (m: ClientMod) => {
      if (!config) return
      setFilesLoading(true)
      try {
        const res = await fetch(`/api/client-mod-files?modId=${encodeURIComponent(m.id)}`, {
          headers: buildPalworldProxyHeaders(config),
          cache: 'no-store',
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Failed to load')
        setFilesFolders(json.folders ?? [])
        setFilesOverlay(json.overlay ?? { files: [], totalBytes: 0, duplicates: 0 })
        setFilesMax(json.maxBytes ?? 50 * 1024 * 1024)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        setFilesLoading(false)
      }
    },
    [config],
  )

  const openFiles = useCallback(
    (m: ClientMod) => {
      setFilesMod(m)
      setFilesFolders([])
      setFilesOverlay({ files: [], totalBytes: 0, duplicates: 0 })
      setFilesRel('')
      setFilesSel(new Set())
      void loadFiles(m)
    },
    [loadFiles],
  )

  // Parse a response as JSON, but turn a non-JSON body (e.g. an HTML error page from the reverse
  // proxy on an oversized upload) into an honest error instead of "invalid json".
  const readJson = useCallback(async (res: Response) => {
    const text = await res.text()
    try {
      return JSON.parse(text) as { error?: string; overlay?: unknown; bulk?: unknown }
    } catch {
      throw new Error(
        `Server returned a non-JSON response (HTTP ${res.status}). Large uploads are often blocked by the proxy ` +
          `(Cloudflare caps request bodies at ~100 MB). Try a smaller zip, upload files individually, or upload over your local network.`,
      )
    }
  }, [])

  const PROXY_LIMIT = 100 * 1024 * 1024

  const deleteSelected = useCallback(async () => {
    if (!config || !filesMod || filesSel.size === 0) return
    const items = filesOverlay.files.filter((f) => filesSel.has(fileKey(f))).map((f) => ({ rel: f.rel, filename: f.name }))
    setFilesBusy(true)
    try {
      const res = await fetch('/api/client-mod-files', {
        method: 'DELETE',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ modId: filesMod.id, items }),
      })
      const json = await readJson(res)
      if (!res.ok) throw new Error(json.error ?? 'Delete failed')
      if (json.overlay) setFilesOverlay(json.overlay as typeof filesOverlay)
      setFilesSel(new Set())
      toast.success(`Deleted ${items.length} file(s) — regenerate the loadout to apply`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setFilesBusy(false)
    }
  }, [config, filesMod, filesSel, filesOverlay, readJson])

  const clearAllFiles = useCallback(async () => {
    if (!config || !filesMod) return
    setFilesBusy(true)
    try {
      const res = await fetch('/api/client-mod-files', {
        method: 'DELETE',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ modId: filesMod.id, clearAll: true }),
      })
      const json = await readJson(res)
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      setFilesOverlay((json.overlay as typeof filesOverlay) ?? { files: [], totalBytes: 0, duplicates: 0 })
      setFilesSel(new Set())
      setClearAllConfirm(false)
      toast.success('Cleared all extra files — regenerate the loadout to apply')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setFilesBusy(false)
    }
  }, [config, filesMod, readJson])

  const uploadFiles = useCallback(
    async (fileList: FileList | File[] | null) => {
      if (!config || !filesMod || !fileList || !fileList.length) return
      const tooBig = Array.from(fileList).find((f) => f.size > PROXY_LIMIT)
      if (tooBig) {
        toast.error(`"${tooBig.name}" is over ~100 MB — the proxy will reject it. Upload it over your local network instead.`)
        return
      }
      setFilesBusy(true)
      try {
        for (const f of Array.from(fileList)) {
          const form = new FormData()
          form.set('modId', filesMod.id)
          form.set('rel', filesRel)
          form.set('file', f)
          const res = await fetch('/api/client-mod-files', { method: 'POST', headers: buildPalworldProxyHeaders(config), body: form })
          const json = await readJson(res)
          if (!res.ok) throw new Error(json.error ?? `Failed: ${f.name}`)
          if (json.overlay) setFilesOverlay(json.overlay as typeof filesOverlay)
        }
        toast.success('Uploaded — regenerate the loadout to ship it')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Upload failed')
      } finally {
        setFilesBusy(false)
        if (filesInputRef.current) filesInputRef.current.value = ''
      }
    },
    [config, filesMod, filesRel, readJson],
  )

  // Accepts one OR many .zip parts (a split archive) — each is uploaded SEQUENTIALLY as its own
  // request, so every part stays under the proxy's ~100 MB body cap.
  const uploadZip = useCallback(
    async (fileList: FileList | File[] | null) => {
      if (!config || !filesMod || !fileList || !fileList.length) return
      const zips = Array.from(fileList)
      const tooBig = zips.find((f) => f.size > PROXY_LIMIT)
      if (tooBig) {
        toast.error(
          `“${tooBig.name}” is ${formatBytes(tooBig.size)} — over the ~100 MB proxy limit. Split it smaller, or upload over your local network (direct to the dashboard, bypassing Cloudflare).`,
          { duration: 9000 },
        )
        if (zipInputRef.current) zipInputRef.current.value = ''
        return
      }
      setFilesBusy(true)
      let count = 0
      let dup = 0
      let skipped = 0
      let failed = 0
      const many = zips.length > 1
      const progress = many ? toast.loading(`Uploading zip 1 of ${zips.length}…`) : undefined
      try {
        for (let i = 0; i < zips.length; i++) {
          const file = zips[i]!
          if (progress) toast.loading(`Uploading zip ${i + 1} of ${zips.length}: ${file.name}`, { id: progress })
          try {
            const form = new FormData()
            form.set('modId', filesMod.id)
            form.set('rel', filesRel)
            form.set('mode', 'zip')
            form.set('file', file)
            const res = await fetch('/api/client-mod-files', { method: 'POST', headers: buildPalworldProxyHeaders(config), body: form })
            const json = await readJson(res)
            if (!res.ok) throw new Error(json.error ?? 'Bulk upload failed')
            if (json.overlay) setFilesOverlay(json.overlay as typeof filesOverlay)
            const b = json.bulk as { count?: number; skipped?: number; skippedDuplicates?: number } | undefined
            count += b?.count ?? 0
            dup += b?.skippedDuplicates ?? 0
            skipped += b?.skipped ?? 0
          } catch (e) {
            failed++
            toast.error(`${file.name}: ${e instanceof Error ? e.message : 'failed'}`)
          }
        }
        const bits = [`Extracted ${count} file(s)${many ? ` from ${zips.length} zips` : ''}`]
        if (dup) bits.push(`skipped ${dup} the mod already ships (upload singly to override)`)
        if (skipped) bits.push(`skipped ${skipped}`)
        if (failed) bits.push(`${failed} zip(s) failed`)
        const msg = `${bits.join(', ')} — regenerate the loadout to ship`
        if (progress) toast.success(msg, { id: progress })
        else toast.success(msg)
      } finally {
        setFilesBusy(false)
        if (zipInputRef.current) zipInputRef.current.value = ''
      }
    },
    [config, filesMod, filesRel, readJson],
  )

  const removeOverlayFile = useCallback(
    async (rel: string, name: string) => {
      if (!config || !filesMod) return
      setFilesBusy(true)
      try {
        const res = await fetch('/api/client-mod-files', {
          method: 'DELETE',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ modId: filesMod.id, rel, filename: name }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Delete failed')
        if (json.overlay) setFilesOverlay(json.overlay)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Delete failed')
      } finally {
        setFilesBusy(false)
      }
    },
    [config, filesMod],
  )

  // Drag-and-drop: archives extract into place, other files land at the chosen destination.
  const handleDrop = useCallback(
    async (list: FileList | null) => {
      const files = Array.from(list ?? [])
      if (!files.length) return
      const archives = files.filter((f) => ARCHIVE_RE.test(f.name))
      const plain = files.filter((f) => !ARCHIVE_RE.test(f.name))
      if (archives.length) await uploadZip(archives)
      if (plain.length) await uploadFiles(plain)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uploadZip, uploadFiles],
  )

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
      // Client-mod update check (nexus versions / steam timestamps) — fire-and-forget; refreshes
      // the chips in the background. Cached 30d server-side, so only the first pass is slow.
      fetch('/api/client-mods', {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'checkUpdates' }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((u) => {
          if (u && Array.isArray(u.mods)) setMods(u.mods)
        })
        .catch(() => {})
      // Genre categories (nexus:<modId> / steam:<itemId>) for grouping — fire-and-forget.
      fetch('/api/mod-categories', { headers: h, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((c) => {
          if (c && c.categories) setCategories(c.categories as Record<string, string | null>)
        })
        .catch(() => {})
      // Keybind-conflict scan (cached server-side by the mod set) — fire-and-forget.
      fetch('/api/client-mods/keybinds', { headers: h, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((k) => {
          if (k && Array.isArray(k.conflicts)) setKeybinds(k)
        })
        .catch(() => {})
      // Auto-remap plan + applied status (the fix for those conflicts) — fire-and-forget.
      fetch('/api/client-mods/keybinds', { method: 'POST', headers: h, body: JSON.stringify({ action: 'remapPlan' }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => {
          if (p && Array.isArray(p.remap)) setRemap(p as RemapPlan)
        })
        .catch(() => {})
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

  // Refresh when the unified uploader (above the tabs) stages a client mod.
  useEffect(() => {
    if (reloadKey) void load()
  }, [reloadKey, load])

  // Auto-clear the conflicts-only filter once there are no conflicts (the badge that toggles it
  // disappears then, so leaving it on would strand an empty list).
  useEffect(() => {
    if (keybinds && keybinds.conflicts.length === 0 && conflictsOnly) setConflictsOnly(false)
  }, [keybinds, conflictsOnly])

  // Apply / undo the keybind auto-remap (writes/removes loadout config-overrides; admin-only).
  const runRemap = useCallback(
    async (action: 'remapApply' | 'remapClear') => {
      if (!config) return
      setRemapBusy(true)
      try {
        const res = await fetch('/api/client-mods/keybinds', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        if (action === 'remapApply') {
          const n = Array.isArray(json.applied) ? json.applied.length : 0
          toast.success(n ? `Remapped ${n} mod${n === 1 ? '' : 's'} — regenerate the loadout to ship it` : 'Nothing to remap')
        } else {
          toast.success(`Reverted the remap (${json.cleared ?? 0} override${json.cleared === 1 ? '' : 's'}) — regenerate the loadout to apply`)
        }
        await load() // refresh conflict count + applied status
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Remap failed')
      } finally {
        setRemapBusy(false)
      }
    },
    [config, load],
  )

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

  const applyKeep = useCallback(
    async (id: string, keep: boolean) => {
      await postJson({ action: 'setKeep', id, keep })
      setMods((prev) => prev.map((x) => (x.id === id ? { ...x, keep, keepChangedAt: Date.now() } : x)))
      setLastToggledId(id)
    },
    [postJson],
  )

  const toggleKeep = useCallback(
    async (m: ClientMod) => {
      const next = !m.keep
      setBusy(m.id)
      try {
        await applyKeep(m.id, next)
        if (!next) {
          // Disabling is easy to do by accident — always offer a one-click undo, and name it so
          // you can tell WHICH mod changed.
          toast(`Disabled “${m.name}” — it won't ship in the loadout`, {
            action: { label: 'Undo', onClick: () => void applyKeep(m.id, true) },
            duration: 8000,
          })
        } else {
          toast.success(`Enabled “${m.name}”`)
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Update failed')
      } finally {
        setBusy(null)
      }
    },
    [applyKeep],
  )

  // Update one staged mod in place to the newest upstream build (keep + config-override kept).
  const updateOne = useCallback(
    async (m: ClientMod) => {
      setBusy(m.id)
      try {
        const json = await postJson({ action: 'update', id: m.id })
        toast.success(json?.note ?? `Updated ${m.name}`)
        await load()
        refreshModUpdates()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Update failed')
      } finally {
        setBusy(null)
      }
    },
    [postJson, load, refreshModUpdates],
  )

  // Update every staged mod we can actually pull (nexus needs Premium, steam a connected
  // account), sequentially — mirrors the server panel's "Update all" gating.
  const updateAll = useCallback(async () => {
    const targets = mods.filter(
      (m) => !!m.updateAvailable && ((m.source === 'nexus' && !!nexus?.premium) || (m.source === 'steam' && !!steam?.connected)),
    )
    if (!targets.length) return
    setBusy('update-all')
    let ok = 0
    let fail = 0
    for (const m of targets) {
      try {
        await postJson({ action: 'update', id: m.id })
        ok++
      } catch {
        fail++
      }
    }
    toast.success(`Updated ${ok} client mod(s)${fail ? `, ${fail} failed` : ''}.`)
    await load()
    refreshModUpdates()
    setBusy(null)
  }, [mods, nexus, steam, postJson, load, refreshModUpdates])

  // The chip shows for ANY available update; the one-click action only when we can pull it
  // (Nexus Premium / Steam connected) — same split the server panel uses.
  const canUpdate = (m: ClientMod) =>
    !!m.updateAvailable && ((m.source === 'nexus' && !!nexus?.premium) || (m.source === 'steam' && !!steam?.connected))
  const updateCount = mods.filter(canUpdate).length

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
      setConfigView('form')
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
      setConfigView('form')
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
  const activeMods = mods.filter((m) => m.keep)
  // Disabled block: most-recently-disabled first, so a just-flipped mod is at the top.
  const disabledMods = mods
    .filter((m) => !m.keep)
    .sort((a, b) => (b.keepChangedAt ?? 0) - (a.keepChangedAt ?? 0) || a.name.localeCompare(b.name))

  // Organize the staged list: name filter + sort (name / install date / source). Header counts
  // stay TRUE (unfiltered); only rendered rows are filtered/sorted/grouped. Sort applies to the
  // kept list; the disabled block keeps its recently-disabled order and is only filtered.
  const listQ = listQuery.trim().toLowerCase()
  const sourceKeyOf = (m: ClientMod): string | null =>
    (m.source === 'nexus' || m.source === 'steam') && m.sourceId ? `${m.source}:${m.sourceId}` : null
  const sourceLabelOf = (m: ClientMod): string => (m.source === 'nexus' ? 'Nexus' : m.source === 'steam' ? 'Steam' : 'Manual')
  const categoryOf = (m: ClientMod): string => {
    const k = sourceKeyOf(m)
    return (k && categories[k]) || 'Uncategorized'
  }
  const hasKbConflict = (m: ClientMod) => !!keybinds?.perMod[m.id]?.length
  const visibleActive = activeMods
    .filter((m) => (!listQ || m.name.toLowerCase().includes(listQ)) && (!conflictsOnly || hasKbConflict(m)))
    .sort(
    (a, b) => {
      switch (listSort) {
        case 'category': // grouped after; order rows within each group by name
        case 'name-asc':
          return a.name.localeCompare(b.name)
        case 'name-desc':
          return b.name.localeCompare(a.name)
        case 'added-desc':
          return (b.addedAt ?? 0) - (a.addedAt ?? 0)
        case 'added-asc':
          return (a.addedAt ?? 0) - (b.addedAt ?? 0)
        case 'source':
          return sourceLabelOf(a).localeCompare(sourceLabelOf(b)) || a.name.localeCompare(b.name)
        case 'type': {
          const rank: Record<ClientMod['kind'], number> = { ue4ss: 0, pak: 1, palschema: 2, unknown: 3 }
          return rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name)
        }
      }
    },
  )
  // #3: group the visible staged mods by genre category (Uncategorized last).
  const activeByCategory: [string, ClientMod[]][] = (() => {
    const map = new Map<string, ClientMod[]>()
    for (const m of visibleActive) {
      const arr = map.get(categoryOf(m)) ?? []
      arr.push(m)
      map.set(categoryOf(m), arr)
    }
    return [...map.entries()].sort(([a], [b]) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)))
  })()
  // Conflicts live only among KEPT mods, so the disabled block is irrelevant while filtering.
  const visibleDisabled = conflictsOnly
    ? []
    : listQ
      ? disabledMods.filter((m) => m.name.toLowerCase().includes(listQ))
      : disabledMods

  // One staged-mod row — reused by the Active list and the Disabled block.
  const renderRow = (m: ClientMod) => (
    <li
      key={m.id}
      className={`flex items-center justify-between gap-2 rounded px-3 py-2 ${m.id === lastToggledId ? 'ring-2 ring-amber-500/60' : ''}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="checkbox"
          checked={m.keep}
          disabled={busy === m.id}
          onChange={() => toggleKeep(m)}
          title={m.keep ? 'In the friend loadout — click the checkbox to exclude' : 'Excluded — click the checkbox to include'}
          className="size-4 shrink-0 cursor-pointer accent-primary"
        />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`truncate text-sm ${m.keep ? 'font-medium' : 'text-muted-foreground line-through'}`}>{m.name}</span>
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
            {keybinds?.perMod[m.id]?.length ? (
              <span
                title={
                  'Keybind conflict:\n' +
                  keybinds.perMod[m.id]!.map((c) => `${c.combo} — also used by: ${c.others.join(', ')}`).join('\n')
                }
                className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
              >
                <AlertTriangleIcon className="size-3" />
                {keybinds.perMod[m.id]!.map((c) => c.combo).join(', ')}
              </span>
            ) : null}
            {m.updateAvailable ? (
              <span
                title={m.source === 'nexus' && m.latestVersion ? `You have v${m.version}; Nexus has v${m.latestVersion}` : 'A newer Workshop build is available'}
                className="shrink-0 rounded bg-amber-500/20 px-1 text-[11px] font-medium text-amber-700 dark:text-amber-300"
              >
                ↑ update
              </span>
            ) : null}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {SOURCE_LABEL[m.source] ?? m.source} · {m.kind}
            {m.version ? ` · v${m.version}` : ''} · {formatBytes(m.sizeBytes)}
            {m.warn ? <span className="text-amber-500"> · won’t ship to clients</span> : ''}
            {!m.keep && m.keepChangedAt ? <span className="text-muted-foreground"> · disabled {timeAgo(m.keepChangedAt)}</span> : ''}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {canUpdate(m) ? (
          <button
            onClick={() => updateOne(m)}
            disabled={busy === m.id || busy === 'update-all'}
            title={m.source === 'nexus' && m.latestVersion ? `Download & install v${m.latestVersion} (re-sync the loadout to apply)` : 'Re-download the latest build (re-sync to apply)'}
            className="rounded bg-primary/15 px-1.5 py-1 text-xs font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
          >
            {busy === m.id ? 'updating…' : '↑ update now'}
          </button>
        ) : null}
        {(m.kind === 'ue4ss' || m.kind === 'unknown') && (
          <button
            onClick={() => openFiles(m)}
            title="Add extra files (music, textures, data) into a folder inside this mod — ships in the loadout"
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-primary/10 hover:text-primary"
          >
            <FolderPlusIcon className="size-3.5" />
            Files
          </button>
        )}
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
  )

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
          {keybinds && keybinds.conflicts.length > 0 && (
            <button
              type="button"
              onClick={() => setConflictsOnly((v) => !v)}
              aria-pressed={conflictsOnly}
              title={
                (conflictsOnly
                  ? 'Showing only mods with a keybind conflict — click to show all.\n\n'
                  : 'Click to show only the mods with a keybind conflict.\n\n') +
                keybinds.conflicts.map((c) => `${c.combo}: ${c.mods.join(', ')}`).join('\n')
              }
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                conflictsOnly
                  ? 'border-amber-500 bg-amber-500/30 text-amber-700 dark:text-amber-200'
                  : 'border-amber-500/50 bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400'
              }`}
            >
              <AlertTriangleIcon className="size-3.5" />
              {keybinds.conflicts.length} keybind conflict{keybinds.conflicts.length === 1 ? '' : 's'}
              {conflictsOnly ? ' · filtering' : ''}
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {updateCount > 0 && (
            <button
              onClick={updateAll}
              disabled={busy === 'update-all' || loading}
              title="Update every client mod that has a newer build (Nexus + Steam)"
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 px-2 py-1 text-sm font-medium text-amber-600 hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-400"
            >
              {busy === 'update-all' ? <Spinner className="size-3.5" /> : <span aria-hidden>↑</span>}
              Update all ({updateCount})
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:bg-muted disabled:opacity-50"
          >
            <RefreshCwIcon className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            Refresh
          </button>
        </div>
      </div>

      {/* Keybind auto-remap — shown when there are conflicts to fix or a remap is active */}
      {remap && keybinds && (keybinds.conflicts.length > 0 || remap.applied) && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <WandSparklesIcon className="size-4 text-amber-600 dark:text-amber-400" />
                Keybind auto-remap
                {remap.applied && (
                  <span className="rounded-full border border-emerald-500/50 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                    active
                  </span>
                )}
              </p>
              <p className="mt-1 text-muted-foreground">
                {remap.applied
                  ? 'Conflicting keys were moved to free keys and bundled into the loadout. Regenerate the loadout so friends get them.'
                  : 'Two client mods grab the same key — one silently loses on your friends’ machines. Auto-remap moves the loser to a free key as a loadout override; your payloads and the server stay untouched, and it’s reversible.'}
              </p>
              {remap.applied && keybinds.conflicts.length > 0 && (
                <p className="mt-1 text-amber-600 dark:text-amber-400">
                  {keybinds.conflicts.length} conflict{keybinds.conflicts.length === 1 ? '' : 's'} remain that the remap can’t
                  fix automatically (both mods hardcode the key, or a mod was added since).
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {remap.applied ? (
                <button
                  onClick={() => runRemap('remapClear')}
                  disabled={remapBusy}
                  className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 hover:bg-muted disabled:opacity-50"
                >
                  <RotateCcwIcon className={remapBusy ? 'size-3.5 animate-spin' : 'size-3.5'} />
                  Undo remap
                </button>
              ) : (
                <button
                  onClick={() => runRemap('remapApply')}
                  disabled={remapBusy}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/15 px-2 py-1 font-medium text-amber-700 hover:bg-amber-500/25 disabled:opacity-50 dark:text-amber-300"
                >
                  <WandSparklesIcon className={remapBusy ? 'size-3.5 animate-spin' : 'size-3.5'} />
                  Auto-remap conflicts
                </button>
              )}
            </div>
          </div>

          {/* What it changes — the full mapping, collapsed by default */}
          {(remap.remap.length > 0 || remap.payloadEdits.length > 0) && (
            <div className="mt-2">
              <button
                onClick={() => setRemapOpen((v) => !v)}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              >
                <ChevronDownIcon className={remapOpen ? 'size-3.5 rotate-180 transition' : 'size-3.5 transition'} />
                What it changes ({remap.remap.reduce((n, e) => n + e.pairs.length, 0) + remap.payloadEdits.length})
              </button>
              {remapOpen && (
                <ul className="mt-1.5 space-y-1 border-l-2 border-amber-500/30 pl-3">
                  {remap.remap.map((e) => (
                    <li key={`c-${e.modName}`}>
                      <span className="font-medium text-foreground">{e.modName}</span>
                      {': '}
                      {e.pairs.map(([from, to]) => `${from} → ${to}`).join(', ')}
                    </li>
                  ))}
                  {remap.payloadEdits.map((e) => (
                    <li key={`p-${e.modName}-${e.resolves}`}>
                      <span className="font-medium text-foreground">{e.modName}</span>
                      {': '}
                      {e.resolves}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

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

      {!hideUploader && (
      <>
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
      </>
      )}

      {/* Staged list — active (in the loadout) then a collapsible disabled block */}
      {mods.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              Staged for friends ({activeMods.length})
              {listQ ? <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">· {visibleActive.length} shown</span> : null}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Input
                value={listQuery}
                onChange={(e) => setListQuery(e.target.value)}
                placeholder="Filter by name…"
                aria-label="Filter client mods by name"
                className="h-8 w-40 text-xs sm:w-56"
              />
              <select
                value={listSort}
                onChange={(e) => setListSort(e.target.value as typeof listSort)}
                aria-label="Sort client mods"
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                <option value="category">Category (grouped)</option>
                <option value="name-asc">Name (A–Z)</option>
                <option value="name-desc">Name (Z–A)</option>
                <option value="added-desc">Recently added</option>
                <option value="added-asc">Oldest first</option>
                <option value="source">Source (Nexus/Steam)</option>
                <option value="type">Type (UE4SS/pak/…)</option>
              </select>
            </div>
          </div>
          {visibleActive.length > 0 ? (
            <details open className="rounded-md border">
              <summary className="cursor-pointer select-none border-b px-3 py-2 text-sm font-medium">
                Mods (Client) <span className="tabular-nums text-muted-foreground">({visibleActive.length})</span>
              </summary>
              {listSort === 'category' ? (
                <>
                  {activeByCategory.length > 1 && (
                    <div className="flex items-center gap-2 border-b bg-muted/10 px-3 py-1.5 text-xs">
                      <button
                        type="button"
                        onClick={() => setExpandedCats(new Set(activeByCategory.map(([c]) => c)))}
                        className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        Expand all
                      </button>
                      <span className="text-muted-foreground/50">·</span>
                      <button
                        type="button"
                        onClick={() => setExpandedCats(new Set())}
                        className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        Collapse all
                      </button>
                    </div>
                  )}
                  <div className="flex flex-col divide-y">
                    {activeByCategory.map(([cat, list]) => (
                      <details
                        key={cat}
                        open={expandedCats.has(cat)}
                        onToggle={(e) => {
                          const open = e.currentTarget.open
                          setExpandedCats((prev) => {
                            if (open === prev.has(cat)) return prev
                            const n = new Set(prev)
                            if (open) n.add(cat)
                            else n.delete(cat)
                            return n
                          })
                        }}
                      >
                        <summary className="cursor-pointer select-none bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                          {cat} <span className="tabular-nums">({list.length})</span>
                        </summary>
                        <ul className="flex flex-col divide-y">{list.map(renderRow)}</ul>
                      </details>
                    ))}
                  </div>
                </>
              ) : (
                <ul className="flex flex-col divide-y">{visibleActive.map(renderRow)}</ul>
              )}
            </details>
          ) : activeMods.length > 0 ? (
            <p className="text-xs text-muted-foreground">No kept mods match “{listQuery}”.</p>
          ) : null}
          {visibleDisabled.length > 0 && (
            <div className="flex flex-col gap-1">
              <button
                onClick={() => setShowDisabled((s) => !s)}
                className="flex items-center gap-1.5 self-start text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                <ChevronDownIcon className={showDisabled ? 'size-4 rotate-180 transition-transform' : 'size-4 transition-transform'} />
                Disabled — excluded from the loadout ({disabledMods.length})
              </button>
              {showDisabled && <ul className="flex flex-col divide-y rounded-md border opacity-70">{visibleDisabled.map(renderRow)}</ul>}
            </div>
          )}
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
              {(() => {
                // A .modconfig.json (DekModConfigMenu) is self-describing → render typed
                // widgets (sliders/toggles). Anything else, or unparseable JSON, stays raw.
                const selFile = configFiles.find((f) => f.id === configSel)
                let parsed: ConfigJson | null = null
                if (selFile && /\.modconfig\.json$/i.test(selFile.relWithin || configSel || '')) {
                  try {
                    const p = JSON.parse(configDraft)
                    if (hasModConfigSchema(p)) parsed = p as ConfigJson
                  } catch {
                    /* not valid JSON → raw only */
                  }
                }
                const formable = !!parsed
                const showForm = formable && configView === 'form'
                return (
                  <>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate font-mono">{configSel}</span>
                      {formable ? (
                        <div className="inline-flex shrink-0 overflow-hidden rounded-md border">
                          <button
                            onClick={() => setConfigView('form')}
                            className={`px-2 py-0.5 ${showForm ? 'bg-primary/15 text-primary' : 'hover:bg-muted'}`}
                          >
                            Form
                          </button>
                          <button
                            onClick={() => setConfigView('raw')}
                            className={`px-2 py-0.5 ${!showForm ? 'bg-primary/15 text-primary' : 'hover:bg-muted'}`}
                          >
                            Raw JSON
                          </button>
                        </div>
                      ) : (
                        <span>{selFile?.format}</span>
                      )}
                    </div>
                    {showForm && parsed ? (
                      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/20 p-3">
                        <ModConfigForm json={parsed} onChange={(next) => setConfigDraft(JSON.stringify(next, null, 2))} />
                      </div>
                    ) : (
                      <textarea
                        value={configDraft}
                        onChange={(e) => setConfigDraft(e.target.value)}
                        spellCheck={false}
                        className="min-h-0 flex-1 resize-none rounded-md border bg-muted/20 p-3 font-mono text-xs"
                      />
                    )}
                  </>
                )
              })()}
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

      {/* Extra-files editor — upload operator files into a mod folder; ships in the loadout. */}
      <Sheet open={!!filesMod} onOpenChange={(o) => !o && !filesBusy && setFilesMod(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <FolderPlusIcon className="size-4 text-primary" /> Extra files — {filesMod?.name}
            </SheetTitle>
          </SheetHeader>
          <p className="text-xs text-muted-foreground">
            Add your own files into a folder inside this mod (e.g. a music track into <code>music/Caelid</code>). They
            ship in the client loadout, so friends get them on their next loadout install. Max {formatBytes(filesMax)} per file.
            Or use <b>Bulk archive</b> to upload one or more archives (<code>.zip .7z .rar .tar .gz</code>) mirroring the
            mod&apos;s folders (e.g. <code>music/Caelid/track.mp3</code>) — select all parts of a split archive at once and
            they upload one at a time (each under the ~100 MB cap); they extract into place and the archives aren&apos;t kept.
            (<code>.7z</code>/<code>.rar</code> compress best, so more fits per part.)
          </p>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium">Destination folder (inside the mod)</label>
            <select
              value={filesFolders.includes(filesRel) ? filesRel : ''}
              onChange={(e) => setFilesRel(e.target.value)}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="">(mod root — or type a path below)</option>
              {filesFolders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <Input
              value={filesRel}
              onChange={(e) => setFilesRel(e.target.value)}
              placeholder="e.g. music/Caelid"
              className="h-8 text-xs"
            />
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault()
              if (!dragOver && !filesBusy) setDragOver(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              setDragOver(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              if (!filesBusy) void handleDrop(e.dataTransfer.files)
            }}
            className={`flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3 transition-colors ${
              dragOver ? 'border-primary bg-primary/5' : 'border-border'
            }`}
          >
            <input
              ref={filesInputRef}
              type="file"
              multiple
              onChange={(e) => void uploadFiles(e.target.files)}
              disabled={filesBusy}
              className="hidden"
            />
            <Button size="sm" disabled={filesBusy} onClick={() => filesInputRef.current?.click()} className="gap-1.5">
              {filesBusy ? <Spinner className="size-3.5" /> : <UploadIcon className="size-3.5" />}
              Upload to “{filesRel || 'mod root'}”
            </Button>
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip,.7z,.rar,.tar,.gz,.tgz"
              multiple
              onChange={(e) => void uploadZip(e.target.files)}
              disabled={filesBusy}
              className="hidden"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={filesBusy}
              onClick={() => zipInputRef.current?.click()}
              className="gap-1.5"
              title="Upload one or more archives (.zip/.7z/.rar/.tar/.gz) mirroring the mod's folders; each is extracted in place, processed one at a time"
            >
              <UploadIcon className="size-3.5" /> Bulk archive
            </Button>
            <span className="w-full text-[11px] text-muted-foreground sm:w-auto">
              …or <b>drag &amp; drop</b> files/archives here (archives extract in place; files go to “{filesRel || 'mod root'}”).
            </span>
          </div>

          {filesOverlay.files.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={filesOverlay.files.every((f) => filesSel.has(fileKey(f)))}
                  onChange={() =>
                    setFilesSel((prev) =>
                      filesOverlay.files.every((f) => prev.has(fileKey(f)))
                        ? new Set()
                        : new Set(filesOverlay.files.map(fileKey)),
                    )
                  }
                  className="size-3.5"
                />
                Select all ({filesOverlay.files.length})
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={filesBusy || filesSel.size === 0}
                onClick={() => void deleteSelected()}
                className="h-7 gap-1.5"
              >
                <Trash2Icon className="size-3.5" /> Delete selected ({filesSel.size})
              </Button>
              {filesOverlay.duplicates > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={filesBusy}
                  onClick={() => setFilesSel(new Set(filesOverlay.files.filter((f) => f.duplicate).map(fileKey)))}
                  className="h-7 gap-1.5 text-amber-600 hover:text-amber-600 dark:text-amber-400"
                  title="Select files that override ones the mod ships — handy for clearing an accidental whole-folder upload (leave intentional overrides like a config/gains file)"
                >
                  <AlertTriangleIcon className="size-3.5" /> Select overrides ({filesOverlay.duplicates})
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={filesBusy}
                onClick={() => setClearAllConfirm(true)}
                className="ml-auto h-7 text-destructive hover:text-destructive"
              >
                Clear all
              </Button>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
            {filesLoading ? (
              <div className="p-3 text-xs text-muted-foreground">Loading…</div>
            ) : filesOverlay.files.length === 0 ? (
              <div className="p-3 text-xs text-muted-foreground">No extra files added yet.</div>
            ) : (
              <ul className="divide-y">
                {filesOverlay.files.map((f) => (
                  <li key={`${f.rel}/${f.name}`} className="flex items-center gap-2 px-3 py-1.5">
                    <input
                      type="checkbox"
                      checked={filesSel.has(fileKey(f))}
                      onChange={() =>
                        setFilesSel((s) => {
                          const n = new Set(s)
                          const k = fileKey(f)
                          if (n.has(k)) n.delete(k)
                          else n.add(k)
                          return n
                        })
                      }
                      className="size-3.5 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs">{f.name}</span>
                        {f.duplicate && (
                          <span
                            className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
                            title="Overrides a file the mod ships — at build this replaces the mod's own copy. Intentional if you're customizing it (e.g. a config/gains file); if it was an accidental whole-folder upload, delete it."
                          >
                            overrides
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {f.rel || '(mod root)'} · {formatBytes(f.bytes)}
                      </div>
                    </div>
                    <button
                      onClick={() => void removeOverlayFile(f.rel, f.name)}
                      disabled={filesBusy}
                      title="Remove"
                      className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Total added: {formatBytes(filesOverlay.totalBytes)} · {filesOverlay.files.length} file(s). Effective after
            you regenerate the loadout.
          </p>
        </SheetContent>
      </Sheet>

      {/* Clear-all confirm for the extra-files overlay */}
      <AlertDialog open={clearAllConfirm} onOpenChange={(o) => !o && !filesBusy && setClearAllConfirm(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all extra files?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes every file you added to “{filesMod?.name}” ({filesOverlay.files.length} file(s),{' '}
              {formatBytes(filesOverlay.totalBytes)}). The mod itself is untouched; regenerate the loadout to apply.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={filesBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void clearAllFiles()} disabled={filesBusy}>
              Delete all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove confirm — the shared AlertDialog (not window.confirm) */}
      <AlertDialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this client mod?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRemove
                ? `"${confirmRemove.name}" will be removed from the client-mod set and won't ship in the loadout.` +
                  ((confirmRemove.source === 'nexus' || confirmRemove.source === 'steam') && confirmRemove.sourceId
                    ? ` If the same mod is installed on the server (same ${confirmRemove.source === 'nexus' ? 'Nexus' : 'Steam'} source), it will be removed there too.`
                    : ' This does not affect the server.')
                : ''}
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
