'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { PackageIcon } from 'lucide-react'

// PATCH (not upstream): dashboard-wide MOD-update indicator (sibling of GameUpdatePill). Reads
// /api/mod-updates (server Nexus/Steam + client loadout counts, cache-aware) and shows an amber
// pill in the header — which renders on EVERY tab — only WHEN updates exist. Without this you'd
// only ever see mod updates while sitting on the right Mods sub-tab. Clicking jumps to the Mods
// tab, where the per-mod "↑ update now" / "Update all" actions live.
type ModUpdates = { server: number; client: number; framework?: number; total: number }
const RECHECK_MS = 30 * 60 * 1000 // re-check every 30 min (cache-aware server-side, so cheap)

export function ModUpdatePill() {
  const { config, connectionStatus, requestTab, modUpdatesNonce } = useServer()
  const [info, setInfo] = useState<ModUpdates | null>(null)

  const check = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/mod-updates', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const data = await res.json()
      if (res.ok) setInfo(data as ModUpdates)
    } catch {
      /* transient — keep last known state */
    }
  }, [config])

  useEffect(() => {
    void check()
    const id = window.setInterval(() => void check(), RECHECK_MS)
    return () => window.clearInterval(id)
  }, [check])

  // Re-check immediately when a mod/framework update is applied anywhere (bumps the nonce), so the
  // pill's count drops right away instead of lingering until the next 30-min poll.
  useEffect(() => {
    if (modUpdatesNonce > 0) void check()
  }, [modUpdatesNonce, check])

  // Re-check on the reconnect edge — a restart may have applied server-mod updates, and the admin
  // may have synced client mods in between.
  const prev = useRef(connectionStatus)
  useEffect(() => {
    if (connectionStatus === 'connected' && prev.current !== 'connected') void check()
    prev.current = connectionStatus
  }, [connectionStatus, check])

  // Only present when something is actually behind (keeps the header uncluttered otherwise).
  if (!info || info.total <= 0) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`${info.total} mod update${info.total === 1 ? '' : 's'} available`}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-500/15 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-600 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
        >
          <PackageIcon className="size-3" />
          {info.total} mod update{info.total === 1 ? '' : 's'}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 max-w-[calc(100vw-1.5rem)] p-3">
        <p className="text-xs font-medium">Mod updates available</p>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {[
            info.server ? `${info.server} server` : null,
            info.client ? `${info.client} client loadout` : null,
            info.framework ? `${info.framework} framework` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Review and apply on the Mods tab — server mods take effect on the next restart, client mods on the next loadout
          sync. (Framework = UE4SS / PalSchema.)
        </p>
        <Button size="sm" className="mt-3 h-7 gap-1.5" onClick={() => requestTab('mods')}>
          <PackageIcon className="size-3.5" /> Review in Mods
        </Button>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
