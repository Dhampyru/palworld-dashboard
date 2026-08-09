'use client'

import { useCallback, useEffect, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { isFrameworkDefault, frameworkDefaultDescription } from '@/lib/ue4ss-framework-defaults'
import { PalSchemaSection } from '@/components/palschema-section'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { PackageIcon, RefreshCwIcon, Trash2Icon, ShieldAlertIcon, ShieldCheckIcon, DownloadIcon, SlidersHorizontalIcon } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'


interface GameModEntry {
  id: string
  kind: 'ue4ss' | 'pak' | 'paldefender'
  name: string
  enabled: boolean
  hasConfig?: boolean
}

type ModConfigFileMeta = {
  id: string
  label: string
  format: 'json' | 'jsonc' | 'ini' | 'lua'
  editable: boolean
  exists: boolean
  isTemplate: boolean
  declared?: boolean
}

type Ue4ssSource = 'official' | 'experimental-palworld' | 'beta' | 'unknown'
type ModRegime = 'proxy' | 'workshop'
type Ue4ssStatus = {
  installed: boolean
  enabled: boolean
  running: boolean
  regime?: ModRegime // active injection regime (official-workshop-mods.md)
  injection?: 'dwmapi' | 'official'
  // staged on disk (what a swap installed / will load next boot)
  stagedSource: Ue4ssSource | null
  stagedVersion: string | null
  // live banner (only trusted when loaded === true)
  loaded: boolean
  source: Ue4ssSource | null
  version: string | null
  sha: string | null
  buildConfig: string | null
  pendingRestart: boolean
}


type NexusModRow = {
  modId: number
  name: string
  author: string | null
  latestVersion: string | null
  baselineVersion: string | null
  updateAvailable: boolean
  available: boolean
  url: string
}

// Steam Workshop exposes an update timestamp, not a version — render it as a date.
const fmtEpoch = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)

