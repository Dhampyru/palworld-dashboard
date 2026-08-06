'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
import { PackageIcon, RefreshCwIcon, Trash2Icon, UploadIcon, ShieldAlertIcon, ShieldCheckIcon, CpuIcon, DownloadIcon, SlidersHorizontalIcon } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'

// Brand marks for the mod sources — lucide has no brand icons, so these are the
// official Steam / Nexus Mods logos (Simple Icons, CC0). Monochrome via
// currentColor so they inherit text color and theme like a lucide icon does.
function SteamIcon({ className }: { className?: string }) {
  return (
    <svg role="img" viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z" />
    </svg>
  )
}
function NexusIcon({ className }: { className?: string }) {
  return (
    <svg role="img" viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M17.376 0c-.993 0-2.18.686-2.907 1.182-1.676-.36-4.036-.545-6.787.635-1.365-.513-2.425-.562-3.32-.488a2.16 2.16 0 0 0-1.27.429c-.33.22-2.788 2.69-3.069 4.652C-.15 7.508.68 8.932 1.218 9.718c-.44 1.76-.2 4.572.517 6.188-.353 1.041-.713 2.089-.664 3.205.01.584.061 1.188.398 1.684C1.72 21.19 4.528 24 6.545 24c.957 0 1.93-.428 3.07-1.24 2.16.383 4.402.348 6.448-.532 2.573 1.001 4.224.625 4.84.162.587-.457 2.826-2.915 3.07-4.622.1-.672-.023-1.638-1.226-3.397a10.983 10.983 0 0 0-.501-6.455c.396-1.069.673-2.188.59-3.337-.015-.68-.221-1.167-.487-1.507-.209-.335-2.415-2.39-4.028-2.91A3.105 3.105 0 0 0 17.376 0m-.03 2.082c.65.015 2.155 1.093 3.01 1.906l.355.34c-.959-.163-2.125.428-3.26 1.55a10.28 10.28 0 0 0-1.358 1.595c-.28.384-.517.768-.753 1.285l1.18.635-3.895 1.477-1.122-4.18 1.033.547c1.358-3.102 2.524-3.973 3.232-4.416h.015a5.12 5.12 0 0 1 1.49-.724zM12 3.065a8.932 8.932 0 0 1 2.22.279 7.67 7.67 0 0 0-.42.488 8.403 8.403 0 0 0-1.8-.196 8.336 8.336 0 0 0-5.897 2.432 7.86 7.86 0 0 1-.37-.433A8.905 8.905 0 0 1 12 3.065m-7.076.305c.71-.002 1.309.127 2.2.466a9.526 9.526 0 0 0-1.713 1.337c-.327-.542-.624-1.156-.488-1.803m-.606.042c-.162.96.428 2.126 1.55 3.264.457.487 1.003.945 1.594 1.358.383.281.767.517 1.283.754l.62-1.182 1.49 3.914-4.176 1.122.546-1.033c-3.099-1.36-3.969-2.526-4.412-3.235v-.015a5.144 5.144 0 0 1-.723-1.491l-.015-.074c.015-.65 1.092-2.156 1.904-3.013Zm16.035 1.483a1.259 1.259 0 0 1 .26.015l.14.023a5.05 5.05 0 0 1-.13 1.137v.015c-.1.383-.228.765-.377 1.148a9.526 9.526 0 0 0-1.346-1.776c.547-.357 1.051-.546 1.453-.562M18.43 5.8a8.903 8.903 0 0 1 2.506 6.2 8.937 8.937 0 0 1-.27 2.183 7.658 7.658 0 0 0-.488-.425A8.407 8.407 0 0 0 20.364 12 8.334 8.334 0 0 0 18 6.173a7.904 7.904 0 0 1 .429-.373M3.315 9.905c.157.148.319.29.488.425A8.417 8.417 0 0 0 3.636 12c0 2.248.887 4.286 2.327 5.788a8.11 8.11 0 0 1-.426.376A8.902 8.902 0 0 1 3.065 12a8.937 8.937 0 0 1 .25-2.095m13.988 1.541-.546 1.034c3.098 1.359 3.969 2.526 4.412 3.235v.014c.34.488.575.99.723 1.492l.014.074c-.014.65-1.092 2.156-1.903 3.013l-.34.354c.163-.96-.427-2.127-1.549-3.264a10.298 10.298 0 0 0-1.594-1.359 7.008 7.008 0 0 0-1.283-.753l-.605 1.152-1.505-3.87zm-6.006 1.684 1.121 4.18-1.033-.547c-1.357 3.102-2.523 3.973-3.231 4.416h-.015c-.487.34-.989.576-1.49.724l-.074.015c-.65-.015-2.154-1.093-3.01-1.906l-.354-.34c.959.163 2.124-.428 3.26-1.55.488-.458.945-1.004 1.358-1.595.28-.384.517-.768.753-1.285l-1.166-.635ZM3.72 16.663A9.526 9.526 0 0 0 5.086 18.5c-.697.47-1.33.665-1.777.59l-.138-.024c0-.367.038-.748.128-1.137v-.015c.11-.417.254-.835.42-1.252m14.131 1.314c.129.14.253.283.372.43A8.904 8.904 0 0 1 12 20.936a8.932 8.932 0 0 1-2.282-.296 7.757 7.757 0 0 0 .417-.487 8.335 8.335 0 0 0 7.716-2.175m.696.889c.43.666.607 1.267.534 1.698l-.023.138a5.034 5.034 0 0 1-1.136-.128h-.014a10.718 10.718 0 0 1-1.114-.366 9.526 9.526 0 0 0 1.753-1.342" />
    </svg>
  )
}

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

