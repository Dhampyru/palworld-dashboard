'use client'

// PATCH (not upstream): Engine tuning panel (docs/specs/engine-tuning-spec.md).
//
// Manages Engine.ini engine/network tuning via /api/engine-tuning. Same
// edit -> review -> save flow as world settings: clicking a preset or editing a
// field only STAGES; nothing touches disk until Save. Preset highlight tracks
// DISK state; staged-but-unsaved shows in the bottom bar, not the highlight
// (spec §4.4).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { DEMO_MODE } from '@/lib/demo-mode'
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
import { GaugeIcon, RefreshCwIcon, FileCodeIcon, TriangleAlertIcon, RotateCcwIcon, SaveIcon } from 'lucide-react'
import {
  BUILTIN_DISPLAY_VALUES,
  ENGINE_FIELDS,
  ENGINE_PRESETS,
  type EngineField,
  type EngineValue,
  type EngineValues,
  PRESET_VALUES,
  type PresetId,
  type PresetMeta,
  detectPreset,
  formatEngineValue,
} from '@/lib/engine-tuning'
import { type LaunchInfo, LAUNCH_FLAGS_NOTE } from '@/lib/engine-launch'

type DiskState = {
  exists: boolean
  values: EngineValues
  preset: PresetId | 'custom'
  raw: string
  launch: LaunchInfo | null
}

const GROUP_LABELS: Record<string, string> = {
  network: 'Network',
  framerate: 'Frame rate',
  memory: 'Memory',
}

function mergeWithBuiltins(diskValues: EngineValues): EngineValues {
  return { ...BUILTIN_DISPLAY_VALUES, ...diskValues }
}

