'use client'

// PATCH (not upstream): PalDefender (anti-cheat) config tab (docs/specs/
// paldefender-tab-spec.md). Staged edit -> review -> Save, same flow as the
// engine-tuning panel; after Save, "Apply now" runs reloadcfg so config + MOTD
// take effect without a restart. Schema is only the keys A0 verified present in
// 1.8.3. Graceful not-detected state when Config.json is absent (A3).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { DEMO_MODE } from '@/lib/demo-mode'
import { copyToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
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
import {
  ShieldAlertIcon,
  RefreshCwIcon,
  FileCodeIcon,
  TriangleAlertIcon,
  RotateCcwIcon,
  SaveIcon,
  EyeIcon,
  EyeOffIcon,
  CopyIcon,
  PlayIcon,
  SearchIcon,
  InfoIcon,
} from 'lucide-react'
import { KitsSection } from '@/components/kits-section'
import {
  PD_FIELDS,
  PD_GROUP_LABELS,
  type PdField,
  type PdGroup,
  type PdValue,
  type PdValues,
} from '@/lib/paldefender-config'

type RestInfo = { enabled: boolean | null; port: number | null; token: string | null }
type DiskState = { detected: boolean; version: string | null; values: PdValues; motd: string[]; raw: string; rest: RestInfo }

export function PalDefenderPanel() {
  const { config } = useServer()
  const [disk, setDisk] = useState<DiskState | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [touched, setTouched] = useState(false)
  const [formValues, setFormValues] = useState<PdValues>({})
  const [motdText, setMotdText] = useState('')
  // Settings search (40+ keys now) — filters by label AND raw key.
  const [query, setQuery] = useState('')
  const [tokenRevealed, setTokenRevealed] = useState(false)
  const [rawOpen, setRawOpen] = useState(false)
  const [rawText, setRawText] = useState('')
  const [rawConfirm, setRawConfirm] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/paldefender-config', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      const next: DiskState = {
        detected: Boolean(data.detected),
        version: data.version ?? null,
        values: (data.values ?? {}) as PdValues,
        motd: (data.motd ?? []) as string[],
        raw: data.raw ?? '',
        rest: (data.rest ?? { enabled: null, port: null, token: null }) as RestInfo,
      }
      setDisk(next)
      setTouched(false)
      setFormValues({ ...next.values })
      setMotdText(next.motd.join('\n'))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load PalDefender config')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    load()
  }, [load])

  const motdLines = useMemo(
    () => motdText.split('\n').map((l) => l.replace(/\r$/, '')).filter((l, i, arr) => !(l === '' && i === arr.length - 1)),
    [motdText],
  )
  const motdChanged = useMemo(() => JSON.stringify(motdLines) !== JSON.stringify(disk?.motd ?? []), [motdLines, disk])

  const changedScalars = useMemo(() => {
    if (!disk) return [] as string[]
    return PD_FIELDS.filter((f) => f.key in formValues && formValues[f.key] !== disk.values[f.key]).map((f) => f.key)
  }, [disk, formValues])

  const changeCount = changedScalars.length + (motdChanged ? 1 : 0)

  const editField = (key: string, value: PdValue) => {
    setTouched(true)
    setFormValues((p) => ({ ...p, [key]: value }))
    setSavedNotice(false)
  }

  const resetStaged = () => {
    if (!disk) return
    setTouched(false)
    setFormValues({ ...disk.values })
    setMotdText(disk.motd.join('\n'))
    setSavedNotice(false)
  }

  const save = useCallback(async () => {
    if (!config || !disk || changeCount === 0) return
    setSaving(true)
    try {
      const body: { mode: 'write'; values?: PdValues; motd?: string[] } = { mode: 'write' }
      if (changedScalars.length > 0) {
        body.values = Object.fromEntries(changedScalars.map((k) => [k, formValues[k]]))
      }
      if (motdChanged) body.motd = motdLines
      const response = await fetch('/api/paldefender-config', {
        method: 'PUT',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      toast.success(data.note ?? 'Saved')
      setSavedNotice(true)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [config, disk, changeCount, changedScalars, motdChanged, motdLines, formValues, load])

  const applyNow = useCallback(async () => {
    if (!config) return
    // A loading -> resolve toast: gives immediate, unmissable feedback on click
    // (the plain success toast was reported as never appearing), and the
    // message fallback keeps an empty error from rendering an invisible toast.
    const toastId = toast.loading('Reloading PalDefender config…')
    try {
      const response = await fetch('/api/paldefender-config', {
        method: 'PUT',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'reload' }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      toast.success('Applied — PalDefender reloaded its config', { id: toastId })
      setSavedNotice(false)
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'reloadcfg failed'
      toast.error(message, { id: toastId })
    }
  }, [config])

  const openRaw = () => {
    setRawText(disk?.raw ?? '')
    setRawOpen(true)
  }
  const saveRaw = useCallback(async () => {
    if (!config) return
    setSaving(true)
    try {
      const response = await fetch('/api/paldefender-config', {
        method: 'PUT',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'raw', content: rawText }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      toast.success('Saved raw Config.json')
      setSavedNotice(true)
      setRawOpen(false)
      setRawConfirm(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }, [config, rawText, load])

  const grouped = useMemo(() => {
    const groups: { group: PdGroup; fields: PdField[] }[] = []
    for (const field of PD_FIELDS) {
      let g = groups.find((x) => x.group === field.group)
      if (!g) { g = { group: field.group, fields: [] }; groups.push(g) }
      g.fields.push(field)
    }
    return groups
  }, [])

  // Filter by label OR raw key; drop groups with no match. MOTD/REST show when
  // the query is empty or matches their own keywords.
  const q = query.trim().toLowerCase()
  const filteredGroups = useMemo(
    () =>
      grouped
        .map((g) => ({ ...g, fields: g.fields.filter((f) => !q || f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q)) }))
        .filter((g) => g.fields.length > 0),
    [grouped, q],
  )
  const showMotd = !q || 'motd message'.includes(q)
  const showRest = !q || 'rest api token port enabled'.includes(q)

  // Not-detected state (spec A3).
  if (disk && !disk.detected) {
    return (
      <div className="flex h-full min-h-[30rem] flex-col items-center justify-center gap-3 p-8 text-center">
        <ShieldAlertIcon className="size-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold">PalDefender not detected</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          No PalDefender Config.json was found on the server. Install or enable PalDefender (see the
          Mods tab), then refresh.
        </p>
        <Button variant="outline" size="sm" onClick={load} className="gap-1.5">
          <RefreshCwIcon className="size-3.5" /> Refresh
        </Button>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-[30rem] flex-col p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldAlertIcon className="size-5" />
          <h2 className="text-lg font-semibold">PalDefender</h2>
          {disk?.version && <Badge variant="outline" className="text-[10px]">v{disk.version}</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openRaw} disabled={!disk} className="gap-1.5">
            <FileCodeIcon className="size-3.5" /> Edit raw file
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
            <RefreshCwIcon className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} /> Refresh
          </Button>
        </div>
      </div>

      <p className="mt-1 text-sm text-muted-foreground">
        PalDefender anti-cheat and exploit settings. Changes stage below and write to Config.json on
        Save; use <span className="font-medium">Apply now</span> to reload without a restart.
        Updating the mod itself lives in the Mods tab.
      </p>

      <div className="relative mt-2">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings by name or key…"
          className="pl-8"
          aria-label="Search PalDefender settings"
        />
      </div>

      {error && <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

      {savedNotice && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          <span>Saved to Config.json.</span>
          <Button size="sm" variant="outline" onClick={applyNow} className="gap-1.5">
            <PlayIcon className="size-3.5" /> Apply now (reloadcfg)
          </Button>
        </div>
      )}

      <ScrollArea className="mt-3 min-h-0 flex-1">
        <div className="flex flex-col gap-4 pb-24 pr-2">
          {!disk && loading && (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground"><Spinner className="size-4" /> Loading…</div>
          )}

          {!query && <KitsSection />}

          {filteredGroups.map(({ group, fields }) => (
            <div key={group} className="flex flex-col gap-3 rounded-md border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{PD_GROUP_LABELS[group]}</h3>
              {fields.map((field) => (
                <PdFieldRow
                  key={field.key}
                  field={field}
                  value={formValues[field.key]}
                  changed={changedScalars.includes(field.key)}
                  onChange={(v) => editField(field.key, v)}
                  disabled={!disk || saving}
                />
              ))}
            </div>
          ))}

          {/* MOTD */}
          {showMotd && (
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">MOTD</h3>
              {motdChanged && <span className="size-1.5 rounded-full bg-amber-500" />}
            </div>
            <p className="text-[11px] text-muted-foreground">One message per line; empty = disabled. Placeholders like {'{PlayerName}'} pass through verbatim.</p>
            <textarea
              value={motdText}
              onChange={(e) => { setMotdText(e.target.value); setTouched(true); setSavedNotice(false) }}
              spellCheck={false}
              rows={4}
              disabled={!disk || saving}
              className="rounded-md border bg-muted/20 p-2 font-mono text-xs"
            />
          </div>

          )}

          {/* REST API (display + masked token) */}
          {showRest && disk?.rest && (
            <div className="flex flex-col gap-2 rounded-md border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">PalDefender REST API</h3>
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant={disk.rest.enabled ? 'secondary' : 'outline'} className="text-[10px]">
                  {disk.rest.enabled ? 'enabled' : disk.rest.enabled === false ? 'disabled' : 'unknown'}
                </Badge>
                {disk.rest.port != null && <Badge variant="outline" className="text-[10px]">port {disk.rest.port}</Badge>}
              </div>
              {disk.rest.token ? (
                <div className="flex items-center gap-2">
                  <Label className="text-xs">Access token</Label>
                  <code className="flex-1 truncate rounded border bg-muted/30 px-2 py-1 font-mono text-[11px]">
                    {tokenRevealed ? disk.rest.token : '•'.repeat(24)}
                  </code>
                  <button type="button" onClick={() => setTokenRevealed((v) => !v)} title={tokenRevealed ? 'Hide token' : 'Reveal token'} className="rounded p-1 text-muted-foreground hover:text-primary">
                    {tokenRevealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                  </button>
                  <button type="button" onClick={() => void copyToClipboard(disk.rest.token ?? '', { label: 'REST token' })} title="Copy token" className="rounded p-1 text-muted-foreground hover:text-primary">
                    <CopyIcon className="size-3.5" />
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">No token file found.</p>
              )}
              <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-semibold">Read-only by design.</span> There is intentionally no
                  regenerate button: the dashboard authenticates to PalDefender with this exact token, so
                  rotating it here would sever the dashboard&apos;s own connection. Regenerate it out-of-band
                  and update <code>PALDEFENDER_REST_TOKEN</code> if you ever must.
                </span>
              </p>
            </div>
          )}
        </div>
      </ScrollArea>

      {changeCount > 0 && (
        <div className="absolute inset-x-4 bottom-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 shadow-lg backdrop-blur">
          <span className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            <TriangleAlertIcon className="size-4" />
            {changeCount} unsaved change{changeCount === 1 ? '' : 's'} — apply after saving
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={resetStaged} disabled={saving} className="gap-1.5"><RotateCcwIcon className="size-3.5" /> Reset</Button>
            <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">{saving ? <Spinner className="size-4" /> : <SaveIcon className="size-4" />} Save changes</Button>
          </div>
        </div>
      )}

      {/* Raw editor */}
      <Sheet open={rawOpen} onOpenChange={setRawOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-2xl">
          <SheetHeader><SheetTitle>Edit Config.json</SheetTitle></SheetHeader>
          <p className="text-xs text-muted-foreground">Writes the file verbatim after a JSON check — the escape hatch for keys this panel doesn&apos;t manage. Malformed JSON is refused (it would kill the mod&apos;s config load).</p>
          <textarea value={rawText} onChange={(e) => setRawText(e.target.value)} spellCheck={false} className="min-h-0 flex-1 rounded-md border bg-muted/20 p-3 font-mono text-xs" />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRawOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => setRawConfirm(true)} disabled={saving}>Save raw file</Button>
          </div>
        </SheetContent>
      </Sheet>
      <AlertDialog open={rawConfirm} onOpenChange={setRawConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Overwrite Config.json?</AlertDialogTitle>
            <AlertDialogDescription>Writes your text to Config.json exactly as shown (after a JSON validity check). Use Apply now afterwards to reload.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={saveRaw}>Overwrite</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function PdFieldRow({
  field,
  value,
  changed,
  onChange,
  disabled,
}: {
  field: PdField
  value: PdValue | undefined
  changed: boolean
  onChange: (value: PdValue) => void
  disabled: boolean
}) {
  return (
    <div className={`flex flex-col gap-1 ${field.danger ? 'rounded-md border border-destructive/30 bg-destructive/5 p-2' : ''}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-2 text-sm">
          {field.label}
          {changed && <span className="size-1.5 rounded-full bg-amber-500" aria-label="changed" />}
          {field.danger && <Badge variant="destructive" className="text-[9px]">danger</Badge>}
        </Label>
        {field.kind === 'bool' ? (
          <Switch checked={Boolean(value)} onCheckedChange={(c) => onChange(c)} disabled={disabled} />
        ) : (
          <div className="flex items-center gap-2">
            {field.min !== undefined && field.max !== undefined && (
              <input type="range" value={Number(value ?? 0)} min={field.min} max={field.max} step={field.step ?? 1}
                onChange={(e) => onChange(field.kind === 'int' ? parseInt(e.target.value, 10) : parseFloat(e.target.value))}
                disabled={disabled} className="w-28 accent-primary" />
            )}
            <Input type="number" value={String(value ?? '')} min={field.min} max={field.max} step={field.step ?? 1}
              onChange={(e) => { if (e.target.value === '') return; onChange(field.kind === 'int' ? parseInt(e.target.value, 10) : parseFloat(e.target.value)) }}
              disabled={disabled} className="w-24 font-mono text-sm" />
          </div>
        )}
      </div>
      {field.description && <p className="text-[11px] text-muted-foreground">{field.description}</p>}
      {field.sentinel && <p className="text-[11px] text-muted-foreground">{field.sentinel}</p>}
      {field.warning && <p className="text-[11px] text-amber-600 dark:text-amber-400">{field.warning}</p>}
    </div>
  )
}
