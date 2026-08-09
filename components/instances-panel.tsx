'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
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
import {
  ServerIcon,
  HardDriveIcon,
  PlayIcon,
  SquareIcon,
  RefreshCwIcon,
  Trash2Icon,
  PlusIcon,
  ChevronRightIcon,
} from 'lucide-react'

// Multi-instance (#7 Phase 6): manage every registered Palworld server —
// live status, per-instance lifecycle, delete-keeps-saves, and a "New server"
// wizard. All actions go through the same admin-gated APIs the backend phases
// built; the daemon does the privileged work.

type InstancePort = { game: number; query: number; rcon: number; rest: number; paldefender: number }
type InstanceRow = {
  id: string
  displayName: string
  isDefault: boolean
  enabled: boolean
  ports: InstancePort
  running: boolean | null
  status: string | null
  memBytes: number | null
  startedAt: string | null
  activeWorld: string | null
}
type DiskInfo = { totalBytes: number; freeBytes: number; usedBytes: number }

type ProvisionStatus = { phase: string; pct?: number; message?: string } | null

function fmtMem(n: number | null): string {
  if (!n || n <= 0) return '—'
  const mb = n / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

function StatusDot({ running }: { running: boolean | null }) {
  const cls =
    running === true ? 'bg-emerald-500' : running === false ? 'bg-muted-foreground/40' : 'bg-amber-500'
  return <span className={`inline-block size-2.5 shrink-0 rounded-full ${cls}`} />
}

export function InstancesPanel() {
  const { config, enterInstance } = useServer()
  const [rows, setRows] = useState<InstanceRow[] | null>(null)
  const [disk, setDisk] = useState<DiskInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // `${action}:${id}`
  const [deleteTarget, setDeleteTarget] = useState<InstanceRow | null>(null)
  const [lifecycleTarget, setLifecycleTarget] = useState<{ row: InstanceRow; action: 'start' | 'stop' | 'restart' } | null>(null)

  // create wizard
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newMax, setNewMax] = useState('16')
  const [newPassword, setNewPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [provId, setProvId] = useState<string | null>(null)
  const [prov, setProv] = useState<ProvisionStatus>(null)
  const provTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const headers = useCallback(
    (instanceId?: string): HeadersInit => ({
      ...(config ? buildPalworldProxyHeaders(config) : {}),
      ...(instanceId ? { 'x-palworld-instance': instanceId } : {}),
      'content-type': 'application/json',
    }),
    [config],
  )

  const load = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/instances', { headers: headers(), cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      setRows(json.instances as InstanceRow[])
      setDisk((json.disk as DiskInfo | null) ?? null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load instances')
    }
  }, [config, headers])

  // Poll the list for live status.
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 10_000)
    return () => clearInterval(t)
  }, [load])

  // After a start, poll the instance list until it reports running so the toast can confirm
  // it actually came ONLINE — a start (esp. first boot / SteamCMD) takes a while, and a bare
  // "queued" reads as nothing happening. Fire-and-forget; the row's status dot updates from
  // the same fetched data. Falls back to a heads-up on timeout rather than hanging forever.
  const waitForOnline = useCallback(
    async (row: InstanceRow, toastId: string | number) => {
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000))
        try {
          const res = await fetch('/api/instances', { headers: headers(), cache: 'no-store' })
          const json = await res.json()
          const rowsNow = (json.instances as InstanceRow[]) ?? []
          setRows(rowsNow)
          setDisk((json.disk as DiskInfo | null) ?? null)
          if (rowsNow.find((r) => r.id === row.id)?.running === true) {
            toast.success(`${row.displayName} is online`, { id: toastId })
            return
          }
        } catch {
          /* transient fetch error — keep polling */
        }
      }
      toast.warning(`${row.displayName} is still starting — watch the status dot`, { id: toastId })
    },
    [headers],
  )

  const lifecycle = useCallback(
    async (row: InstanceRow, action: 'start' | 'stop' | 'restart') => {
      const key = `${action}:${row.id}`
      const verb = `${action[0].toUpperCase()}${action.slice(1)}`
      setBusy(key)
      const toastId = toast.loading(`${verb}ing ${row.displayName}…`)
      try {
        // stop/restart use a short countdown so the daemon/units broadcast a
        // warning to any players before disconnecting them; start is immediate.
        const waittime = action === 'restart' ? 15 : action === 'stop' ? 10 : 0
        const res = await fetch(`/api/server-${action}`, {
          method: 'POST',
          headers: headers(row.id),
          body: JSON.stringify({ waittime }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        if (action === 'start') {
          // Keep the toast live and track until the server is actually online.
          toast.loading(`Starting ${row.displayName} — waiting for it to come online…`, { id: toastId })
          void waitForOnline(row, toastId)
        } else {
          toast.success(`${verb} queued for ${row.displayName}`, { id: toastId })
          setTimeout(() => void load(), 1500)
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Failed to ${action}`, { id: toastId })
      } finally {
        setBusy(null)
      }
    },
    [headers, load, waitForOnline],
  )

  const confirmDelete = useCallback(async () => {
    const row = deleteTarget
    setDeleteTarget(null)
    if (!row) return
    setBusy(`delete:${row.id}`)
    const toastId = toast.loading(`Deleting ${row.displayName}…`)
    try {
      const res = await fetch(`/api/instances/${encodeURIComponent(row.id)}`, {
        method: 'DELETE',
        headers: headers(),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      toast.success(`${row.displayName} deleted — save files kept`, { id: toastId })
      setTimeout(() => void load(), 1500)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete', { id: toastId })
    } finally {
      setBusy(null)
    }
  }, [deleteTarget, headers, load])

  const stopProvPoll = useCallback(() => {
    if (provTimer.current) {
      clearInterval(provTimer.current)
      provTimer.current = null
    }
  }, [])

  const startCreate = useCallback(async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/instances', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ displayName: newName.trim(), maxPlayers: Number(newMax) || 16, serverPassword: newPassword.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      const id = json.id as string
      setProvId(id)
      setProv({ phase: 'queued', message: 'Queued…' })
      toast.success(`Provisioning "${id}" — first boot installs the game (several minutes)`)
      // poll status
      stopProvPoll()
      provTimer.current = setInterval(async () => {
        try {
          const s = await fetch(`/api/instances/${encodeURIComponent(id)}`, { headers: headers(), cache: 'no-store' })
          const sj = await s.json()
          const p = (sj.provision ?? null) as ProvisionStatus
          if (p) setProv(p)
          if (sj.running) setProv({ phase: 'ready', message: 'Server is up' })
          if (p && ['ready', 'timeout', 'failed'].includes(p.phase)) {
            stopProvPoll()
            void load()
          }
        } catch {
          /* keep polling */
        }
      }, 3000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to start provisioning')
    } finally {
      setCreating(false)
    }
  }, [newName, newMax, headers, load, stopProvPoll])

  useEffect(() => () => stopProvPoll(), [stopProvPoll])

  const closeCreate = useCallback(() => {
    setCreateOpen(false)
    setNewName('')
    setNewMax('16')
    setNewPassword('')
    setProvId(null)
    setProv(null)
    stopProvPoll()
  }, [stopProvPoll])

  return (
    <div className="p-3 sm:p-4 lg:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ServerIcon className="size-5" />
          <h2 className="text-lg font-semibold">Instances</h2>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
            <RefreshCwIcon className="size-3.5" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
            <PlusIcon className="size-4" /> New server
          </Button>
        </div>
      </div>

      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        Every Palworld server this dashboard manages. <span className="font-medium text-foreground">Click a
        server to open its dashboard.</span> You can also start, stop or restart the others in place, spin up
        a brand-new server, or delete one (its save files are always kept).
      </p>

      {/* Environment-wide disk (the host all instances share), shown once here
          rather than per-server. */}
      {disk && disk.totalBytes > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
          <HardDriveIcon className="size-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Disk (this host)</span>
          <span className="font-medium text-foreground">{fmtMem(disk.freeBytes)}</span>
          <span className="text-muted-foreground">free of {fmtMem(disk.totalBytes)}</span>
          {(() => {
            const pct = Math.min(100, Math.max(0, Math.round((disk.usedBytes / disk.totalBytes) * 100)))
            return (
              <>
                <div className="ml-1 h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                  <div
                    className={pct >= 90 ? 'h-full bg-destructive' : 'h-full bg-primary'}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className={pct >= 90 ? 'text-destructive' : 'text-muted-foreground'}>{pct}% used</span>
              </>
            )
          })()}
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {rows === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading instances…
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const rowBusy = busy?.endsWith(`:${row.id}`) ?? false
            return (
              <li
                key={row.id}
                className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <button
                  type="button"
                  onClick={() => enterInstance(row.id, { gamePort: String(row.ports.game), restApiPort: String(row.ports.rest) })}
                  title="Open this server's dashboard"
                  className="group -m-1 flex min-w-0 flex-1 items-center gap-2 rounded p-1 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <StatusDot running={row.running} />
                      <span className="truncate text-sm font-medium">{row.displayName}</span>
                      {row.isDefault && (
                        <Badge variant="outline" className="border-primary/50 text-primary" title="Your main server — managed from its own dashboard header; can't be deleted here">
                          Primary
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {row.running === true ? 'running' : row.running === false ? (row.status ?? 'stopped') : 'unknown'}
                      </span>
                    </div>
                    <div className="pl-[18px] text-xs text-muted-foreground">
                      <span className="font-mono">{row.id}</span> · game {row.ports.game} · REST {row.ports.rest}
                      {row.running === true && <> · {fmtMem(row.memBytes)}</>}
                    </div>
                    {row.activeWorld && (
                      <div className="truncate pl-[18px] text-xs text-muted-foreground" title={row.activeWorld}>
                        active world <span className="font-mono">{row.activeWorld}</span>
                      </div>
                    )}
                  </div>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
                </button>

                <div className="flex shrink-0 items-center gap-1.5">
                  {/* Lifecycle for EVERY server (Primary included), each behind a
                      confirmation dialog. Delete stays non-default only. Clicking
                      the row itself opens the server's dashboard (no Open button). */}
                  {row.running === true ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1"
                        disabled={rowBusy}
                        onClick={() => setLifecycleTarget({ row, action: 'restart' })}
                        title="Restart"
                      >
                        {busy === `restart:${row.id}` ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
                        <span className="hidden sm:inline">Restart</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1"
                        disabled={rowBusy}
                        onClick={() => setLifecycleTarget({ row, action: 'stop' })}
                        title="Stop"
                      >
                        {busy === `stop:${row.id}` ? <Spinner className="size-3.5" /> : <SquareIcon className="size-3.5" />}
                        <span className="hidden sm:inline">Stop</span>
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      className="h-8 gap-1"
                      disabled={rowBusy}
                      onClick={() => setLifecycleTarget({ row, action: 'start' })}
                      title="Start"
                    >
                      {busy === `start:${row.id}` ? <Spinner className="size-3.5" /> : <PlayIcon className="size-3.5" />}
                      <span className="hidden sm:inline">Start</span>
                    </Button>
                  )}
                  {!row.isDefault && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1 text-muted-foreground hover:text-destructive"
                      disabled={rowBusy}
                      onClick={() => setDeleteTarget(row)}
                      title="Delete (keeps saves)"
                    >
                      {busy === `delete:${row.id}` ? <Spinner className="size-3.5" /> : <Trash2Icon className="size-3.5" />}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {/* Lifecycle confirm — start/stop/restart, every server */}
      <AlertDialog open={lifecycleTarget !== null} onOpenChange={(o) => !o && setLifecycleTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {lifecycleTarget?.action === 'start' ? 'Start' : lifecycleTarget?.action === 'stop' ? 'Stop' : 'Restart'}{' '}
              {lifecycleTarget?.row.displayName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {lifecycleTarget?.row.isDefault && (
                <>
                  <span className="font-medium text-foreground">This is your Primary (live) server.</span>{' '}
                </>
              )}
              {lifecycleTarget?.action === 'start'
                ? 'The server boots up and becomes available once it finishes loading.'
                : lifecycleTarget?.action === 'stop'
                  ? 'Any connected players are warned by an in-game broadcast, then disconnected after a ~10s countdown. The server stays offline until you start it again.'
                  : 'Any connected players are warned by an in-game broadcast, then disconnected briefly while the server restarts (~15s countdown, then recreate).'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = lifecycleTarget
                setLifecycleTarget(null)
                if (t) void lifecycle(t.row, t.action)
              }}
              className={
                lifecycleTarget?.action === 'start'
                  ? undefined
                  : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              }
            >
              {lifecycleTarget?.action === 'start' ? 'Start' : lifecycleTarget?.action === 'stop' ? 'Stop server' : 'Restart server'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This stops and removes the <span className="font-mono">{deleteTarget?.id}</span> container and
              takes it off the dashboard. Its <span className="font-medium">save files are kept</span> on disk
              (at the instance&apos;s <span className="font-mono">game/</span> folder) — nothing in the world is
              deleted. This cannot re-add the instance automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete (keep saves)
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Create wizard */}
      <AlertDialog open={createOpen} onOpenChange={(o) => (o ? setCreateOpen(true) : closeCreate())}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>New Palworld server</AlertDialogTitle>
            <AlertDialogDescription>
              Creates a brand-new server: the dashboard allocates free ports, generates its passwords, and
              brings it up. <span className="font-medium">First boot downloads &amp; installs the game via
              SteamCMD</span> — this takes several minutes and uses real CPU/RAM/disk alongside your live
              server.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {provId ? (
            <div className="flex flex-col gap-2 py-1">
              <div className="flex items-center gap-2 text-sm">
                {prov && ['ready', 'timeout', 'failed'].includes(prov.phase) ? null : <Spinner className="size-4" />}
                <span className="font-medium">{provId}</span>
                <Badge variant="outline">{prov?.phase ?? 'queued'}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{prov?.message ?? 'Working…'}</p>
              {prov?.phase === 'ready' && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">Server is up and answering the REST API.</p>
              )}
              {prov?.phase === 'timeout' && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Container started but the REST API hasn&apos;t answered yet — it may still be installing. Check
                  back shortly.
                </p>
              )}
              {prov?.phase === 'failed' && (
                <p className="text-xs text-destructive">Provisioning failed — see the daemon log.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 py-1">
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Server name</span>
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Creative World" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Max players</span>
                <Input
                  type="number"
                  min={1}
                  max={128}
                  value={newMax}
                  onChange={(e) => setNewMax(e.target.value)}
                  className="w-28"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Server password</span>
                <Input
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="blank = public (anyone can join)"
                  autoComplete="off"
                />
                <span className="text-[11px] text-muted-foreground">
                  Letters &amp; numbers only. Players enter this to join; leave blank for a public server.
                </span>
              </label>
            </div>
          )}

          <AlertDialogFooter>
            {provId ? (
              <AlertDialogCancel onClick={closeCreate}>Close</AlertDialogCancel>
            ) : (
              <>
                <AlertDialogCancel onClick={closeCreate}>Cancel</AlertDialogCancel>
                <Button onClick={startCreate} disabled={creating || !newName.trim()} className="gap-1.5">
                  {creating ? <Spinner className="size-4" /> : <PlusIcon className="size-4" />}
                  Create server
                </Button>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
