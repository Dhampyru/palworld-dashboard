'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { PanelSection } from '@/components/server-control-cards'
import { RotateCcwIcon, PencilIcon, SaveIcon } from 'lucide-react'

// PATCH (not upstream): witty player-death announcements (docs/specs/scheduled-broadcasts.md).
// PalDefender logs deaths with cause; the dashboard tails that log and broadcasts an editable
// witty line per cause. Admin-only; the loop runs server-side (lib/death-announce).

// Cause order + labels mirror lib/death-announce (kept local so this client file never imports
// the node:fs-touching server lib). Placeholders: {name} victim, {killer}, {pal}.
const CAUSES: { key: string; label: string; hint: string }[] = [
  { key: 'wildPal', label: 'Killed by a wild Pal', hint: '{name}, {pal}' },
  { key: 'killedBy', label: 'Killed by someone', hint: '{name}, {killer}' },
  { key: 'towerBoss', label: 'Killed by a tower boss', hint: '{name}, {killer}' },
  { key: 'temperature', label: 'Extreme temperature', hint: '{name}' },
  { key: 'poison', label: 'Poison', hint: '{name}' },
  { key: 'explosion', label: 'Explosion', hint: '{name}' },
  { key: 'noAttacker', label: 'No attacker (fall/self)', hint: '{name}' },
  { key: 'unknown', label: 'Unknown cause', hint: '{name}' },
]

type Schedule = {
  enabled: boolean
  prefix: string
  templates: Record<string, string[]>
  lastMessage: string | null
  lastAt: string | null
}

