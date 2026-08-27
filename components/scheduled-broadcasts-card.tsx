'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { PanelSection } from '@/components/server-control-cards'
import { RefreshCwIcon, SendIcon } from 'lucide-react'

// PATCH (not upstream): scheduled/recurring broadcasts (docs/specs/scheduled-broadcasts.md).
// Cycles through a message list on an interval via RCON (pgbroadcast when PalDefender is on,
// else vanilla Broadcast). Admin-only; the loop runs server-side (lib/broadcast-schedule).
type Schedule = {
  enabled: boolean
  intervalMinutes: number
  messages: string[]
  prefix: string
  skipWhenEmpty: boolean
  keybindTipsEnabled: boolean
  keybindTips: string[]
  lastStatus: 'ok' | 'skipped-empty' | 'error' | null
  lastMessage: string | null
  lastCheckAt: string | null
  welcomeEnabled: boolean
  welcomeMessages: string[]
  welcomeLastMessage: string | null
  welcomeLastAt: string | null
}

export function ScheduledBroadcastsCard() {
  const { config } = useServer()
  const [busy, setBusy] = useState<null | 'save' | 'test'>(null)
  const [enabled, setEnabled] = useState(false)
  const [interval, setIntervalMin] = useState(15)
  const [messagesText, setMessagesText] = useState('')
  const [prefix, setPrefix] = useState('')
  const [skipWhenEmpty, setSkipWhenEmpty] = useState(true)
  const [welcomeEnabled, setWelcomeEnabled] = useState(false)
  const [welcomeText, setWelcomeText] = useState('')
  const [keybindTipsEnabled, setKeybindTipsEnabled] = useState(false)
  const [keybindTips, setKeybindTips] = useState<string[]>([])
  const [status, setStatus] = useState<Pick<Schedule, 'lastStatus' | 'lastMessage' | 'lastCheckAt'> | null>(null)
  const [welcomeStatus, setWelcomeStatus] = useState<Pick<Schedule, 'welcomeLastMessage' | 'welcomeLastAt'> | null>(null)

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
    setWelcomeEnabled(s.welcomeEnabled ?? false)
    setWelcomeText((s.welcomeMessages ?? []).join('\n'))
    setKeybindTipsEnabled(s.keybindTipsEnabled ?? false)
    setKeybindTips(s.keybindTips ?? [])
    setStatus({ lastStatus: s.lastStatus, lastMessage: s.lastMessage, lastCheckAt: s.lastCheckAt })
    setWelcomeStatus({ welcomeLastMessage: s.welcomeLastMessage, welcomeLastAt: s.welcomeLastAt })
  }

  const load = useCallback(async () => {
    if (!config) return
    try {
      const r = await fetch('/api/broadcast-schedule', { headers: headers(), cache: 'no-store' })
      const j = await r.json()
      if (r.ok && j.schedule) apply(j.schedule as Schedule)
    } catch {
      /* leave defaults */
    }
  }, [config, headers])

  // Own always-open card now (was a collapsible) — load on mount / when the server changes.
  useEffect(() => {
    void load()
  }, [load])

  const settings = () => ({
    enabled,
    intervalMinutes: interval,
    messages: messagesText.split('\n').map((m) => m.trim()).filter(Boolean),
    prefix,
    skipWhenEmpty,
    welcomeEnabled,
    welcomeMessages: welcomeText.split('\n').map((m) => m.trim()).filter(Boolean),
    keybindTipsEnabled, // keybindTips themselves are generated, not form-edited
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
    [config, headers, enabled, interval, messagesText, prefix, skipWhenEmpty, welcomeEnabled, welcomeText, keybindTipsEnabled],
  )

  // Phase-4 propagation: regenerate the keybind tips from the current keybind set.
  const regenerateTips = useCallback(async () => {
    if (!config) return
    setBusy('save')
    const toastId = toast.loading('Generating keybind tips…')
    try {
      const r = await fetch('/api/broadcast-schedule', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ action: 'generateKeybindTips' }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'Failed')
      if (j.schedule) apply(j.schedule as Schedule)
      toast.success(`Generated ${j.tips?.length ?? 0} keybind tip${j.tips?.length === 1 ? '' : 's'}`, { id: toastId })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed', { id: toastId })
    } finally {
      setBusy(null)
    }
  }, [config, headers])

  // Admin-only surface.
  if (config?.accessTier !== 'admin') return null
  const count = messagesText.split('\n').filter((m) => m.trim()).length

  return (
    <PanelSection title="Scheduled Broadcasts" subtitle="Auto Messages" status={enabled ? 'active' : 'complete'}>
        <div className="flex flex-col gap-3">
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

          {/* On-join welcome — event-driven, separate from the interval rotation. */}
          <div className="flex flex-col gap-2 rounded-md border border-border/50 bg-muted/10 p-2.5">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={welcomeEnabled} onCheckedChange={setWelcomeEnabled} />
              Welcome new players on join
            </label>
            <textarea
              value={welcomeText}
              onChange={(e) => setWelcomeText(e.target.value)}
              rows={3}
              placeholder={'Welcome, {name}!\nType /help for commands'}
              className="w-full resize-y rounded-md border bg-muted/20 p-2 font-mono text-xs"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Broadcast to everyone in order when a player joins. Use <code>{'{name}'}</code> for the joining
              player&apos;s name. Enabling starts fresh — already-connected players aren&apos;t welcomed.
            </p>
            {welcomeStatus?.welcomeLastMessage && (
              <p className="text-[11px] break-words text-emerald-600 dark:text-emerald-400" title={welcomeStatus.welcomeLastAt ?? ''}>
                Last welcome: {welcomeStatus.welcomeLastMessage}
              </p>
            )}
          </div>

          {/* Phase-4 propagation: keybind tips generated from the current keybind set, rotated
              alongside the messages above when enabled. */}
          <div className="flex flex-col gap-2 rounded-md border border-border/50 bg-muted/10 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={keybindTipsEnabled} onCheckedChange={setKeybindTipsEnabled} />
                Include keybind tips in the rotation
              </label>
              <Button size="sm" variant="outline" onClick={() => void regenerateTips()} disabled={busy !== null} className="gap-1.5">
                <RefreshCwIcon className={busy === 'save' ? 'size-3.5 animate-spin' : 'size-3.5'} /> Regenerate from keybinds
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Auto-generated from this loadout&apos;s mod keybinds — one line per mod. Regenerate after a remap so the
              tips stay current. Your messages above are untouched. Remember to Save after toggling.
            </p>
            {keybindTips.length > 0 ? (
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted-foreground">
                  {keybindTips.length} keybind tip{keybindTips.length === 1 ? '' : 's'} {keybindTipsEnabled ? '(in rotation)' : '(off)'}
                </summary>
                <ul className="mt-1 space-y-0.5 border-l-2 border-border pl-2 font-mono">
                  {keybindTips.map((t, i) => (
                    <li key={i} className="break-words">
                      {t}
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <p className="text-[11px] text-muted-foreground">No tips yet — click “Regenerate from keybinds”.</p>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Sent via <code>pgbroadcast</code> (PalDefender — supports spaces) when available, else vanilla{' '}
            <code>Broadcast</code> (spaces become underscores). Non-ASCII characters are stripped.
          </p>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void post('save')} disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void post('test')}
              disabled={busy !== null || (count === 0 && !(keybindTipsEnabled && keybindTips.length > 0))}
              className="gap-1.5"
            >
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
    </PanelSection>
  )
}
