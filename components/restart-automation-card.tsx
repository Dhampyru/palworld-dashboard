'use client'

// PATCH (not upstream): Restart automation card (roadmap #6 completion,
// docs/specs/restart-automation.md). Self-contained; lives in the Maintenance
// tab beside Auto-backup. Four groups — Scheduled, Memory, Crash, Countdown —
// over the one in-process monitor (lib/auto-restart.ts). Supersedes the interim
// Engine-tab card. Reads/writes /api/auto-restart (settings + live metrics +
// derived next-scheduled / used-this-hour).
import { useCallback, useEffect, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { RotateCwIcon, SaveIcon, ActivityIcon, ClockIcon, MemoryStickIcon, ZapIcon } from 'lucide-react'

type AutoRestart = {
  scheduledEnabled: boolean
  scheduleMode: 'interval' | 'daily'
  everyMinutes: number
  dailyTimes: string[]
  memoryEnabled: boolean
  memoryMb: number
  memorySustainedChecks: number
  crashEnabled: boolean
  maxPerHour: number
  restartWaittime: number
  lastActionAt: string | null
  lastReason: 'scheduled' | 'memory' | 'crash' | null
  lastStatus: 'ok' | 'capped' | 'error' | null
}
type Metrics = { status?: string; memBytes?: number | null } | null
type Payload = { settings: AutoRestart; metrics: Metrics; nextScheduled: string | null; usedThisHour: number }

function fmtWhen(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function RestartAutomationCard() {
  const { config } = useServer()
  const [s, setS] = useState<AutoRestart | null>(null)
  const [metrics, setMetrics] = useState<Metrics>(null)
  const [nextScheduled, setNextScheduled] = useState<string | null>(null)
  const [usedThisHour, setUsedThisHour] = useState(0)
  const [timesInput, setTimesInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const apply = useCallback((p: Payload) => {
    setS(p.settings)
    setMetrics(p.metrics ?? null)
    setNextScheduled(p.nextScheduled)
    setUsedThisHour(p.usedThisHour)
    setTimesInput(p.settings.dailyTimes.join(', '))
  }, [])

  const load = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/auto-restart', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const json = await res.json()
      if (res.ok) apply(json as Payload)
    } catch {
      /* loading state */
    }
  }, [config, apply])

  useEffect(() => {
    void load()
  }, [load])

  const patch = useCallback((p: Partial<AutoRestart>) => setS((cur) => (cur ? { ...cur, ...p } : cur)), [])

  const save = useCallback(async () => {
    if (!config || !s) return
    setSaving(true)
    const toastId = toast.loading('Saving…')
    try {
      const dailyTimes = timesInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const res = await fetch('/api/auto-restart', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          settings: {
            scheduledEnabled: s.scheduledEnabled,
            scheduleMode: s.scheduleMode,
            everyMinutes: s.everyMinutes,
            dailyTimes,
            memoryEnabled: s.memoryEnabled,
            memoryMb: s.memoryMb,
            memorySustainedChecks: s.memorySustainedChecks,
            crashEnabled: s.crashEnabled,
            maxPerHour: s.maxPerHour,
            restartWaittime: s.restartWaittime,
          },
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      apply(json as Payload)
      toast.success((json.note as string) ?? 'Saved', { id: toastId })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Save failed', { id: toastId })
    } finally {
      setSaving(false)
    }
  }, [config, s, timesInput, apply])

  const test = useCallback(async () => {
    if (!config) return
    setTesting(true)
    const toastId = toast.loading('Testing…')
    try {
      const res = await fetch('/api/auto-restart', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      apply(json as Payload)
      toast.success((json.note as string) ?? 'Done', { id: toastId })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Test failed', { id: toastId })
    } finally {
      setTesting(false)
    }
  }, [config, apply])

  const memGb =
    metrics && typeof metrics.memBytes === 'number' ? (metrics.memBytes / 1024 ** 3).toFixed(2) : null

  return (
    <section className="flex flex-col gap-3 rounded-md border p-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <RotateCwIcon className="size-3.5" /> Restart automation
      </h3>

      {!s ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <ActivityIcon className="size-3.5" />
            Memory <span className="text-foreground">{memGb ? `${memGb} GB` : '—'}</span>
            {metrics?.status && <span>· {metrics.status}</span>}
            <span>
              · used <span className="text-foreground">{usedThisHour}</span>/{s.maxPerHour} this hour
            </span>
            {nextScheduled && (
              <span>
                · next <span className="text-foreground">{fmtWhen(nextScheduled)}</span>
              </span>
            )}
          </p>

          {/* 3. Crash / hang */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <ZapIcon className="mt-0.5 size-4 text-muted-foreground" />
              <div>
                <div className="text-xs font-medium">Crash / hang restart</div>
                <div className="text-[11px] text-muted-foreground">
                  Restart when the server stops responding. No countdown (it&apos;s already gone).
                </div>
              </div>
            </div>
            <Switch checked={s.crashEnabled} onCheckedChange={(v) => patch({ crashEnabled: v })} />
          </div>

          {/* 2. Memory */}
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <MemoryStickIcon className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <div className="text-xs font-medium">Memory threshold restart</div>
                  <div className="text-[11px] text-muted-foreground">
                    Restart when RSS stays over the ceiling for N samples (~{s.memorySustainedChecks * 30}s).
                  </div>
                </div>
              </div>
              <Switch checked={s.memoryEnabled} onCheckedChange={(v) => patch({ memoryEnabled: v })} />
            </div>
            {s.memoryEnabled && (
              <div className="grid grid-cols-2 gap-3 pl-6">
                <div className="flex flex-col gap-1">
                  <Label className="text-[11px] text-muted-foreground">Ceiling (MB)</Label>
                  <Input
                    type="number"
                    min={0}
                    className="h-8 text-xs"
                    value={s.memoryMb}
                    onChange={(e) => patch({ memoryMb: Number(e.target.value) })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-[11px] text-muted-foreground">Breaches</Label>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    className="h-8 text-xs"
                    value={s.memorySustainedChecks}
                    onChange={(e) => patch({ memorySustainedChecks: Number(e.target.value) })}
                  />
                </div>
              </div>
            )}
          </div>

          {/* 1. Scheduled */}
          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <ClockIcon className="mt-0.5 size-4 text-muted-foreground" />
                <div>
                  <div className="text-xs font-medium">Scheduled restart</div>
                  <div className="text-[11px] text-muted-foreground">Proactive restarts with a countdown.</div>
                </div>
              </div>
              <Switch checked={s.scheduledEnabled} onCheckedChange={(v) => patch({ scheduledEnabled: v })} />
            </div>
            {s.scheduledEnabled && (
              <div className="flex flex-col gap-2 pl-6">
                <div className="flex gap-1">
                  {(['daily', 'interval'] as const).map((mode) => (
                    <Button
                      key={mode}
                      size="sm"
                      variant={s.scheduleMode === mode ? 'default' : 'outline'}
                      className="h-7 text-[11px] capitalize"
                      onClick={() => patch({ scheduleMode: mode })}
                    >
                      {mode === 'daily' ? 'Daily times' : 'Every N min'}
                    </Button>
                  ))}
                </div>
                {s.scheduleMode === 'daily' ? (
                  <div className="flex flex-col gap-1">
                    <Label className="text-[11px] text-muted-foreground">
                      Times (HH:MM, comma-separated — server time)
                    </Label>
                    <Input
                      className="h-8 text-xs"
                      placeholder="04:00, 16:00"
                      value={timesInput}
                      onChange={(e) => setTimesInput(e.target.value)}
                    />
                  </div>
                ) : (
                  <div className="flex w-40 flex-col gap-1">
                    <Label className="text-[11px] text-muted-foreground">Every (minutes, min 30)</Label>
                    <Input
                      type="number"
                      min={30}
                      className="h-8 text-xs"
                      value={s.everyMinutes}
                      onChange={(e) => patch({ everyMinutes: Number(e.target.value) })}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 4. Limits / countdown */}
          <div className="grid grid-cols-2 gap-3 border-t pt-2">
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] text-muted-foreground">Max restarts / hour</Label>
              <Input
                type="number"
                min={1}
                max={20}
                className="h-8 text-xs"
                value={s.maxPerHour}
                onChange={(e) => patch({ maxPerHour: Number(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] text-muted-foreground">Countdown (sec)</Label>
              <Input
                type="number"
                min={0}
                max={600}
                className="h-8 text-xs"
                value={s.restartWaittime}
                onChange={(e) => patch({ restartWaittime: Number(e.target.value) })}
              />
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Last action: <span className="text-foreground">{fmtWhen(s.lastActionAt)}</span>
            {s.lastReason && <> · {s.lastReason}</>}
            {s.lastStatus && s.lastStatus !== 'ok' && (
              <span className={s.lastStatus === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}>
                {' '}
                ({s.lastStatus})
              </span>
            )}
          </p>

          <div className="flex items-center gap-2">
            <Button size="sm" className="h-8 gap-1.5" onClick={save} disabled={saving}>
              {saving ? <Spinner className="size-3.5" /> : <SaveIcon className="size-3.5" />}
              Save settings
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5"
              onClick={test}
              disabled={testing}
              title="Queues a dry-run restart request (broadcast only, no recreate)"
            >
              {testing ? <Spinner className="size-3.5" /> : <RotateCwIcon className="size-3.5" />}
              Test
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
