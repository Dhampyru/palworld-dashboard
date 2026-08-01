'use client'

// PATCH (not upstream): compact lifecycle action cluster for the dashboard
// header's second row (roadmap #3). State-aware Start/Stop (by connectionStatus),
// Restart, Save now, and a terminal button that opens the RCON console modal.
//
// It reuses the SAME endpoints and header-building as ServerManagementCard --
// the server-{start,stop,restart} flag-file routes (§2 host integration) and
// /api/rcon's `Save` (the game REST /save endpoint is broken on this build; see
// that card's note). Lifecycle actions are ADMIN-ONLY, matching the routes,
// which reject lower tiers before writing anything; the Console button is shown
// to every tier because the console gates its own sends. Stop and Restart
// confirm first -- this cluster sits one click from every screen.

import { useEffect, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
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
import { PlayIcon, SquareIcon, RotateCcwIcon, SaveIcon, TerminalIcon } from 'lucide-react'

const BTN = 'h-8 gap-1.5 px-2.5 font-mono text-[11px] uppercase tracking-[0.2em] sm:px-3'

export function ServerActionCluster({ onOpenConsole }: { onOpenConsole?: () => void }) {
  const { config, connectionStatus } = useServer()
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null)

  // A lifecycle action (queued via a flag file) plays out over a countdown +
  // recreate/boot the one-shot "queued" toast doesn't cover. Track the in-flight
  // transition and keep a persistent notice up until the connection actually
  // resolves — so the user isn't left staring at a silent 30-60s window.
  const [transition, setTransition] = useState<'start' | 'stop' | 'restart' | null>(null)
  const sawDown = useRef(false)
  const startedAt = useRef(0)
  const safety = useRef<ReturnType<typeof setTimeout> | null>(null)
  const LIFECYCLE_TOAST = 'server-lifecycle'

  const beginTransition = (kind: 'start' | 'stop' | 'restart', message: string) => {
    sawDown.current = false
    startedAt.current = Date.now()
    setTransition(kind)
    toast.loading(message, { id: LIFECYCLE_TOAST, duration: Infinity })
    if (safety.current) clearTimeout(safety.current)
    // Never leave a stuck spinner: recreate + Wine boot can be slow, so give a
    // generous ceiling, then fall back to "check the badge" and clear.
    safety.current = setTimeout(() => {
      toast.info('Still working — check the connection badge for the current status.', {
        id: LIFECYCLE_TOAST,
        duration: 6000,
      })
      setTransition(null)
    }, 180000)
  }

  const resolveTransition = (finish: () => void) => {
    if (safety.current) {
      clearTimeout(safety.current)
      safety.current = null
    }
    finish()
    setTransition(null)
  }

  // Resolve the notice from real connection transitions rather than a fixed timer.
  useEffect(() => {
    if (!transition) return
    const elapsed = Date.now() - startedAt.current
    if (connectionStatus !== 'connected') sawDown.current = true

    if (transition === 'start' && connectionStatus === 'connected') {
      resolveTransition(() => toast.success('Server is online', { id: LIFECYCLE_TOAST, duration: 4000 }))
    } else if (transition === 'stop' && elapsed > 9000 && connectionStatus !== 'connected') {
      // Past the 10s warning window and the server has dropped → stopped.
      resolveTransition(() => toast.success('Server stopped', { id: LIFECYCLE_TOAST, duration: 4000 }))
    } else if (transition === 'restart' && sawDown.current && connectionStatus === 'connected') {
      // Went down (during/after the warning) and has come back.
      resolveTransition(() => toast.success('Server is back online', { id: LIFECYCLE_TOAST, duration: 4000 }))
    }
  }, [connectionStatus, transition])

  useEffect(() => () => { if (safety.current) clearTimeout(safety.current) }, [])

  const isAdmin = config?.accessTier === 'admin'
  const running = connectionStatus === 'connected'
  const checking = connectionStatus === 'checking'
  const transitioning = transition !== null

  const jsonHeaders = () => {
    const headers = new Headers(buildPalworldProxyHeaders(config!))
    headers.set('Content-Type', 'application/json')
    return headers
  }

  // RCON Save (same operation as ServerManagementCard, over the reliable path).
  const save = async (): Promise<boolean> => {
    const res = await fetch('/api/rcon', {
      method: 'POST',
      headers: jsonHeaders(),
      cache: 'no-store',
      body: JSON.stringify({ command: 'Save' }),
    })
    return res.ok
  }

  const run = async (fn: () => Promise<void>) => {
    if (!config) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const doStart = () =>
    run(async () => {
      const res = await fetch('/api/server-start', { method: 'POST', headers: jsonHeaders(), cache: 'no-store' })
      res.ok
        ? beginTransition('start', 'Starting server… waiting for it to come online')
        : toast.error('Failed to start — is the host integration set up?')
    })

  const doSave = () =>
    run(async () => {
      ;(await save()) ? toast.success('World saved') : toast.error('Failed to save world')
    })

  const doStop = () => {
    setConfirm(null)
    return run(async () => {
      // Save first, then queue a genuine host-level stop with a short warning.
      if (!(await save())) {
        toast.error('Failed to save world — stop aborted')
        return
      }
      const res = await fetch('/api/server-stop', {
        method: 'POST',
        headers: jsonHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ waittime: 10, message: 'Server will shutdown in 10 seconds!' }),
      })
      res.ok
        ? beginTransition('stop', 'Stopping server… 10-second warning sent to players')
        : toast.error('Failed to stop — is the host integration set up?')
    })
  }

  const doRestart = () => {
    setConfirm(null)
    return run(async () => {
      const res = await fetch('/api/server-restart', {
        method: 'POST',
        headers: jsonHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ waittime: 30, message: 'Server restarting in 30 seconds!' }),
      })
      res.ok
        ? beginTransition('restart', 'Restarting server… 30-second warning sent; it will drop briefly then return')
        : toast.error('Failed to restart — is the host integration set up?')
    })
  }

  return (
    <div className="flex items-center gap-1.5">
      {isAdmin && (
        <>
          {running ? (
            <Button variant="outline" size="sm" onClick={() => setConfirm('stop')} disabled={busy || transitioning} title="Stop server" className={BTN}>
              {busy || transitioning ? <Spinner className="size-3.5" /> : <SquareIcon className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={doStart} disabled={busy || checking || transitioning} title="Start server" className={BTN}>
              {busy || transitioning ? <Spinner className="size-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">Start</span>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => setConfirm('restart')} disabled={busy || !running || transitioning} title="Restart server" className={BTN}>
            {transitioning ? <Spinner className="size-3.5" /> : <RotateCcwIcon className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">Restart</span>
          </Button>
          <Button variant="outline" size="sm" onClick={doSave} disabled={busy || !running || transitioning} title="Save the world now" className={BTN}>
            <SaveIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Save</span>
          </Button>
          {/* Keep the console (and lifecycle) visually distinct from the tabs. */}
          <span className="mx-0.5 h-5 w-px bg-border/60" aria-hidden />
        </>
      )}

      {onOpenConsole && (
        <Button variant="outline" size="sm" onClick={onOpenConsole} title="Open the RCON console" className={BTN}>
          <TerminalIcon className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Console</span>
        </Button>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === 'stop' ? 'Stop the server?' : 'Restart the server?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'stop'
                ? 'The world is saved first, then players get a 10-second warning and the server stops — and stays stopped.'
                : 'Players get a 30-second warning, then the server restarts and comes back automatically.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirm === 'stop' ? doStop : doRestart}>
              {confirm === 'stop' ? 'Stop' : 'Restart'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