const SOURCE_LABEL: Record<Ue4ssSource, string> = {
  'experimental-palworld': 'PalSchema build',
  official: 'Official (Stable)',
  beta: 'Official (Experimental)',
  unknown: 'Custom / uploaded',
}
type InstallKind = 'pak' | 'ue4ss' | 'palschema'

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
type NexusFile = { fileId: number; name: string; version: string | null; category: string | null }

// PATCH (not upstream): this panel talks to /api/game-mods directly (NOT
// through useServer().apiCall, which is hardwired to proxy the Palworld REST
// API) since mod listing is filesystem-backed, not something the game's REST
// API exposes at all. Same auth header, different route(s).
export function GameModsPanel() {
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

  const [installKind, setInstallKind] = useState<InstallKind>('ue4ss')
  const [installModName, setInstallModName] = useState('')
  const [installing, setInstalling] = useState(false)
  const [pakDownloading, setPakDownloading] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Nexus association state (docs/specs/nexus-integration.md). Dormant unless a
  // valid key is connected (Panel Settings → Nexus).
  const [nexusConnected, setNexusConnected] = useState(false)
  const [nexusMods, setNexusMods] = useState<Record<string, NexusModRow>>({})
  const [nexusBusy, setNexusBusy] = useState<string | null>(null)
  const [linkTarget, setLinkTarget] = useState<string | null>(null)
  const [linkUrl, setLinkUrl] = useState('')
  const [linkHaveVersion, setLinkHaveVersion] = useState('')
  // Install-from-Nexus (Phase 2, Premium)
  const [nexusPremium, setNexusPremium] = useState(false)
  const [nexusUrl, setNexusUrl] = useState('')
  const [nexusResolved, setNexusResolved] = useState<{ modId: number; name: string; latestVersion: string | null; files: NexusFile[] } | null>(null)
  const [nexusFileId, setNexusFileId] = useState<number | ''>('')
  const [nexusInstalling, setNexusInstalling] = useState<string | null>(null)
  // Install-from-Steam-Workshop (steam-workshop-download.md). Shown when a Steam
  // account session is connected.
  const [steamConnected, setSteamConnected] = useState(false)
  const [steamUrl, setSteamUrl] = useState('')
  const [steamInstalling, setSteamInstalling] = useState(false)
  // Bulk Workshop install: paste many URLs/ids, install each sequentially.
  const [steamBulk, setSteamBulk] = useState('')
  const [steamBulkBusy, setSteamBulkBusy] = useState(false)
  const [steamBulkResults, setSteamBulkResults] = useState<
    { url: string; itemId: string | null; ok: boolean; name?: string; error?: string }[] | null
  >(null)
  // Bulk install (Phase 3 follow-up): paste many URLs, auto-pick MAIN per mod.
  const [nexusBulk, setNexusBulk] = useState('')
  const [nexusBulkBusy, setNexusBulkBusy] = useState(false)
  const [nexusBulkResults, setNexusBulkResults] = useState<
    { input: string; ok: boolean; name?: string; version?: string | null; needsChoice?: boolean; error?: string }[] | null
  >(null)

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
  }, [config])

  const resolveNexus = useCallback(async () => {
    if (!config || !nexusUrl.trim()) return
    setNexusInstalling('resolve')
    try {
      const res = await fetch(`/api/nexus/install?url=${encodeURIComponent(nexusUrl.trim())}`, {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      setNexusResolved({ modId: json.modId, name: json.name, latestVersion: json.latestVersion, files: json.files ?? [] })
      setNexusFileId(json.files?.[0]?.fileId ?? '')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to resolve mod')
    } finally {
      setNexusInstalling(null)
    }
  }, [config, nexusUrl])

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
  const [ue4ssToggling, setUe4ssToggling] = useState(false)

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

  const toggleUe4ss = useCallback(
    async (enabled: boolean) => {
      if (!config) return
      setUe4ssToggling(true)
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
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Failed', { id: toastId })
      } finally {
        setUe4ssToggling(false)
      }
    },
    [config],
  )

  // ── UE4SS install / swap / rollback (phase 3) ──
  const [ue4ssBusy, setUe4ssBusy] = useState<string | null>(null)
  const [ue4ssBackups, setUe4ssBackups] = useState<
    { file: string; sizeBytes: number; modifiedAt: string | null }[]
  >([])
  const [rollbackTarget, setRollbackTarget] = useState('')
  const swapFileRef = useRef<HTMLInputElement>(null)

  const loadUe4ssBackups = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/game-mods/ue4ss/install', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok) setUe4ssBackups(json.backups ?? [])
    } catch {
      /* ignore */
    }
  }, [config])

  // Returns true on success so callers can chain follow-up steps (e.g. offering
  // to install the PalSchema mod after swapping to its UE4SS build).
  const runUe4ssAction = useCallback(
    async (key: string, init: RequestInit): Promise<boolean> => {
      if (!config) return false
      setUe4ssBusy(key)
      const toastId = toast.loading('Working… (this can take a moment)')
      try {
        const res = await fetch('/api/game-mods/ue4ss/install', {
          ...init,
          headers: { ...buildPalworldProxyHeaders(config), ...(init.headers ?? {}) },
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        if (json.status) setUe4ss(json.status as Ue4ssStatus)
        toast.success((json.note as string) ?? 'Done', { id: toastId })
        await loadUe4ssBackups()
        return true
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Failed', { id: toastId })
        return false
      } finally {
        setUe4ssBusy(null)
      }
    },
    [config, loadUe4ssBackups],
  )

  // Chained flow (owner's call): swapping to the PalSchema UE4SS *build* does NOT
  // install PalSchema itself — they're a version-locked pair but two mechanisms.
  // On a successful palschema-build swap, if the PalSchema mod isn't installed
  // yet, offer step 2 so the build isn't mistaken for a finished PalSchema setup.
  const [offerPalSchema, setOfferPalSchema] = useState(false)
  const [palschemaReload, setPalschemaReload] = useState(0)
  // Official builds lack Palworld's MemberVariableLayout.ini + use a flat layout,
  // so on this game they typically crash or fail to inject — confirm before one.
  const [confirmSwap, setConfirmSwap] = useState<'official' | 'beta' | null>(null)
  const [palschemaTag, setPalschemaTag] = useState('0.6.1') // label only; server owns the real pin

  const downloadUe4ss = useCallback(
    async (source: 'official' | 'beta' | 'palschema') => {
      const ok = await runUe4ssAction(`dl:${source}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'download', source }),
      })
      if (ok && source === 'palschema' && config) {
        try {
          const res = await fetch('/api/game-mods/palschema', {
            headers: buildPalworldProxyHeaders(config),
            cache: 'no-store',
          })
          const json = await res.json()
          if (typeof json.pinnedTag === 'string') setPalschemaTag(json.pinnedTag)
          if (res.ok && !json.status?.installed) setOfferPalSchema(true)
        } catch {
          /* offer is best-effort; the PalSchema section still shows the install */
        }
      }
    },
    [runUe4ssAction, config],
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
      setPalschemaReload((n) => n + 1)
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed', { id: toastId })
    }
  }, [config])

  const uploadUe4ss = useCallback(async () => {
    const f = swapFileRef.current?.files?.[0]
    if (!f) {
      toast.error('Choose a UE4SS build zip first')
      return
    }
    const body = new FormData()
    body.set('file', f)
    await runUe4ssAction('upload', { method: 'POST', body })
    if (swapFileRef.current) swapFileRef.current.value = ''
  }, [runUe4ssAction])

  const doRollbackUe4ss = useCallback(
    (file: string) =>
      runUe4ssAction(`rb`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rollback', backupFile: file }),
      }),
    [runUe4ssAction],
  )

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

  // Defined after `load` since it refreshes the mod list on success.
  const installFromNexus = useCallback(async () => {
    if (!config || !nexusResolved || !nexusFileId) return
    setNexusInstalling('install')
    const toastId = toast.loading('Downloading & installing from Nexus…')
    try {
      const res = await fetch('/api/nexus/install', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ modId: nexusResolved.modId, fileId: nexusFileId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed')
      toast.success((json.note as string) ?? 'Installed from Nexus', { id: toastId })
      setNexusResolved(null)
      setNexusUrl('')
      setNexusFileId('')
      await load()
      await loadNexus()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed', { id: toastId })
    } finally {
      setNexusInstalling(null)
    }
  }, [config, nexusResolved, nexusFileId, load, loadNexus])

  const installFromWorkshop = useCallback(async () => {
    if (!config || !steamUrl.trim()) return
    setSteamInstalling(true)
    const toastId = toast.loading('Downloading from Steam Workshop…')
    try {
      const res = await fetch('/api/steam/workshop', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: steamUrl.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Workshop install failed')
      toast.success((json.note as string) ?? 'Downloaded from Workshop', { id: toastId })
      setSteamUrl('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Workshop install failed', { id: toastId })
    } finally {
      setSteamInstalling(false)
    }
  }, [config, steamUrl, load])

  // Bulk: paste many Workshop URLs/ids; the server installs each sequentially and
  // returns a per-item result. Mirrors the Nexus bulk flow.
  const bulkInstallFromWorkshop = useCallback(async () => {
    if (!config) return
    const urls = steamBulk
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    if (!urls.length) return
    setSteamBulkBusy(true)
    setSteamBulkResults(null)
    const toastId = toast.loading(`Installing ${urls.length} Workshop mod${urls.length === 1 ? '' : 's'}…`)
    try {
      const res = await fetch('/api/steam/workshop', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Bulk install failed')
      setSteamBulkResults(json.results ?? [])
      toast.success((json.note as string) ?? 'Done', { id: toastId })
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk install failed', { id: toastId })
    } finally {
      setSteamBulkBusy(false)
    }
  }, [config, steamBulk, load])

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

  // Bulk install: paste many Nexus URLs; the server installs each sequentially,
  // auto-picking its MAIN file and returning a per-line result.
  const bulkInstallFromNexus = useCallback(async () => {
    if (!config) return
    const urls = nexusBulk.split('\n').map((l) => l.trim()).filter(Boolean)
    if (!urls.length) return
    setNexusBulkBusy(true)
    setNexusBulkResults(null)
    const toastId = toast.loading(`Installing ${urls.length} mod(s) from Nexus…`)
    try {
      const res = await fetch('/api/nexus/install', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk', urls }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Bulk install failed')
      setNexusBulkResults(json.results ?? [])
      toast.success((json.note as string) ?? 'Done', { id: toastId })
      await load()
      await loadNexus()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk install failed', { id: toastId })
    } finally {
      setNexusBulkBusy(false)
    }
  }, [config, nexusBulk, load, loadNexus])

  useEffect(() => {
    load()
    void loadUe4ss()
    void loadUe4ssBackups()
    void loadNexus()
    void loadSteam()
  }, [load, loadUe4ss, loadUe4ssBackups, loadNexus, loadSteam])

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

  const install = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!config) return
      const file = fileInputRef.current?.files?.[0]
      if (!file) {
        toast.error('Choose a file first')
        return
      }

      setInstalling(true)
      try {
        if (installKind === 'palschema') {
          // PalSchema mods have their own route (nested path, JSON/JSONC
          // validation, hybrid pak-split). This is the single install entry point
          // for them; the PalSchema section only lists/removes.
          const body = new FormData()
          body.set('target', 'submod')
          body.set('file', file)
          const response = await fetch('/api/game-mods/palschema', {
            method: 'POST',
            headers: buildPalworldProxyHeaders(config),
            body,
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error ?? response.statusText)
          toast.success((data.note as string) ?? `Installed ${data.result?.name ?? file.name}`)
          if (fileInputRef.current) fileInputRef.current.value = ''
          setPalschemaReload((n) => n + 1) // refresh the PalSchema section's list/count
        } else {
          const body = new FormData()
          body.set('kind', installKind)
          body.set('file', file)
          if (installKind === 'ue4ss' && installModName.trim()) {
            body.set('modName', installModName.trim())
          }

          const response = await fetch('/api/game-mods/install', {
            method: 'POST',
            headers: buildPalworldProxyHeaders(config), // no Content-Type — browser sets the multipart boundary itself
            body,
          })
          const data = await response.json()
          if (!response.ok) throw new Error(data.error ?? response.statusText)

          const linked = data.nexusLinked as { name?: string; version?: string | null } | null
          toast.success(
            linked
              ? `Installed ${data.name ?? file.name} — linked to Nexus (${linked.name}${linked.version ? ` v${linked.version}` : ''})`
              : `Installed ${data.name ?? file.name}`,
          )
          setInstallModName('')
          if (fileInputRef.current) fileInputRef.current.value = ''
          await load()
          if (linked) await loadNexus() // show the freshly-linked mod's Nexus chip
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Install failed')
      } finally {
        setInstalling(false)
      }
    },
    [config, installKind, installModName, load, loadNexus]
  )

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
  // The Active badge follows the STAGED (installed-on-disk) build, so pressing a
  // swap button lights up its button immediately — not the last-booted build.
  const activeSource: 'official' | 'beta' | 'palschema' | null =
    ue4ss?.stagedSource === 'experimental-palworld'
      ? 'palschema'
      : ue4ss?.stagedSource === 'official'
        ? 'official'
        : ue4ss?.stagedSource === 'beta'
          ? 'beta'
          : null
  const activeBadge = (
    <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium leading-none text-emerald-700 dark:text-emerald-400">
      Active
    </span>
  )
  // Nudge toward the PalSchema build when it's NOT the current one; it gives way
  // to the Active badge once staged, so the button never shows both.
  const recommendedBadge = (
    <span className="rounded-full border border-amber-500/40 bg-amber-500/25 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-800 dark:text-amber-200">
      ✦ Recommended
    </span>
  )
  const kindGate: Record<InstallKind, { disabled: boolean; reason: string }> = {
    pak: { disabled: false, reason: '' },
    ue4ss: {
      disabled: !ue4ssActive,
      reason: ue4ssActive ? '' : 'UE4SS is disabled/absent — enable it in the loader above.',
    },
    palschema: {
      disabled: !palschemaReady || !ue4ssActive,
      reason: !ue4ssActive
        ? 'UE4SS is disabled/absent — enable it in the loader above.'
        : palschemaReady
          ? ''
          : 'Requires the PalSchema UE4SS build — swap to it in the loader above.',
    },
  }
  const selectedGate = kindGate[installKind]

  // A single mod row, reused for the main list, the collapsed built-ins, and (with
  // opts.nested) as a bundled child under a hybrid mod's parent row.
  const renderModRow = (
    mod: GameModEntry,
    opts: { nested?: boolean; childrenNode?: React.ReactNode } = {},
  ) => {
    const { nested = false, childrenNode = null } = opts
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

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <PackageIcon className="size-5" />
          <h2 className="text-lg font-semibold">Mods</h2>
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

      <p className="text-muted-foreground text-sm">
        Toggling, installing, or removing a mod takes effect on the next server restart. All three require an
        admin-tier password — a mod-tier login can view this list but not change it.
      </p>

      {/* UE4SS Loader (spec docs/specs/ue4ss-loader.md) — loaded build + enable/disable.
          Version install/swap buttons land in a later phase. */}
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <CpuIcon className="size-4" /> UE4SS Loader
          </h3>
          {ue4ss?.installed && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {ue4ss.enabled ? 'Enabled' : 'Disabled'}
              <Switch
                checked={ue4ss.enabled}
                disabled={ue4ssToggling}
                onCheckedChange={(v) => toggleUe4ss(v)}
                aria-label="Enable UE4SS"
              />
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
            {ue4ss.regime === 'workshop'
              ? '(bGlobalEnableMod is off in PalModSettings).'
              : '(the dwmapi proxy is renamed aside).'}{' '}
            Enable it and restart the server to load mods.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5 text-xs">
            {/* Installed / staged build — updates the instant a swap runs. */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Installed:</span>
              {ue4ss.regime === 'workshop' ? (
                <Badge variant="outline" className="border-sky-500/50 text-sky-500">
                  Workshop layout
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className={
                    ue4ss.stagedSource === 'experimental-palworld'
                      ? 'border-amber-500/50 text-amber-500'
                      : 'text-muted-foreground'
                  }
                >
                  {ue4ss.stagedSource ? SOURCE_LABEL[ue4ss.stagedSource] : 'unknown'}
                </Badge>
              )}
              {ue4ss.stagedVersion && (
                <span className="font-mono text-muted-foreground">{ue4ss.stagedVersion}</span>
              )}
            </div>
            {/* Injection regime — proxy (community dwmapi) vs official Workshop loader. */}
            <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
              <span>Regime:</span>
              <span className="font-medium text-foreground">
                {ue4ss.regime === 'workshop'
                  ? 'Workshop layout — official loader (Mods/NativeMods)'
                  : 'Community proxy — dwmapi (Win64/ue4ss)'}
              </span>
            </div>
            {/* Running status — the live truth (banner checked against boot time). */}
            <div className="flex flex-wrap items-center gap-1.5">
              {!ue4ss.running ? (
                <span className="text-muted-foreground">
                  Server stopped — the installed build loads on next start.
                </span>
              ) : ue4ss.loaded && !ue4ss.pendingRestart ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  ✓ Running {ue4ss.version}
                  {ue4ss.sha ? ` #${ue4ss.sha}` : ''}
                  {ue4ss.buildConfig ? ` · ${ue4ss.buildConfig}` : ''}
                </span>
              ) : ue4ss.loaded && ue4ss.pendingRestart ? (
                <span className="text-amber-600 dark:text-amber-400">
                  ⚠ Pending restart — running {ue4ss.version}
                  {ue4ss.sha ? ` #${ue4ss.sha}` : ''}; restart to load the installed build.
                </span>
              ) : (
                <span className="text-destructive">
                  ⚠ UE4SS did not load on this boot — the installed build failed to inject, or a
                  restart is still pending.
                </span>
              )}
            </div>
          </div>
        )}

        {/* Version install / swap (phase 3). All require the server stopped;
            each backs up the current UE4SS first. */}
        {ue4ss?.installed && (
          <div className="flex flex-col gap-2 border-t pt-2">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                disabled={!!ue4ssBusy}
                onClick={() => setConfirmSwap('official')}
                title="RE-UE4SS v3.0.1 stable — runs classic UE4SS Lua/Blueprint mods; does NOT support PalSchema (no MemberVariableLayout.ini)"
              >
                {ue4ssBusy === 'dl:official' && <Spinner className="size-3.5" />} UE4SS (Stable)
                {activeSource === 'official' && activeBadge}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                disabled={!!ue4ssBusy}
                onClick={() => setConfirmSwap('beta')}
                title="RE-UE4SS experimental-latest pre-release — newer UE4SS; runs classic mods, but not the PalSchema-preconfigured build"
              >
                {ue4ssBusy === 'dl:beta' && <Spinner className="size-3.5" />} UE4SS (Experimental)
                {activeSource === 'beta' && activeBadge}
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5 border-amber-500/50 bg-amber-500/15 text-xs text-amber-700 hover:bg-amber-500/25 dark:text-amber-400"
                variant="outline"
                disabled={!!ue4ssBusy}
                onClick={() => downloadUe4ss('palschema')}
                title="Okaetsu experimental-palworld — includes MemberVariableLayout.ini; required for PalSchema (runs classic mods too)"
              >
                {ue4ssBusy === 'dl:palschema' && <Spinner className="size-3.5" />} UE4SS (PalSchema)
                {activeSource === 'palschema' ? activeBadge : recommendedBadge}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              All three report the same version (<span className="font-mono">v3.0.1 Beta #0</span>) — they differ by
              Git SHA / branch, not version number. All run classic UE4SS Lua/Blueprint mods; only{' '}
              <span className="text-amber-600 dark:text-amber-400">UE4SS (PalSchema)</span> supports PalSchema (it
              ships the <span className="font-mono">MemberVariableLayout.ini</span> PalSchema needs).
            </p>

            {/* Generic operator-supplied build — separate from the named ones. */}
            <details className="rounded-md border border-border/60 bg-muted/20 p-2">
              <summary className="cursor-pointer text-[11px] text-muted-foreground">
                Manual upload — supply your own UE4SS build zip
              </summary>
              <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                You vet this build. It replaces the loader and can break joins — the current UE4SS is backed up
                first, and rollback is below.
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input
                  ref={swapFileRef}
                  type="file"
                  accept=".zip"
                  className="text-xs file:mr-2 file:rounded file:border file:bg-muted file:px-2 file:py-0.5 file:text-xs"
                />
                <Button size="sm" className="h-8 gap-1.5 text-xs" disabled={!!ue4ssBusy} onClick={uploadUe4ss}>
                  {ue4ssBusy === 'upload' ? <Spinner className="size-3.5" /> : <UploadIcon className="size-3.5" />}
                  Install upload
                </Button>
              </div>
            </details>

            {ue4ssBackups.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Rollback to:</span>
                <select
                  value={rollbackTarget || ue4ssBackups[0].file}
                  onChange={(e) => setRollbackTarget(e.target.value)}
                  className="max-w-[16rem] truncate rounded-md border bg-background px-2 py-1 text-xs"
                >
                  {ue4ssBackups.map((b) => (
                    <option key={b.file} value={b.file}>
                      {b.file}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1.5 text-xs"
                  disabled={!!ue4ssBusy}
                  onClick={() => doRollbackUe4ss(rollbackTarget || ue4ssBackups[0].file)}
                >
                  {ue4ssBusy === 'rb' && <Spinner className="size-3.5" />} Rollback
                </Button>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              All version actions require the server <span className="font-medium">stopped</span> and take effect
              on the next restart.
            </p>
          </div>
        )}
      </div>

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

      <div className="mt-2 flex flex-col gap-4 rounded-md border p-3">
        <div className="flex items-center gap-2">
          <UploadIcon className="size-4" />
          <h3 className="text-sm font-semibold">Install a Mod</h3>
        </div>

        {/* ── Nexus Mods (nexusmods.com) — auto-download is Premium-gated; free or
            disconnected accounts get a discoverable placeholder. ── */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <NexusIcon className="size-4" /> Nexus Mods
            </div>
            {nexusConnected && nexusPremium ? (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                Premium
              </span>
            ) : (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {nexusConnected ? 'Connected · not Premium' : 'Not connected'}
              </span>
            )}
          </div>

          {/* Install straight from a Nexus URL (Premium — downloads + installs). */}
          {nexusConnected && nexusPremium && (
            <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/20 p-2">
              <span className="text-xs font-medium">Single mod URL</span>
              <div className="flex gap-2">
                <Input
                  placeholder="https://www.nexusmods.com/palworld/mods/…"
                  value={nexusUrl}
                  onChange={(e) => setNexusUrl(e.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={resolveNexus}
                  disabled={nexusInstalling === 'resolve' || !nexusUrl.trim()}
                >
                  {nexusInstalling === 'resolve' ? <Spinner className="size-3.5" /> : 'Fetch'}
                </Button>
              </div>
              {nexusResolved && (
                <div className="flex flex-col gap-1.5">
                  <p className="text-xs text-muted-foreground">
                    {nexusResolved.name}
                    {nexusResolved.latestVersion ? ` — latest v${nexusResolved.latestVersion}` : ''}
                  </p>
                  {nexusResolved.files.length === 0 ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400">No downloadable files listed.</p>
                  ) : (
                    <select
                      value={nexusFileId === '' ? '' : String(nexusFileId)}
                      onChange={(e) => setNexusFileId(e.target.value ? Number(e.target.value) : '')}
                      className="rounded-md border bg-background px-2 py-1 text-xs"
                    >
                      {nexusResolved.files.map((f) => (
                        <option key={f.fileId} value={f.fileId}>
                          {f.name}
                          {f.version ? ` — v${f.version}` : ''}
                          {f.category ? ` (${f.category})` : ''}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    onClick={installFromNexus}
                    disabled={nexusInstalling === 'install' || !nexusFileId}
                    className="w-fit"
                  >
                    {nexusInstalling === 'install' ? <Spinner className="mr-2 size-4" /> : <DownloadIcon className="mr-2 size-4" />}
                    Download &amp; install
                  </Button>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">
                Auto-detects the mod type and links it for update checks. Takes effect on next restart.
              </p>
            </div>
          )}

          {/* Bulk install: paste many Nexus URLs (Premium). Auto-picks each MAIN file. */}
          {nexusConnected && nexusPremium && (
            <details className="rounded-md border border-border/60 bg-muted/20 p-2">
              <summary className="cursor-pointer select-none text-xs font-medium">Bulk install</summary>
              <div className="mt-2 flex flex-col gap-2">
                <textarea
                  placeholder={'One Nexus URL or mod id per line:\nhttps://www.nexusmods.com/palworld/mods/1135\n4379'}
                  value={nexusBulk}
                  onChange={(e) => setNexusBulk(e.target.value)}
                  rows={4}
                  className="w-full rounded-md border bg-background px-2 py-1 text-xs font-mono"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={bulkInstallFromNexus}
                  disabled={nexusBulkBusy || !nexusBulk.trim()}
                  className="w-fit"
                >
                  {nexusBulkBusy ? <Spinner className="mr-2 size-4" /> : <DownloadIcon className="mr-2 size-4" />}
                  {nexusBulkBusy ? 'Installing…' : 'Install all'}
                </Button>
                {nexusBulkResults && (
                  <ul className="flex flex-col gap-0.5 text-[11px]">
                    {nexusBulkResults.map((r, i) => (
                      <li
                        key={`${r.input}-${i}`}
                        className={
                          r.ok
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : r.needsChoice
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-destructive'
                        }
                      >
                        {r.ok ? '✓' : r.needsChoice ? '⚠' : '✗'} {r.name ?? r.input}
                        {r.ok && r.version ? ` — v${r.version}` : ''}
                        {!r.ok && r.error ? ` — ${r.error}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Each mod&apos;s MAIN file is installed automatically. Mods with multiple/no MAIN file are flagged
                  — finish those with the single-URL box above. Takes effect on next restart.
                </p>
              </div>
            </details>
          )}

          {/* No Premium key → discoverable explainer in place of the install boxes. */}
          {!(nexusConnected && nexusPremium) && (
            <div className="flex flex-col gap-1 rounded-md border border-dashed border-border/60 bg-muted/10 p-2 opacity-90">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Download &amp; install mods straight from a Nexus URL — one at a time or in bulk — with automatic
                type detection and update-linking.{' '}
                {nexusConnected
                  ? 'Your Nexus key is connected but not Premium, so auto-download stays off. Free accounts still get update alerts and the guided manual upload below.'
                  : 'Add a personal Nexus API key in Panel Settings → Nexus to enable it (a Nexus Premium account is required for auto-download).'}
              </p>
            </div>
          )}
        </section>

        {/* ── Steam Workshop — the platform's actual feature name. Live box when
            connected, discoverable placeholder otherwise. ── */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <SteamIcon className="size-4" /> Steam Workshop
            </div>
            {steamConnected ? (
              <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700 dark:text-sky-400">
                Connected
              </span>
            ) : (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Not connected
              </span>
            )}
          </div>

          {steamConnected ? (
            <div className="flex flex-col gap-2 rounded-md border border-sky-500/40 bg-sky-500/5 p-2">
              <div className="flex gap-2">
                <Input
                  placeholder="https://steamcommunity.com/sharedfiles/filedetails/?id=…"
                  value={steamUrl}
                  onChange={(e) => setSteamUrl(e.target.value)}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={installFromWorkshop}
                  disabled={steamInstalling || !steamUrl.trim()}
                >
                  {steamInstalling ? <Spinner className="mr-1 size-3.5" /> : <DownloadIcon className="mr-1 size-4" />}
                  Install
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Downloads via your connected Steam account, then installs the mod into your current UE4SS setup
                (reading its manifest: Lua → UE4SS Mods, PalSchema data → PalSchema, paks → ~mods). Restart the server
                to load it. UE4SS/PalSchema framework items are skipped — you already have those.
              </p>

              {/* Bulk install: paste many Workshop URLs/ids (parallel of the Nexus bulk). */}
              <details className="rounded-md border border-border/60 bg-background/40 p-2">
                <summary className="cursor-pointer select-none text-xs font-medium">Bulk install</summary>
                <div className="mt-2 flex flex-col gap-2">
                  <textarea
                    placeholder={
                      'One Workshop URL or item id per line:\nhttps://steamcommunity.com/sharedfiles/filedetails/?id=123456789\n987654321'
                    }
                    value={steamBulk}
                    onChange={(e) => setSteamBulk(e.target.value)}
                    rows={4}
                    className="w-full rounded-md border bg-background px-2 py-1 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={bulkInstallFromWorkshop}
                    disabled={steamBulkBusy || !steamBulk.trim()}
                    className="w-fit"
                  >
                    {steamBulkBusy ? <Spinner className="mr-2 size-4" /> : <DownloadIcon className="mr-2 size-4" />}
                    {steamBulkBusy ? 'Installing…' : 'Install all'}
                  </Button>
                  {steamBulkResults && (
                    <ul className="flex flex-col gap-0.5 text-[11px]">
                      {steamBulkResults.map((r, i) => (
                        <li
                          key={`${r.url}-${i}`}
                          className={r.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}
                        >
                          {r.ok ? '✓' : '✗'} {r.name ?? r.itemId ?? r.url}
                          {!r.ok && r.error ? ` — ${r.error}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>
            </div>
          ) : (
            <div className="flex flex-col gap-1 rounded-md border border-dashed border-sky-500/40 bg-sky-500/5 p-2 opacity-90">
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Auto-download Steam Workshop mods for the official Workshop layout. Connect a Steam account in{' '}
                <span className="font-medium">Panel Settings → Steam</span> to enable it — it needs an account that{' '}
                <span className="font-medium">owns Palworld</span> (a dedicated secondary account is recommended).
              </p>
            </div>
          )}
        </section>

        {/* ── Manual Upload — upload a file directly, no external account. ── */}
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <UploadIcon className="size-4" /> Manual Upload
          </div>

          <form onSubmit={install} className="flex flex-col gap-3">
            {/* Three gated kinds (spec §3): pak always, UE4SS needs an active
                loader, PalSchema needs the experimental build. */}
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  ['pak', 'Pak mod'],
                  ['ue4ss', 'UE4SS mod'],
                  ['palschema', 'PalSchema mod'],
                ] as const
              ).map(([kind, label]) => {
                const gate = kindGate[kind]
                return (
                  <button
                    key={kind}
                    type="button"
                    disabled={gate.disabled}
                    title={gate.disabled ? gate.reason : undefined}
                    onClick={() => setInstallKind(kind)}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      installKind === kind
                        ? 'border-primary/60 bg-primary/10 text-primary'
                        : 'text-muted-foreground'
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>

            {selectedGate.disabled && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                {selectedGate.reason}
              </p>
            )}

            {!selectedGate.disabled && installKind === 'ue4ss' && (
              <Input
                placeholder="Mod folder name (optional — defaults to the zip's filename)"
                value={installModName}
                onChange={(e) => setInstallModName(e.target.value)}
              />
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept={installKind === 'pak' ? '.pak' : '.zip'}
              className="text-sm file:mr-3 file:rounded-md file:border file:bg-muted file:px-2 file:py-1 file:text-sm"
            />

            <p className="text-xs text-muted-foreground">
              {installKind === 'pak'
                ? 'The .pak file is placed directly in Paks/~mods/.'
                : installKind === 'palschema'
                  ? 'A zip of one PalSchema mod folder (JSON/JSONC). Any bundled .pak assets are split out to Paks/~mods/ (hybrid mods).'
                  : 'The zip should contain the mod’s files directly (main.lua etc.) at its root, not nested in an extra folder.'}
            </p>

            <Button type="submit" disabled={installing} className="w-fit">
              {installing ? <Spinner className="mr-2 size-4" /> : <UploadIcon className="mr-2 size-4" />}
              {installing ? 'Installing…' : 'Install'}
            </Button>
          </form>
        </section>
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
              This permanently deletes the mod's files from the server. This can't be undone — takes effect on
              the next server restart.
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

      {/* Guard the Official-build swaps — they're footguns for Palworld. */}
      <AlertDialog open={confirmSwap !== null} onOpenChange={(o) => !o && setConfirmSwap(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Swap to {confirmSwap === 'beta' ? 'UE4SS (Experimental)' : 'UE4SS (Stable)'}?</AlertDialogTitle>
            <AlertDialogDescription>
              This build runs classic UE4SS Lua/Blueprint mods, but does{' '}
              <span className="font-medium">not support PalSchema</span> (it lacks Palworld&apos;s{' '}
              <span className="font-mono">MemberVariableLayout.ini</span>) — any PalSchema mods stop loading until you
              swap back to <span className="font-medium">UE4SS (PalSchema)</span>. Heads-up: installing a flat-layout
              build through this swapper isn&apos;t fully reliable yet and can fail to inject; if that happens, roll
              back below. Your current build is backed up first. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const s = confirmSwap
                setConfirmSwap(null)
                if (s) void downloadUe4ss(s)
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Step 2 of 2 after a PalSchema-build UE4SS swap — wording is deliberately
          explicit that PalSchema itself is NOT yet installed. */}
      <AlertDialog open={offerPalSchema} onOpenChange={setOfferPalSchema}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>UE4SS ready — PalSchema is not installed yet</AlertDialogTitle>
            <AlertDialogDescription>
              That installed the <span className="font-medium">UE4SS build</span> PalSchema needs — step 1 of 2.
              PalSchema itself is <span className="font-medium">not installed</span>, so PalSchema mods won&apos;t
              work until you add it. Install PalSchema {palschemaTag} now? (You can also do it later from the
              PalSchema section.)
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={installPalSchemaNow}>Install PalSchema {palschemaTag}</AlertDialogAction>
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
