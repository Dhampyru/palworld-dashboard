'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ChevronDownIcon, ChevronRightIcon, MegaphoneIcon, SendIcon } from 'lucide-react'

// PATCH (not upstream): scheduled/recurring broadcasts (docs/specs/scheduled-broadcasts.md).
// Cycles through a message list on an interval via RCON (pgbroadcast when PalDefender is on,
// else vanilla Broadcast). Admin-only; the loop runs server-side (lib/broadcast-schedule).
type Schedule = {
  enabled: boolean
  intervalMinutes: number
  messages: string[]
  prefix: string
  skipWhenEmpty: boolean
  lastStatus: 'ok' | 'skipped-empty' | 'error' | null
  lastMessage: string | null
  lastCheckAt: string | null
}

export function ScheduledBroadcastsCard() {
  const { config } = useServer()
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<null | 'save' | 'test'>(null)
  const [enabled, setEnabled] = useState(false)
  const [interval, setIntervalMin] = useState(15)
  const [messagesText, setMessagesText] = useState('')
  const [prefix, setPrefix] = useState('')
  const [skipWhenEmpty, setSkipWhenEmpty] = useState(true)
  const [status, setStatus] = useState<Pick<Schedule, 'lastStatus' | 'lastMessage' | 'lastCheckAt'> | null>(null)

  const headers = useCallback(
    (json = false) => ({
      ...(config ? buildPalworldProxyHeaders(config) : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }),
    [config],
  )

  const apply = (s: Schedule) => {
    setEnabled(s.enabled)
    setIntervalMin(s.intervalMinutes)
    setMessagesText((s.messages ?? []).join('\n'))
    setPrefix(s.prefix ?? '')
    setSkipWhenEmpty(s.skipWhenEmpty)
    setStatus({ lastStatus: s.lastStatus, lastMessage: s.lastMessage, lastCheckAt: s.lastCheckAt })
  }

  const load = useCallback(async () => {
    if (!config) return
    try {
      const r = await fetch('/api/broadcast-schedule', { headers: headers(), cache: 'no-store' })
      const j = await r.json()
      if (r.ok && j.schedule) apply(j.schedule as Schedule)
    } catch {
      /* leave defaults */
    } finally {
      setLoaded(true)
    }
  }, [config, headers])

  useEffect(() => {
    if (open && !loaded) void load()
  }, [open, loaded, load])

  const settings = () => ({
    enabled,
    intervalMinutes: interval,
    messages: messagesText.split('\n').map((m) => m.trim()).filter(Boolean),
    prefix,
    skipWhenEmpty,
  })

  const post = useCallback(
    async (action: 'save' | 'test') => {
      if (!config) return
      setBusy(action)
      const toastId = toast.loading(action === 'save' ? 'Saving…' : 'Sending test…')
      try {
        const r = await fetch('/api/broadcast-schedule', {
          method: 'POST',
          headers: headers(true),
          body: JSON.stringify(action === 'save' ? { action, settings: settings() } : { action }),
        })
        const j = await r.json()
        if (!r.ok) throw new Error(j.error ?? 'Failed')
        if (j.schedule) apply(j.schedule as Schedule)
        if (action === 'test') {
          const st = (j.schedule as Schedule).lastStatus
          st === 'ok'
            ? toast.success('Broadcast sent', { id: toastId })
            : toast.warning((j.schedule as Schedule).lastMessage ?? 'Not sent', { id: toastId })
        } else {
          toast.success('Saved', { id: toastId })
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed', { id: toastId })
      } finally {
        setBusy(null)
      }
    },
    [config, headers, enabled, interval, messagesText, prefix, skipWhenEmpty],
  )

  // Admin-only surface.
  if (config?.accessTier !== 'admin') return null
  const count = messagesText.split('\n').filter((m) => m.trim()).length

  return (
    <div className="shrink-0 rounded-md border border-border/60 bg-card/40">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        <MegaphoneIcon className="size-4 text-primary" />
        <span className="font-medium">Scheduled broadcasts</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {enabled ? `every ${interval}m · ${count} msg${count === 1 ? '' : 's'}` : 'off'}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-border/50 p-3">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              Every
              <Input
                type="number"
                min={1}
                max={1440}
                value={interval}
                onChange={(e) => setIntervalMin(Number(e.target.value) || 1)}
                className="h-8 w-20 text-right"
              />
              min
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={skipWhenEmpty} onCheckedChange={setSkipWhenEmpty} />
              Skip when empty
            </label>
          </div>

          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">
              Messages — one per line, cycled in order
            </div>
            <textarea
              value={messagesText}
              onChange={(e) => setMessagesText(e.target.value)}
              rows={5}
              placeholder={'Welcome to Palkatraz!\nType /help for commands\nBackups run automatically'}
              className="w-full resize-y rounded-md border bg-muted/20 p-2 font-mono text-xs"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <span className="shrink-0 text-xs text-muted-foreground">Prefix (optional)</span>
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="[Server]" className="h-8 max-w-[12rem]" />
          </label>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Sent via <code>pgbroadcast</code> (PalDefender — supports spaces) when available, else vanilla{' '}
            <code>Broadcast</code> (spaces become underscores). Non-ASCII characters are stripped.
          </p>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void post('save')} disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void post('test')} disabled={busy !== null || count === 0} className="gap-1.5">
              <SendIcon className="size-3.5" /> Test (send next now)
            </Button>
          </div>
          {status?.lastStatus && (
            <p
              className={`text-[11px] break-words ${
                status.lastStatus === 'ok'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : status.lastStatus === 'error'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-muted-foreground'
              }`}
              title={status.lastCheckAt ?? ''}
            >
              Last: {status.lastMessage}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