export function EngineTuningPanel() {
  const { config } = useServer()
  const [disk, setDisk] = useState<DiskState | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Staged form state. `touched` false means "untouched since load", so the
  // effective state equals disk exactly and no save is pending -- this keeps a
  // freshly-loaded panel at zero changes for any disk shape (spec §4/§6).
  const [touched, setTouched] = useState(false)
  const [resetIntent, setResetIntent] = useState(false)
  const [formValues, setFormValues] = useState<EngineValues>(BUILTIN_DISPLAY_VALUES)

  const [confirmPreset, setConfirmPreset] = useState<PresetMeta | null>(null)
  const [rawOpen, setRawOpen] = useState(false)
  const [rawText, setRawText] = useState('')
  const [rawConfirm, setRawConfirm] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/engine-tuning', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      const next: DiskState = {
        exists: Boolean(data.exists),
        values: (data.values ?? {}) as EngineValues,
        preset: data.preset ?? 'default',
        raw: data.raw ?? '',
        launch: (data.launch ?? null) as LaunchInfo | null,
      }
      setDisk(next)
      // Re-baseline the form to disk on every (re)load.
      setTouched(false)
      setResetIntent(Object.keys(next.values).length === 0)
      setFormValues(mergeWithBuiltins(next.values))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Engine.ini')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    load()
  }, [load])

  // What the managed keys would be ON DISK after saving the current staged
  // state: untouched -> exactly disk; Game defaults -> none; write -> all nine.
  const effective = useMemo<EngineValues>(() => {
    if (!disk) return {}
    if (!touched) return disk.values
    return resetIntent ? {} : formValues
  }, [disk, touched, resetIntent, formValues])

  // Live changed-key set vs disk (spec §4.2 / acceptance #6).
  const changedKeys = useMemo(() => {
    if (!disk) return []
    const changed: string[] = []
    for (const field of ENGINE_FIELDS) {
      const after = effective[field.key]
      const before = disk.values[field.key]
      const inAfter = after !== undefined
      const inBefore = before !== undefined
      if (!inAfter && !inBefore) continue
      if (inAfter !== inBefore) {
        changed.push(field.key)
      } else if (formatEngineValue(field, after as EngineValue) !== formatEngineValue(field, before as EngineValue)) {
        changed.push(field.key)
      }
    }
    return changed
  }, [disk, effective])

  const changeCount = changedKeys.length
  const diskPreset = disk?.preset ?? 'default'
  const stagedPreset = useMemo(() => detectPreset(effective), [effective])

  const applyPreset = (preset: PresetMeta) => {
    setTouched(true)
    if (preset.id === 'default') {
      setResetIntent(true)
      setFormValues({ ...BUILTIN_DISPLAY_VALUES })
    } else {
      setResetIntent(false)
      setFormValues({ ...PRESET_VALUES[preset.id] })
    }
    setSavedNotice(false)
  }

  const editField = (key: string, value: EngineValue) => {
    // Any field edit is an explicit write, exiting Game-defaults mode.
    setTouched(true)
    setResetIntent(false)
    setFormValues((previous) => ({ ...previous, [key]: value }))
    setSavedNotice(false)
  }

  const resetStaged = () => {
    if (!disk) return
    setTouched(false)
    setResetIntent(Object.keys(disk.values).length === 0)
    setFormValues(mergeWithBuiltins(disk.values))
    setSavedNotice(false)
  }

  const save = useCallback(async () => {
    if (!config || !disk || changeCount === 0) return
    setSaving(true)
    try {
      const body = resetIntent
        ? { mode: 'reset' as const }
        : { mode: 'write' as const, values: formValues }
      const response = await fetch('/api/engine-tuning', {
        method: 'PUT',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      toast.success(data.note ?? 'Saved — takes effect on next server restart')
      setSavedNotice(true)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save Engine.ini')
    } finally {
      setSaving(false)
    }
  }, [config, disk, changeCount, resetIntent, formValues, load])

  // Raw editor (spec §6).
  const openRaw = () => {
    setRawText(disk?.raw ?? '')
    setRawOpen(true)
  }
  const saveRaw = useCallback(async () => {
    if (!config) return
    setSaving(true)
    try {
      const response = await fetch('/api/engine-tuning', {
        method: 'PUT',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'raw', content: rawText }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      toast.success('Saved — takes effect on next server restart')
      setSavedNotice(true)
      setRawOpen(false)
      setRawConfirm(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save Engine.ini')
    } finally {
      setSaving(false)
    }
  }, [config, rawText, load])

  // Restart (spec §7) — never automatic; a manual button after a save.
  const [restartConfirm, setRestartConfirm] = useState(false)
  const triggerRestart = useCallback(async () => {
    if (!config) return
    setRestartConfirm(false)
    try {
      const headers = new Headers(buildPalworldProxyHeaders(config))
      headers.set('Content-Type', 'application/json')
      const response = await fetch('/api/server-restart', {
        method: 'POST',
        headers,
        cache: 'no-store',
        body: JSON.stringify({ waittime: 60, message: 'Restarting to apply engine tuning' }),
      })
      if (!response.ok) throw new Error('restart request failed')
      toast.success('Restart scheduled — players are being warned')
      setSavedNotice(false)
    } catch {
      toast.error('Could not schedule a restart')
    }
  }, [config])

  const groupedFields = useMemo(() => {
    const groups: { group: string; fields: EngineField[] }[] = []
    for (const field of ENGINE_FIELDS) {
      let bucket = groups.find((g) => g.group === field.group)
      if (!bucket) {
        bucket = { group: field.group, fields: [] }
        groups.push(bucket)
      }
      bucket.fields.push(field)
    }
    return groups
  }, [])

  return (
    <div className="relative flex h-full min-h-[30rem] flex-col p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GaugeIcon className="size-5" />
          <h2 className="text-lg font-semibold">Engine Tuning</h2>
          {disk && (
            <Badge variant="outline" className="text-[10px]">
              on disk: {diskPreset}
            </Badge>
          )}
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
        Writes to <code className="text-xs">Engine.ini</code>. No silver bullet — a higher tick rate
        costs CPU, and settings only take effect on the next server restart. Watch server FPS after
        changing anything.
      </p>

      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {savedNotice && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          <span>Saved — takes effect on the next server restart.</span>
          <Button size="sm" variant="outline" onClick={() => setRestartConfirm(true)}>
            Restart now
          </Button>
        </div>
      )}

      <ScrollArea className="mt-3 min-h-0 flex-1">
        <div className="flex flex-col gap-4 pb-24 pr-2">
          {/* Presets */}
          <div className="grid gap-2 sm:grid-cols-3">
            {ENGINE_PRESETS.map((preset) => {
              const activeOnDisk = diskPreset === preset.id
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={!disk || saving}
                  onClick={() => setConfirmPreset(preset)}
                  className={[
                    'flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors disabled:opacity-50',
                    activeOnDisk ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-muted/60',
                  ].join(' ')}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {preset.name}
                    {preset.recommended && (
                      <Badge variant="secondary" className="text-[9px]">
                        recommended
                      </Badge>
                    )}
                    {activeOnDisk && (
                      <Badge className="bg-primary/20 text-[9px] text-primary">active</Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">{preset.blurb}</span>
                </button>
              )
            })}
          </div>

          {stagedPreset === 'custom' && touched && (
            <p className="text-xs text-muted-foreground">
              Staged values don’t match a preset — this is a <span className="font-medium">Custom</span> tune.
            </p>
          )}

          {/* Fields, grouped */}
          {groupedFields.map(({ group, fields }) => (
            <div key={group} className="flex flex-col gap-3 rounded-md border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {GROUP_LABELS[group] ?? group}
              </h3>
              {fields.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  value={formValues[field.key]}
                  changed={changedKeys.includes(field.key)}
                  removing={resetIntent && disk?.values[field.key] !== undefined}
                  onChange={(value) => editField(field.key, value)}
                  disabled={!disk || saving}
                />
              ))}
            </div>
          ))}

          {/* Launch flags — display only, sourced from the game .env */}
          <div className="flex flex-col gap-2 rounded-md border border-dashed p-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Launch flags (display only)
              </h3>
              {disk?.launch && !disk.launch.envReadable && (
                <Badge variant="outline" className="text-[9px] text-muted-foreground">
                  showing defaults — .env not readable
                </Badge>
              )}
            </div>
            {disk?.launch ? (
              <>
                <div className="flex flex-col gap-1.5">
                  {disk.launch.flags.map((flag) => (
                    <div key={flag.flag} className="flex items-start justify-between gap-3">
                      <div className="flex flex-col">
                        <code className="font-mono text-[11px]">{flag.flag}</code>
                        <span className="text-[10px] text-muted-foreground">{flag.description}</span>
                      </div>
                      <Badge
                        variant="outline"
                        className={[
                          'shrink-0 text-[10px]',
                          flag.enabled
                            ? 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                            : 'text-muted-foreground',
                        ].join(' ')}
                      >
                        {flag.enabled ? 'on' : 'off'}
                      </Badge>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Set by <code className="text-[10px]">MULTITHREADING</code> (
                  {disk.launch.multithreading ? 'on' : 'off'}) and{' '}
                  <code className="text-[10px]">COMMUNITY</code> ({disk.launch.communityMode ? 'on' : 'off'}) in
                  the game server’s environment. Changes apply on a container recreate.
                </p>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">Launch flag state unavailable.</p>
            )}
            <p className="text-[11px] text-muted-foreground">{LAUNCH_FLAGS_NOTE}</p>
          </div>
        </div>
      </ScrollArea>

      {/* Sticky unsaved-changes bar (spec §4.2) */}
      {changeCount > 0 && (
        <div className="absolute inset-x-4 bottom-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 shadow-lg backdrop-blur">
          <span className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            <TriangleAlertIcon className="size-4" />
            Careful — {changeCount} unsaved change{changeCount === 1 ? '' : 's'}! (take effect after
            restart)
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={resetStaged} disabled={saving} className="gap-1.5">
              <RotateCcwIcon className="size-3.5" /> Reset
            </Button>
            <Button size="sm" onClick={save} disabled={saving} className="gap-1.5">
              {saving ? <Spinner className="size-4" /> : <SaveIcon className="size-4" />}
              Save changes
            </Button>
          </div>
        </div>
      )}

      {/* Preset confirm dialog (spec §4.1) */}
      <AlertDialog open={confirmPreset !== null} onOpenChange={(open) => !open && setConfirmPreset(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply “{confirmPreset?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmPreset?.blurb}
              <br />
              <br />
              This overwrites the fields below — nothing is written to disk until you save.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmPreset) applyPreset(confirmPreset)
                setConfirmPreset(null)
              }}
            >
              Stage values
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Restart confirm */}
      <AlertDialog open={restartConfirm} onOpenChange={setRestartConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the server now?</AlertDialogTitle>
            <AlertDialogDescription>
              Players get a 60-second warning, then the server restarts to load the new Engine.ini.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={triggerRestart}>Restart</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Raw file editor (spec §6) */}
      <Sheet open={rawOpen} onOpenChange={setRawOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Edit Engine.ini</SheetTitle>
          </SheetHeader>
          <p className="text-xs text-muted-foreground">
            Writes the file verbatim — the escape hatch for keys this panel doesn’t manage. Takes
            effect on next restart.
          </p>
          <textarea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            spellCheck={false}
            className="min-h-0 flex-1 rounded-md border bg-muted/20 p-3 font-mono text-xs"
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRawOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => setRawConfirm(true)} disabled={saving}>
              Save raw file
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={rawConfirm} onOpenChange={setRawConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Overwrite Engine.ini?</AlertDialogTitle>
            <AlertDialogDescription>
              This writes your text to Engine.ini exactly as shown, replacing the whole file. Takes
              effect on the next server restart.
            </AlertDialogDescription>
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

function FieldRow({
  field,
  value,
  changed,
  removing,
  onChange,
  disabled,
}: {
  field: EngineField
  value: EngineValue
  changed: boolean
  removing: boolean
  onChange: (value: EngineValue) => void
  disabled: boolean
}) {
  const numeric = field.kind !== 'bool'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-2 text-sm">
          {field.label}
          {changed && <span className="size-1.5 rounded-full bg-amber-500" aria-label="changed" />}
          {removing && <span className="text-[10px] text-muted-foreground">→ built-in default</span>}
        </Label>
        {field.kind === 'bool' ? (
          <Switch checked={Boolean(value)} onCheckedChange={(checked) => onChange(checked)} disabled={disabled} />
        ) : (
          <div className="flex items-center gap-2">
            {field.min !== undefined && field.max !== undefined && (
              <input
                type="range"
                value={Number(value)}
                min={field.min}
                max={field.max}
                step={field.step ?? 1}
                onChange={(event) =>
                  onChange(field.kind === 'int' ? parseInt(event.target.value, 10) : parseFloat(event.target.value))
                }
                disabled={disabled}
                className="w-28 accent-primary"
              />
            )}
            <Input
              type="number"
              value={String(value ?? '')}
              min={field.min}
              max={field.max}
              step={field.step ?? 1}
              onChange={(event) => {
                const raw = event.target.value
                if (raw === '') return
                onChange(field.kind === 'int' ? parseInt(raw, 10) : parseFloat(raw))
              }}
              disabled={disabled}
              className="w-24 font-mono text-sm"
            />
          </div>
        )}
      </div>
      {field.description && <p className="text-[11px] text-muted-foreground">{field.description}</p>}
      {numeric && field.warning && changed && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">{field.warning}</p>
      )}
    </div>
  )
}