// PATCH (not upstream): this panel talks to /api/game-mods directly (NOT
// through useServer().apiCall, which is hardwired to proxy the Palworld REST
// API) since mod listing is filesystem-backed, not something the game's REST
// API exposes at all. Same auth header, different route(s).
// The panel is now the installed-mods LIST only — the "Install a Mod" card and the UE4SS
// Loader are hoisted above the tabs (the unified uploader + Ue4ssLoaderCard). `reloadKey`
// lets those refresh this list after a change.
export function GameModsPanel({ reloadKey }: { reloadKey?: number } = {}) {
  const { config, connectionStatus } = useServer()
  const [mods, setMods] = useState<GameModEntry[] | null>(null)
  const [modGroups, setModGroups] = useState<Record<string, string[]>>({})
  const [steamLinks, setSteamLinks] = useState<Record<string, { itemId: string; name: string | null }>>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<GameModEntry | null>(null)
  const [disableWarnTarget, setDisableWarnTarget] = useState<GameModEntry | null>(null)

  // Mod Config Editor (docs/specs/mod-config-editor.md) — per-mod config file editor.
  const [configMod, setConfigMod] = useState<GameModEntry | null>(null)
  const [configFiles, setConfigFiles] = useState<ModConfigFileMeta[] | null>(null)
  const [configActiveId, setConfigActiveId] = useState<string | null>(null)
  const [configText, setConfigText] = useState('')
  const [configDirty, setConfigDirty] = useState(false)
  const [configBusy, setConfigBusy] = useState(false)
  const [configOverridden, setConfigOverridden] = useState(false)
  const [configDeclared, setConfigDeclared] = useState(false)

  const [pakDownloading, setPakDownloading] = useState<string | null>(null)

  // Nexus association state (docs/specs/nexus-integration.md). Dormant unless a
  // valid key is connected (Panel Settings → Nexus).
  const [nexusConnected, setNexusConnected] = useState(false)
  const [nexusMods, setNexusMods] = useState<Record<string, NexusModRow>>({})
  const [nexusBusy, setNexusBusy] = useState<string | null>(null)
  const [steamUpdates, setSteamUpdates] = useState<
    Record<string, { installedAt: number | null; latestAt: number; updateAvailable: boolean; title: string }>
  >({})
  const [steamBusy, setSteamBusy] = useState<string | null>(null)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [nestPickerFor, setNestPickerFor] = useState<string | null>(null)
  const [nestBusy, setNestBusy] = useState<string | null>(null)
  const [linkTarget, setLinkTarget] = useState<string | null>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkHaveVersion, setLinkHaveVersion] = useState('')
  // Nexus Premium + Steam account state (gates the update-now actions in the list).
  const [nexusPremium, setNexusPremium] = useState(false)
  const [steamConnected, setSteamConnected] = useState(false)

  const loadNexus = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/nexus/mods', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (res.ok) {
        setNexusConnected(Boolean(json.connected))
        setNexusPremium(Boolean(json.isPremium))
        setNexusMods((json.mods as Record<string, NexusModRow>) ?? {})
      }
    } catch {
      /* leave dormant */
    }
  }, [config])

  const loadSteam = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/steam', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setSteamConnected(Boolean(json.status?.connected))
    } catch {
      /* leave dormant */
    }
    // Workshop update state (installed acf time vs Steam's live time). Uses Steam's
    // public API, so it works even with no connected account (only the one-click
    // update needs a session). Best-effort — no chips if the check fails.
    try {
      const res = await fetch('/api/steam/workshop', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setSteamUpdates(json.updates ?? {})
    } catch {
      /* no update chips */
    }
  }, [config])


  const nexusAction = useCallback(
    async (key: string, body: object, okMsg?: string): Promise<boolean> => {
      if (!config) return false
      setNexusBusy(key)
      try {
        const res = await fetch('/api/nexus/mods', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Failed')
        setNexusMods((json.mods as Record<string, NexusModRow>) ?? {})
        setNexusConnected(Boolean(json.connected))
        if (okMsg) toast.success(okMsg)
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed')
        return false
      } finally {
        setNexusBusy(null)
      }
    },
    [config],
  )

  const doLink = useCallback(async () => {
    if (!linkTarget || !linkUrl.trim()) return
    const ok = await nexusAction(
      `link:${linkTarget}`,
      { action: 'link', modKey: linkTarget, url: linkUrl.trim(), haveVersion: linkHaveVersion.trim() || undefined },
      'Linked to Nexus',
    )
    if (ok) {
      setLinkTarget(null)
      setLinkUrl('')
      setLinkHaveVersion('')
    }
  }, [linkTarget, linkUrl, linkHaveVersion, nexusAction])

  // Download a pak file so the admin can hand it to players (hybrid/pak mods need
  // the .pak on every client too). Auth is header-based, so a plain <a download>
  // can't carry it — fetch as a blob and trigger the save.
  const downloadPak = useCallback(
    async (name: string) => {
      if (!config) return
      setPakDownloading(name)
      try {
        const res = await fetch(`/api/game-mods/pak?name=${encodeURIComponent(name)}`, {
          headers: buildPalworldProxyHeaders(config),
          cache: 'no-store',
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error ?? res.statusText)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Download failed')
      } finally {
        setPakDownloading(null)
      }
    },
    [config],
  )

  const [ue4ss, setUe4ss] = useState<Ue4ssStatus | null>(null)

  const loadUe4ss = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/game-mods/ue4ss', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok) setUe4ss(json.status as Ue4ssStatus)
    } catch {
      /* leave null */
    }
  }, [config])

  const [palschemaReload, setPalschemaReload] = useState(0)

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/game-mods', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      setMods(data.mods)
      setModGroups((data.groups as Record<string, string[]>) ?? {})
      setSteamLinks((data.steamLinks as Record<string, { itemId: string; name: string | null }>) ?? {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load mods')
    } finally {
      setLoading(false)
    }
  }, [config])

  // Refresh the list when the unified uploader (above the tabs) commits an install.
  useEffect(() => {
    if (!reloadKey) return
    load()
    loadNexus()
    loadSteam()
    setPalschemaReload((n) => n + 1) // refresh the PalSchema section after a shared-uploader commit
  }, [reloadKey, load, loadNexus, loadSteam])



  // One-click update: re-download the item (SteamCMD pulls the latest) and re-convert
  // to the proxy layout — same path as install. Needs a connected account. Restart to
  // apply. Mirrors the Nexus "update now".
  const updateSteamMod = useCallback(
    async (itemId: string) => {
      if (!config) return
      setSteamBusy(`update:${itemId}`)
      const toastId = toast.loading('Updating from Steam Workshop…')
      try {
        const res = await fetch('/api/steam/workshop', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: itemId }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Update failed')
        toast.success('Updated to the latest — restart the server to apply.', { id: toastId })
        await load()
        await loadSteam()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Update failed', { id: toastId })
      } finally {
        setSteamBusy(null)
      }
    },
    [config, load, loadSteam],
  )


  // One-click update (Premium): reinstall a linked mod's latest Nexus file and
  // bump its baseline. Uses the same download+install pipeline as a fresh install.
  const updateNexusMod = useCallback(
    async (modKey: string) => {
      if (!config) return
      setNexusBusy(`update:${modKey}`)
      const toastId = toast.loading('Downloading & installing update…')
      try {
        const res = await fetch('/api/nexus/install', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', modKey }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Update failed')
        toast.success((json.note as string) ?? 'Updated from Nexus', { id: toastId })
        await load()
        await loadNexus()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Update failed', { id: toastId })
      } finally {
        setNexusBusy(null)
      }
    },
    [config, load, loadNexus],
  )

  // Update every mod that has an update available — Nexus (Premium) and Steam Workshop
  // (connected) both, sequentially (avoid races + rate limits), with one progress toast
  // and a single refresh at the end. Restart to apply, like any mod change.
  const updateAllMods = useCallback(async () => {
    if (!config) return
    const nexusKeys = nexusPremium
      ? Object.entries(nexusMods).filter(([, v]) => v.updateAvailable).map(([k]) => k)
      : []
    const steamIds = steamConnected
      ? Object.entries(steamUpdates).filter(([, v]) => v.updateAvailable).map(([id]) => id)
      : []
    const total = nexusKeys.length + steamIds.length
    if (!total) return
    setUpdatingAll(true)
    let done = 0
    let failed = 0
    const toastId = toast.loading(`Updating 0/${total} mods…`)
    const post = async (url: string, body: unknown) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
    }
    for (const modKey of nexusKeys) {
      try {
        await post('/api/nexus/install', { action: 'update', modKey })
        done++
      } catch {
        failed++
      }
      toast.loading(`Updating ${done + failed}/${total} mods…`, { id: toastId })
    }
    for (const itemId of steamIds) {
      try {
        await post('/api/steam/workshop', { url: itemId })
        done++
      } catch {
        failed++
      }
      toast.loading(`Updating ${done + failed}/${total} mods…`, { id: toastId })
    }
    const msg = `Updated ${done}/${total}${failed ? `, ${failed} failed` : ''} — restart the server to apply.`
    if (done) toast.success(msg, { id: toastId })
    else toast.error(msg, { id: toastId })
    await load()
    await loadNexus()
    await loadSteam()
    setUpdatingAll(false)
  }, [config, nexusMods, nexusPremium, steamUpdates, steamConnected, load, loadNexus, loadSteam])


  useEffect(() => {
    load()
    void loadUe4ss()
    void loadNexus()
    void loadSteam()
  }, [load, loadUe4ss, loadNexus, loadSteam])

  // Poll UE4SS status so the running/loaded state (banner vs boot time) updates on
  // its own after a restart — a swap stages instantly, but "now running the new
  // build" only becomes true once the server reboots. No manual reload needed.
  useEffect(() => {
    const id = setInterval(() => void loadUe4ss(), 15000)
    return () => clearInterval(id)
  }, [loadUe4ss])

  // PATCH (not upstream): PalDefender status -- not a mod itself (no mods.txt
  // entry, not filesystem-toggleable like the list below), so this is purely
  // informational: is it installed and reachable, and what version. Fails
  // silently and shows nothing when not installed/configured, same
  // graceful-degradation principle used everywhere else PalDefender appears.
  const [pdVersion, setPdVersion] = useState<string | null>(null)
  const [pdChecked, setPdChecked] = useState(false)

  useEffect(() => {
    if (!config) return
    let cancelled = false
    ;(async () => {
      try {
        const headers = new Headers(buildPalworldProxyHeaders(config))
        const res = await fetch('/api/paldefender/version', { headers, cache: 'no-store' })
        if (!res.ok) throw new Error('not reachable')
        const data = await res.json()
        const v = data?.Version?.Version
        if (!cancelled) setPdVersion(typeof v === 'string' ? v : null)
      } catch {
        if (!cancelled) setPdVersion(null)
      } finally {
        if (!cancelled) setPdChecked(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [config])

  const doToggle = useCallback(
    async (mod: GameModEntry, nextEnabled: boolean) => {
      if (!config) return
      setPendingId(mod.id)
      // optimistic update — reverted on failure
      setMods((prev) => prev?.map((m) => (m.id === mod.id ? { ...m, enabled: nextEnabled } : m)) ?? prev)
      try {
        const response = await fetch('/api/game-mods', {
          method: 'POST',
          headers: {
            ...buildPalworldProxyHeaders(config),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ id: mod.id, enabled: nextEnabled }),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? response.statusText)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to toggle mod')
        setMods((prev) => prev?.map((m) => (m.id === mod.id ? { ...m, enabled: mod.enabled } : m)) ?? prev)
      } finally {
        setPendingId(null)
      }
    },
    [config]
  )

  // Turning a framework default OFF gets an extra confirmation step first —
  // other mods may silently depend on it. Turning one ON, and toggling any
  // regular mod either direction, proceeds immediately as before.
  const toggle = useCallback(
    (mod: GameModEntry, nextEnabled: boolean) => {
      if (!nextEnabled && isFrameworkDefault(mod.kind, mod.name)) {
        setDisableWarnTarget(mod)
        return
      }
      doToggle(mod, nextEnabled)
    },
    [doToggle]
  )

  const confirmDisableFrameworkDefault = useCallback(() => {
    if (!disableWarnTarget) return
    const target = disableWarnTarget
    setDisableWarnTarget(null)
    doToggle(target, false)
  }, [disableWarnTarget, doToggle])

  // ── Mod config editor ─────────────────────────────────────────────────────
  const loadConfigFile = useCallback(
    async (modName: string, file: ModConfigFileMeta) => {
      if (!config) return
      setConfigActiveId(file.id)
      setConfigText('')
      setConfigDirty(false)
      if (!file.exists) return
      try {
        const res = await fetch(
          `/api/mod-config?mod=${encodeURIComponent(modName)}&file=${encodeURIComponent(file.id)}`,
          { headers: buildPalworldProxyHeaders(config), cache: 'no-store' },
        )
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? res.statusText)
        setConfigText(data.content ?? '')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to read config file')
      }
    },
    [config],
  )

  const openConfig = useCallback(
    async (mod: GameModEntry) => {
      if (!config) return
      setConfigMod(mod)
      setConfigFiles(null)
      setConfigActiveId(null)
      setConfigText('')
      setConfigDirty(false)
      try {
        const res = await fetch(`/api/mod-config?mod=${encodeURIComponent(mod.name)}`, {
          headers: buildPalworldProxyHeaders(config),
          cache: 'no-store',
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? res.statusText)
        const files: ModConfigFileMeta[] = data.files ?? []
        setConfigFiles(files)
        setConfigOverridden(data.overridden === true)
        setConfigDeclared(data.declared === true)
        // Auto-open the first editable file so the common case is one click.
        const first = files.find((f) => f.editable && f.exists) ?? files[0]
        if (first) await loadConfigFile(mod.name, first)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load mod config')
        setConfigFiles([])
      }
    },
    [config, loadConfigFile],
  )

  const saveConfig = useCallback(async () => {
    if (!config || !configMod || !configActiveId) return
    setConfigBusy(true)
    try {
      const res = await fetch('/api/mod-config', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mod: configMod.name, file: configActiveId, content: configText }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? res.statusText)
      setConfigDirty(false)
      toast.success('Saved — restart the server to apply.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setConfigBusy(false)
    }
  }, [config, configMod, configActiveId, configText])

  const createConfig = useCallback(
    async (file: ModConfigFileMeta) => {
      if (!config || !configMod) return
      setConfigBusy(true)
      try {
        const res = await fetch('/api/mod-config', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ mod: configMod.name, file: file.id, action: 'create' }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? res.statusText)
        toast.success('Config created from template.')
        await openConfig(configMod) // re-discover so it's now editable
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Create failed')
      } finally {
        setConfigBusy(false)
      }
    },
    [config, configMod, openConfig],
  )

  const setConfigOverrideFor = useCallback(
    async (action: 'setOverride' | 'clearOverride', fileId?: string) => {
      if (!config || !configMod) return
      setConfigBusy(true)
      try {
        const res = await fetch('/api/mod-config', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ mod: configMod.name, action, file: fileId ?? '' }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? res.statusText)
        toast.success(action === 'setOverride' ? 'Set as this mod’s config.' : 'Override cleared.')
        await openConfig(configMod) // re-discover with the new override
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed')
      } finally {
        setConfigBusy(false)
      }
    },
    [config, configMod, openConfig],
  )

  // Manually (re)parent a mod: nest a floating pak under a chosen mod, or un-nest.
  // Display-only grouping (data/mod-groups.json) — no files move, no restart needed.
  const nestUnder = useCallback(
    async (child: string, parent: string | null) => {
      if (!config) return
      setNestBusy(child)
      try {
        const res = await fetch('/api/game-mods/group', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ child, parent }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? res.statusText)
        toast.success(parent ? 'Nested under the parent mod.' : 'Un-nested.')
        await load()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to group')
      } finally {
        setNestBusy(null)
      }
    },
    [config, load],
  )

  const confirmRemove = useCallback(async () => {
    if (!config || !removeTarget) return
    const target = removeTarget
    setPendingId(target.id)
    try {
      const response = await fetch('/api/game-mods', {
        method: 'DELETE',
        headers: {
          ...buildPalworldProxyHeaders(config),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: target.id }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      setMods((prev) => prev?.filter((m) => m.id !== target.id) ?? prev)
      toast.success(`Removed ${target.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove mod')
    } finally {
      setPendingId(null)
      setRemoveTarget(null)
    }
  }, [config, removeTarget])


  // Version-gating for the three install kinds (spec §3). pak is always fine;
  // UE4SS mods need an active loader; PalSchema mods need the experimental build.
  const ue4ssActive = Boolean(ue4ss?.installed && ue4ss?.enabled)
  // UE4SS installed but toggled OFF (dwmapi proxy renamed aside) → nothing that
  // runs THROUGH UE4SS will load. Used to visually disable UE4SS-dependent mod UI.
  // (Pak mods and PalDefender don't go through UE4SS, so they stay active.)
  const ue4ssDisabled = Boolean(ue4ss?.installed && !ue4ss?.enabled)
  // Gate PalSchema install on the STAGED build — you can install PalSchema once
  // its UE4SS build is on disk, even before the restart that loads it.
  const palschemaReady = ue4ss?.stagedSource === 'experimental-palworld'

  // A single mod row, reused for the main list, the collapsed built-ins, and (with
  // opts.nested) as a bundled child under a hybrid mod's parent row.
  const renderModRow = (
    mod: GameModEntry,
    opts: { nested?: boolean; childrenNode?: React.ReactNode } = {},
  ) => {
    const { nested = false, childrenNode = null } = opts
    // Candidate parents to nest a floating pak under (other top-level mods).
    const nestCandidates =
      !nested && mod.kind === 'pak'
        ? (mods ?? []).filter(
            (m) =>
              m.id !== mod.id &&
              (m.kind === 'ue4ss' || m.kind === 'pak') &&
              !new Set(Object.values(modGroups).flat()).has(m.id),
          )
        : []
    const isDefault = isFrameworkDefault(mod.kind, mod.name)
    const description = frameworkDefaultDescription(mod.kind, mod.name)
    const inert = ue4ssDisabled && mod.kind === 'ue4ss' // can't load while the loader is off
    // Steam Workshop link: shown for mods installed from the Workshop (parallel of
    // the Nexus link). A Steam-linked mod does NOT offer the Nexus chip.
    const steamLink = steamLinks[mod.id]
    // Nexus chip: only for the operator's own top-level pak/UE4SS mods (nested
    // children ignore Nexus linking — the parent owns it), not Steam-linked, connected.
    const nx = nexusMods[mod.id]
    const showNexus =
      !nested && nexusConnected && !isDefault && !steamLink && (mod.kind === 'pak' || mod.kind === 'ue4ss')
    return (
      <li key={mod.id} className={`flex flex-col${inert ? ' opacity-50' : ''}`}>
        <div className={`flex items-center justify-between gap-3 px-3 py-2${nested ? ' pl-8' : ''}`}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <Badge variant={mod.kind === 'pak' ? 'secondary' : 'default'}>
              {mod.kind === 'ue4ss' ? 'UE4SS' : mod.kind === 'paldefender' ? 'PalDefender' : 'pak'}
            </Badge>
            {isDefault && (
              <Badge variant="outline" className="border-amber-500/50 text-amber-400">
                Built-in
              </Badge>
            )}
            <span className="truncate text-sm">{mod.name}</span>
            {inert && <span className="text-[10px] uppercase tracking-wide text-amber-500">inactive</span>}
          </div>
          {description && <p className="pl-0.5 text-xs text-muted-foreground">{description}</p>}
          {!nested && steamLink && (
            <div className="flex flex-wrap items-center gap-2 pl-0.5 text-[11px]">
              <a
                href={`https://steamcommunity.com/sharedfiles/filedetails/?id=${steamLink.itemId}`}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
              >
                Steam Workshop ↗
              </a>
              {steamUpdates[steamLink.itemId]?.updateAvailable && (
                <>
                  <span
                    className="rounded bg-amber-500/20 px-1 font-medium text-amber-700 dark:text-amber-300"
                    title={`Workshop updated ${fmtEpoch(steamUpdates[steamLink.itemId].latestAt)}; you installed ${
                      steamUpdates[steamLink.itemId].installedAt ? fmtEpoch(steamUpdates[steamLink.itemId].installedAt!) : '?'
                    }`}
                  >
                    ↑ update
                  </span>
                  {steamConnected && (
                    <button
                      onClick={() => updateSteamMod(steamLink.itemId)}
                      disabled={steamBusy === `update:${steamLink.itemId}`}
                      title="Re-download the latest from Steam Workshop (restart to apply)"
                      className="rounded bg-primary/15 px-1 font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
                    >
                      {steamBusy === `update:${steamLink.itemId}` ? 'updating…' : '↑ update now'}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          {showNexus &&
            (nx ? (
              <div className="flex flex-wrap items-center gap-2 pl-0.5 text-[11px]">
                <a
                  href={nx.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
                  title={nx.author ? `by ${nx.author}` : undefined}
                >
                  Nexus{nx.latestVersion ? ` v${nx.latestVersion}` : ''} ↗
                </a>
                {nx.updateAvailable && (
                  <span
                    className="rounded bg-amber-500/20 px-1 font-medium text-amber-700 dark:text-amber-300"
                    title={`You have v${nx.baselineVersion}; Nexus has v${nx.latestVersion}`}
                  >
                    ↑ update
                  </span>
                )}
                {nx.updateAvailable && nexusPremium && (
                  <button
                    onClick={() => updateNexusMod(mod.id)}
                    disabled={nexusBusy === `update:${mod.id}`}
                    title={`Download & install v${nx.latestVersion} from Nexus (restart to apply)`}
                    className="rounded bg-primary/15 px-1 font-medium text-primary hover:bg-primary/25 disabled:opacity-40"
                  >
                    {nexusBusy === `update:${mod.id}` ? 'updating…' : '↑ update now'}
                  </button>
                )}
                {nx.updateAvailable && (
                  <button
                    onClick={() => nexusAction(`seen:${mod.id}`, { action: 'markSeen', modKey: mod.id }, 'Marked up to date')}
                    disabled={nexusBusy === `seen:${mod.id}`}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                  >
                    mark seen
                  </button>
                )}
                <button
                  onClick={() => nexusAction(`unlink:${mod.id}`, { action: 'unlink', modKey: mod.id }, 'Unlinked')}
                  disabled={nexusBusy === `unlink:${mod.id}`}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                >
                  unlink
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setLinkTarget(mod.id)
                  setLinkUrl('')
                  setLinkHaveVersion('')
                }}
                className="w-fit pl-0.5 text-[11px] text-muted-foreground hover:text-primary"
              >
                + Link to Nexus
              </button>
            ))}
          {/* Nest under a parent — un-nest a bundled child, or nest a floating pak under
              a chosen mod (for mods whose paks arrived as a separate download). */}
          {nested ? (
            <button
              onClick={() => nestUnder(mod.id, null)}
              disabled={nestBusy === mod.id}
              className="w-fit pl-0.5 text-[11px] text-muted-foreground hover:text-primary disabled:opacity-40"
            >
              un-nest
            </button>
          ) : (
            mod.kind === 'pak' &&
            nestCandidates.length > 0 &&
            (nestPickerFor === mod.id ? (
              <select
                autoFocus
                defaultValue=""
                disabled={nestBusy === mod.id}
                onChange={(e) => {
                  const v = e.target.value
                  setNestPickerFor(null)
                  if (v) nestUnder(mod.id, v)
                }}
                onBlur={() => setNestPickerFor(null)}
                className="w-fit rounded border bg-background px-1 py-0.5 text-[11px]"
              >
                <option value="" disabled>
                  nest under…
                </option>
                {nestCandidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <button
                onClick={() => setNestPickerFor(mod.id)}
                title="Group this pak under its parent mod (paks that came as a separate download)"
                className="w-fit pl-0.5 text-[11px] text-muted-foreground hover:text-primary"
              >
                ↳ nest under a mod
              </button>
            ))
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {mod.kind === 'ue4ss' && mod.hasConfig && (
            <button
              onClick={() => openConfig(mod)}
              title={`Edit ${mod.name} config`}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-primary/10 hover:text-primary"
              aria-label={`Edit ${mod.name} config`}
            >
              <SlidersHorizontalIcon className="size-4" />
            </button>
          )}
          {mod.kind === 'pak' && (
            <button
              onClick={() => downloadPak(mod.name)}
              disabled={pakDownloading === mod.name}
              title={`Download ${mod.name} — hand this to players (hybrid/pak mods need it on each client)`}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-primary/10 hover:text-primary disabled:opacity-30"
              aria-label={`Download ${mod.name}`}
            >
              {pakDownloading === mod.name ? <Spinner className="size-4" /> : <DownloadIcon className="size-4" />}
            </button>
          )}
          <Switch
            checked={mod.enabled}
            disabled={pendingId === mod.id || inert}
            onCheckedChange={(checked) => toggle(mod, checked)}
          />
          <button
            onClick={() => !isDefault && setRemoveTarget(mod)}
            disabled={pendingId === mod.id || isDefault}
            title={isDefault ? "Built-in — can't be removed here" : `Remove ${mod.name}`}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            aria-label={isDefault ? `${mod.name} is built-in and can't be removed here` : `Remove ${mod.name}`}
          >
            <Trash2Icon className="size-4" />
          </button>
        </div>
        </div>
        {childrenNode}
      </li>
    )
  }

  // Split UE4SS's bundled framework/dev mods off into a collapsed group so the
  // operator's OWN mods (+ PalDefender, pak mods) lead the list. PalDefender is a
  // built-in too but stays up top — it's not UE4SS framework plumbing.
  const isUe4ssBuiltin = (m: GameModEntry) => m.kind === 'ue4ss' && isFrameworkDefault(m.kind, m.name)
  const builtinMods = mods?.filter(isUe4ssBuiltin) ?? []
  // Hybrid grouping: nested children (e.g. a hybrid's pak) render under their
  // parent, not as separate top-level rows.
  const modByKey: Record<string, GameModEntry> = Object.fromEntries((mods ?? []).map((m) => [m.id, m]))
  const childKeys = new Set(Object.values(modGroups).flat())
  const userMods = (mods ?? []).filter((m) => !isUe4ssBuiltin(m) && !childKeys.has(m.id))
  const renderUserMod = (mod: GameModEntry) => {
    const children = (modGroups[mod.id] ?? []).map((k) => modByKey[k]).filter(Boolean)
    const childrenNode = children.length ? (
      <details className="border-t border-border/40">
        <summary className="cursor-pointer select-none px-3 py-1 pl-8 text-[11px] text-muted-foreground">
          {children.length} bundled file{children.length > 1 ? 's' : ''} (part of this mod)
        </summary>
        <ul className="flex flex-col divide-y">{children.map((c) => renderModRow(c, { nested: true }))}</ul>
      </details>
    ) : null
    return renderModRow(mod, { childrenNode })
  }

  // Count of mods with an actionable update (Nexus needs Premium; Steam needs a session).
  const updateCount =
    (nexusPremium ? Object.values(nexusMods).filter((v) => v.updateAvailable).length : 0) +
    (steamConnected ? Object.values(steamUpdates).filter((v) => v.updateAvailable).length : 0)

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PackageIcon className="size-5" />
          <h2 className="text-lg font-semibold">Mods</h2>
        </div>
        <div className="flex items-center gap-2">
          {updateCount > 0 && (
            <button
              onClick={updateAllMods}
              disabled={updatingAll}
              title="Update every Nexus/Workshop mod with an update available"
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 px-2 py-1 text-sm font-medium text-amber-600 hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-400"
            >
              {updatingAll ? <Spinner className="size-3.5" /> : <span aria-hidden>↑</span>}
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

      <p className="text-muted-foreground text-sm">
        Toggling, installing, or removing a mod takes effect on the next server restart. All three require an
        admin-tier password — a mod-tier login can view this list but not change it.
      </p>

      {/* UE4SS Loader (spec docs/specs/ue4ss-loader.md) — loaded build + enable/disable.
          Version install/swap buttons land in a later phase. */}
      {/* Unified "Installed Mods" card: the PalSchema panel + the installed mod list
          in one bordered block (PalSchema: docs/specs/palschema-support.md, paired
          with / version-locked to the UE4SS build the loader above reports). */}
      <div className="flex flex-col rounded-md border">
        <div className="border-b px-3 py-2">
          <h3 className="text-sm font-semibold">Installed Mods</h3>
        </div>
        <div className="flex flex-col gap-3 p-3">
          <PalSchemaSection
            palschemaLoaded={Boolean(ue4ss?.loaded && ue4ss?.source === 'experimental-palworld')}
            buildStaged={palschemaReady}
            pendingRestart={Boolean(ue4ss?.pendingRestart)}
            ue4ssEnabled={ue4ssActive}
            reloadSignal={palschemaReload}
            embedded
          />

          {/* PATCH (not upstream): PalDefender is a separate install (its own DLL,
              not managed through mods.txt), shown here purely informationally. */}
          {pdChecked && (
            <div
              className={
                pdVersion
                  ? 'flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400'
                  : 'flex items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-sm text-muted-foreground'
              }
            >
              {pdVersion ? <ShieldCheckIcon className="size-4 shrink-0" /> : <ShieldAlertIcon className="size-4 shrink-0" />}
              {pdVersion
                ? `PalDefender v${pdVersion} — active`
                : connectionStatus === 'connected'
                  ? 'PalDefender not detected'
                  : 'PalDefender version unavailable — server offline (its files are intact; see the mod list)'}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {loading && !mods && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading installed mods…
            </div>
          )}

          {mods && mods.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No mods found. UE4SS mods go in <code>Pal/Binaries/Win64/Mods/</code> (or{' '}
              <code>ue4ss/Mods/</code>); pak mods go in <code>Pal/Content/Paks/~mods/</code>.
            </p>
          )}

          {ue4ssDisabled && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                UE4SS is <span className="font-medium">disabled</span> — UE4SS &amp; PalSchema mods are inactive and
                won&apos;t load until you re-enable it in the loader above. Pak mods and PalDefender are unaffected.
              </span>
            </div>
          )}

          {mods && mods.length > 0 && (
            <div className="flex flex-col gap-2 border-t pt-3">
              {userMods.length > 0 ? (
                <ul className="flex flex-col divide-y rounded-md border">{userMods.map(renderUserMod)}</ul>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No installed mods yet — only UE4SS built-ins are present.
                </p>
              )}
              {builtinMods.length > 0 && (
                <details className="rounded-md border">
                  <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground">
                    UE4SS built-in mods ({builtinMods.length}) — framework plumbing &amp; dev tools bundled with UE4SS
                  </summary>
                  <ul className="flex flex-col divide-y border-t">{builtinMods.map((m) => renderModRow(m))}</ul>
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Extra confirmation specifically for disabling a UE4SS framework default */}
      <AlertDialog
        open={!!disableWarnTarget}
        onOpenChange={(open) => !open && setDisableWarnTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlertIcon className="size-5 text-amber-400" />
              Disable {disableWarnTarget?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This is a component UE4SS bundles by default, not a mod you installed.
              {disableWarnTarget && frameworkDefaultDescription(disableWarnTarget.kind, disableWarnTarget.name) && (
                <> {frameworkDefaultDescription(disableWarnTarget.kind, disableWarnTarget.name)}</>
              )}{' '}
              Other mods you've installed may depend on it — disabling it can break them in ways that aren't
              obvious from this list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDisableFrameworkDefault}
              className="bg-amber-600 text-white hover:bg-amber-500"
            >
              Disable Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!removeTarget} onOpenChange={(open) => !pendingId && !open && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the mod's files from the server — including any paks it shipped — and can't
              be undone (takes effect on the next server restart). If the same mod is also staged for clients, that
              client copy is removed too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!pendingId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRemove}
              disabled={!!pendingId}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pendingId ? <Spinner className="mr-2 size-4" /> : null}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Link a mod to its Nexus page for version/update watching. */}
      <AlertDialog open={linkTarget !== null} onOpenChange={(o) => !o && setLinkTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Link to a Nexus mod</AlertDialogTitle>
            <AlertDialogDescription>
              Paste the mod&apos;s Nexus page URL. Optionally enter the version you currently have to get an
              &ldquo;update available&rdquo; flag; leave it blank to just watch for future releases.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2">
            <Input
              placeholder="https://www.nexusmods.com/palworld/mods/1135"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
            />
            <Input
              placeholder="version you have (optional, e.g. 0.1.2)"
              value={linkHaveVersion}
              onChange={(e) => setLinkHaveVersion(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={doLink} disabled={!linkUrl.trim() || nexusBusy === `link:${linkTarget}`}>
              {nexusBusy === `link:${linkTarget}` ? <Spinner className="mr-2 size-4" /> : null}
              Link
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mod config editor */}
      <Sheet open={configMod !== null} onOpenChange={(o) => !o && setConfigMod(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Configure {configMod?.name}</SheetTitle>
          </SheetHeader>
          <p className="text-xs text-muted-foreground">
            Edit this mod&apos;s own config files. Changes take effect on the next server restart.
            Edits are validated (JSON/INI/Lua) before saving. A ★ marks the file the mod&apos;s
            own description names as its config.
          </p>
          {configFiles === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading…
            </div>
          ) : configFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">No config files found for this mod.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {configFiles.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => configMod && loadConfigFile(configMod.name, f)}
                    className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
                      f.id === configActiveId
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted/40'
                    }`}
                  >
                    {f.label}
                    {f.declared && <span className="ml-1 opacity-60" title="Named as the config by the mod's description">★</span>}
                    {f.isTemplate && <span className="ml-1 opacity-60">(not created)</span>}
                  </button>
                ))}
              </div>
              {(() => {
                const active = configFiles.find((f) => f.id === configActiveId)
                if (!active) return <p className="text-sm text-muted-foreground">Select a file above.</p>
                if (active.isTemplate) {
                  return (
                    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed p-4">
                      <p className="text-sm text-muted-foreground">
                        This mod ships a default template but no live config exists yet.
                      </p>
                      <Button size="sm" onClick={() => createConfig(active)} disabled={configBusy}>
                        Create from template
                      </Button>
                    </div>
                  )
                }
                return (
                  <>
                    <textarea
                      value={configText}
                      onChange={(e) => {
                        setConfigText(e.target.value)
                        setConfigDirty(true)
                      }}
                      readOnly={!active.editable}
                      spellCheck={false}
                      className="min-h-0 flex-1 rounded-md border bg-muted/20 p-3 font-mono text-xs"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                          {active.format}
                        </span>
                        {/* Override map: when this mod isn't declared (heuristic — usually
                            several candidates), let the admin pin the real config file;
                            when it IS an override, let them clear it back to auto. */}
                        {configOverridden ? (
                          <button
                            onClick={() => setConfigOverrideFor('clearOverride')}
                            disabled={configBusy}
                            className="text-[11px] text-muted-foreground hover:text-primary disabled:opacity-40"
                          >
                            clear override
                          </button>
                        ) : (
                          !configDeclared &&
                          configFiles.length > 1 && (
                            <button
                              onClick={() => setConfigOverrideFor('setOverride', active.id)}
                              disabled={configBusy}
                              className="text-[11px] text-muted-foreground hover:text-primary disabled:opacity-40"
                              title="Mark this file as this mod's config (hides the others)"
                            >
                              ★ set as config
                            </button>
                          )
                        )}
                      </div>
                      {active.editable && (
                        <Button size="sm" onClick={saveConfig} disabled={configBusy || !configDirty}>
                          {configBusy ? <Spinner className="size-4" /> : 'Save'}
                        </Button>
                      )}
                    </div>
                    {active.format === 'lua' && (
                      <p className="text-[11px] text-muted-foreground">
                        Lua config — syntax-checked on save (a broken edit is refused).
                      </p>
                    )}
                  </>
                )
              })()}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
