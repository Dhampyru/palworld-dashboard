'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
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
import { DownloadIcon } from 'lucide-react'

// PATCH (not upstream): dashboard-wide game-update indicator. Reads /api/check-update (installed
// vs latest public Steam buildid — read-only, safe with players on) and shows an amber pill in
// the header (renders on every tab) only WHEN an update is available. "Update now" triggers the
// normal Restart (ALWAYS_UPDATE_ON_START=true → SteamCMD applies the update on boot); admin-gated
// + confirmed. No separate apply mechanism exists — a restart is the update.
type UpdateInfo = { installedBuildId: string; latestBuildId: string; updateAvailable: boolean }
const RECHECK_MS = 30 * 60 * 1000 // re-check every 30 min (cheap: appmanifest read + one HTTP GET)

export function GameUpdatePill() {
  const { config } = useServer()
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const check = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/check-update', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const data = await res.json()
      if (res.ok) setInfo(data as UpdateInfo)
    } catch {
      /* transient — keep last known state */
    }
  }, [config])

  useEffect(() => {
    void check()
    const id = window.setInterval(() => void check(), RECHECK_MS)
    return () => window.clearInterval(id)
  }, [check])

  const applyUpdate = useCallback(async () => {
    if (!config) return
    setBusy(true)
    try {
      const headers = new Headers(buildPalworldProxyHeaders(config))
      headers.set('Content-Type', 'application/json')
      const res = await fetch('/api/server-restart', {
        method: 'POST',
        headers,
        cache: 'no-store',
        body: JSON.stringify({ waittime: 60, message: `Updating to build ${info?.latestBuildId ?? 'latest'}` }),
      })
      if (!res.ok) throw new Error()
      toast.success('Update scheduled — restarting in 60s to apply it')
    } catch {
      toast.error('Failed to schedule the update — is the host integration set up?')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }, [config, info])

  // Only present when an update is actually available (keeps the header uncluttered otherwise).
  if (!info?.updateAvailable) return null
  const isAdmin = config?.accessTier === 'admin'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="A Palworld server update is available"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/50 bg-amber-500/15 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-amber-600 transition-colors hover:bg-amber-500/25 dark:text-amber-400"
          >
            <DownloadIcon className="size-3" />
            Update available
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1.5rem)] p-3">
          <p className="text-xs font-medium">Palworld server update</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            build {info.installedBuildId} → <span className="text-amber-600 dark:text-amber-400">{info.latestBuildId}</span>
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Applying it restarts the server (SteamCMD updates on boot). Players get a 60-second warning.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {isAdmin ? (
              <Button
                size="sm"
                className="h-7 gap-1.5 bg-amber-600 text-white hover:bg-amber-600/90"
                onClick={() => setConfirming(true)}
              >
                <DownloadIcon className="size-3.5" /> Update now
              </Button>
            ) : (
              <span className="text-[11px] text-muted-foreground">Admin tier required to apply.</span>
            )}
            <Button size="sm" variant="ghost" className="h-7" onClick={() => void check()}>
              Re-check
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirming} onOpenChange={(o) => !o && !busy && setConfirming(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update the server now?</AlertDialogTitle>
            <AlertDialogDescription>
              Players get a 60-second warning, then the server restarts and SteamCMD applies the update to build{' '}
              {info.latestBuildId} on boot. It comes back automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void applyUpdate()} disabled={busy}>
              {busy ? 'Scheduling…' : 'Update now'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