export function DeathAnnounceCard() {
  const { config } = useServer()
  const [busy, setBusy] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [prefix, setPrefix] = useState('')
  const [text, setText] = useState<Record<string, string>>({})
  const [defaults, setDefaults] = useState<Record<string, string[]>>({})
  const [status, setStatus] = useState<Pick<Schedule, 'lastMessage' | 'lastAt'> | null>(null)
  // Per-Pal JSON editor (data/death-pal-messages.json).
  const [palOpen, setPalOpen] = useState(false)
  const [palText, setPalText] = useState('')
  const [palBusy, setPalBusy] = useState<null | 'load' | 'save'>(null)
  const [palDirty, setPalDirty] = useState(false)

  const headers = useCallback(
    (json = false) => ({
      ...(config ? buildPalworldProxyHeaders(config) : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }),
    [config],
  )

  const applyTemplates = (t: Record<string, string[]>) => {
    const next: Record<string, string> = {}
    for (const c of CAUSES) next[c.key] = (t[c.key] ?? []).join('\n')
    setText(next)
  }

  const load = useCallback(async () => {
    if (!config) return
    try {
      const r = await fetch('/api/death-announce', { headers: headers(), cache: 'no-store' })
      const j = await r.json()
      if (r.ok && j.schedule) {
        const s = j.schedule as Schedule
        setEnabled(s.enabled)
        setPrefix(s.prefix ?? '')
        applyTemplates(s.templates ?? {})
        setStatus({ lastMessage: s.lastMessage, lastAt: s.lastAt })
      }
      if (r.ok && j.defaults) setDefaults(j.defaults as Record<string, string[]>)
    } catch {
      /* leave defaults */
    }
  }, [config, headers])

  // Own always-open card now (was a collapsible) — load on mount / when the server changes.
  useEffect(() => {
    void load()
  }, [load])

  const save = useCallback(async () => {
    if (!config) return
    setBusy(true)
    const toastId = toast.loading('Saving…')
    try {
      const templates: Record<string, string[]> = {}
      for (const c of CAUSES) {
        templates[c.key] = (text[c.key] ?? '').split('\n').map((m) => m.trim()).filter(Boolean)
      }
      const r = await fetch('/api/death-announce', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ action: 'save', settings: { enabled, prefix, templates } }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'Failed')
      if (j.schedule) {
        const s = j.schedule as Schedule
        setEnabled(s.enabled)
        setPrefix(s.prefix ?? '')
        applyTemplates(s.templates ?? {})
        setStatus({ lastMessage: s.lastMessage, lastAt: s.lastAt })
      }
      toast.success('Saved', { id: toastId })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed', { id: toastId })
    } finally {
      setBusy(false)
    }
  }, [config, headers, enabled, prefix, text])

  const restoreDefaults = () => {
    if (Object.keys(defaults).length) applyTemplates(defaults)
    toast.message('Defaults restored — Save to apply')
  }

  const openPalEditor = useCallback(async () => {
    if (!config) return
    setPalOpen(true)
    setPalBusy('load')
    try {
      const r = await fetch('/api/death-announce', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ action: 'loadPalMessages' }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'Failed to load')
      setPalText(typeof j.raw === 'string' ? j.raw : '{}')
      setPalDirty(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load')
      setPalText('{}')
    } finally {
      setPalBusy(null)
    }
  }, [config, headers])

  const savePalMessages = useCallback(async () => {
    if (!config) return
    setPalBusy('save')
    const toastId = toast.loading('Saving per-Pal messages…')
    try {
      const r = await fetch('/api/death-announce', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ action: 'savePalMessages', raw: palText }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'Failed to save')
      if (typeof j.raw === 'string') setPalText(j.raw)
      setPalDirty(false)
      toast.success(`Saved — ${j.pals} Pals, ${j.lines} lines`, { id: toastId })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save', { id: toastId })
    } finally {
      setPalBusy(null)
    }
  }, [config, headers, palText])

  if (config?.accessTier !== 'admin') return null

  return (
    <PanelSection title="Death Announcements" subtitle="RIP Feed" status={enabled ? 'active' : 'complete'}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="shrink-0 text-xs text-muted-foreground">Prefix (optional)</span>
              <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="[RIP]" className="h-8 max-w-[10rem]" />
            </label>
            <Button size="sm" variant="ghost" onClick={restoreDefaults} className="ml-auto gap-1.5 text-xs">
              <RotateCcwIcon className="size-3.5" /> Restore defaults
            </Button>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            One witty line per row — a random one is picked per death. Deaths are read from
            PalDefender&apos;s own log (it must be running). Enabling starts fresh; past deaths aren&apos;t announced.
            Per-Pal lines (a specific set per Pal) can be supplied in <code>data/death-pal-messages.json</code>
            and take precedence over the generic &ldquo;wild Pal&rdquo; lines below.
          </p>

          <div className="flex flex-col gap-2.5">
            {CAUSES.map((c) => (
              <div key={c.key}>
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-xs font-medium">{c.label}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{c.hint}</span>
                </div>
                <textarea
                  value={text[c.key] ?? ''}
                  onChange={(e) => setText((t) => ({ ...t, [c.key]: e.target.value }))}
                  rows={2}
                  className="w-full resize-y rounded-md border bg-muted/20 p-2 font-mono text-[11px]"
                />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void openPalEditor()} className="gap-1.5">
              <PencilIcon className="size-3.5" /> Edit per-Pal JSON
            </Button>
          </div>
          {status?.lastMessage && (
            <p className="text-[11px] break-words text-emerald-600 dark:text-emerald-400" title={status.lastAt ?? ''}>
              Last: {status.lastMessage}
            </p>
          )}
        </div>

        <Sheet open={palOpen} onOpenChange={(o) => !o && palBusy !== 'save' && setPalOpen(false)}>
          <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-2xl">
            <SheetHeader>
              <SheetTitle>Per-Pal death messages</SheetTitle>
            </SheetHeader>
            <p className="text-xs text-muted-foreground">
              JSON map of <code>&quot;Friendly Pal Name&quot;: [&quot;line&quot;, …]</code>. Used for wild-Pal deaths when the
              killing Pal is listed; others fall back to the generic &ldquo;wild Pal&rdquo; lines. Use <code>{'{name}'}</code>{' '}
              for the victim. Validated on save; effective on the next death.
            </p>
            <textarea
              value={palText}
              onChange={(e) => {
                setPalText(e.target.value)
                setPalDirty(true)
              }}
              spellCheck={false}
              disabled={palBusy === 'load'}
              placeholder={palBusy === 'load' ? 'Loading…' : '{\n  "Lamball": ["{name} was rolled by a fluffy Lamball."]\n}'}
              className="min-h-0 flex-1 rounded-md border bg-muted/20 p-3 font-mono text-xs"
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void savePalMessages()} disabled={palBusy !== null || !palDirty} className="gap-1.5">
                <SaveIcon className="size-3.5" /> {palBusy === 'save' ? 'Saving…' : 'Save'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPalOpen(false)} disabled={palBusy === 'save'}>
                Close
              </Button>
            </div>
          </SheetContent>
        </Sheet>
    </PanelSection>
  )
}
