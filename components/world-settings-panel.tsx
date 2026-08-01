'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { parseOptionSettings, inferKind, unquote } from '@/lib/palworld-settings'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import {
  SlidersHorizontalIcon,
  RefreshCwIcon,
  SaveIcon,
  ClipboardPasteIcon,
  UploadIcon,
  CopyIcon,
  DownloadIcon,
  RotateCcwIcon,
  ChevronRightIcon,
} from 'lucide-react'

type FieldKind = 'string' | 'boolean' | 'integer' | 'float' | 'enum' | 'platform-list'

interface SettingField {
  key: string
  label: string
  category: string
  kind: FieldKind
  description?: string
  options?: string[]
  min?: number
  max?: number
  step?: number
  defaultValue: string
  value: string | number | boolean | null
}

function decodeRaw(raw: string): string | number | boolean {
  const kind = inferKind(raw)
  switch (kind) {
    case 'string':
      return unquote(raw)
    case 'boolean':
      return raw === 'True'
    case 'float':
    case 'integer':
      return Number(raw)
    default:
      return raw
  }
}

// PATCH (not upstream): edits PalWorldSettings.ini directly via /api/palworld-settings
// (filesystem-backed, like mods) rather than the REST API, which can only read
// settings, never write them. Every change here needs a server restart to apply.
// Organization (3 broad categories) and import/export flow mirror the design
// of well-known standalone Palworld settings-generator tools.
export function WorldSettingsPanel() {
  const { config } = useServer()
  const [fields, setFields] = useState<SettingField[] | null>(null)
  const [edits, setEdits] = useState<Record<string, string | number | boolean>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/palworld-settings', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      // advanced-bucket entries (forward-compat for any future setting our
      // schema doesn't know about yet) get folded in with humanized labels.
      const advancedFields: SettingField[] = Object.entries(data.advanced ?? {}).map(([key, value]) => ({
        key,
        label: key,
        category: 'Advanced',
        kind: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'float' : 'string',
        defaultValue: String(value),
        value: value as string | number | boolean,
      }))
      setFields([...data.fields, ...advancedFields])
      setEdits({})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    load()
  }, [load])

  const categories = useMemo(() => {
    if (!fields) return []
    const order: string[] = []
    for (const f of fields) if (!order.includes(f.category)) order.push(f.category)
    return order
  }, [fields])

  // PATCH (not upstream): Difficulty's dropdown (None/Casual/Normal/Hard) only
  // ever wrote the raw Difficulty= field, which has little real effect on its
  // own -- the actual difficulty experience comes from these 8 independent
  // rate/penalty fields. Picking a preset now bulk-applies the values that
  // define it; picking "None" leaves the other fields alone (no preset to apply).
  const DIFFICULTY_PRESETS: Record<string, Record<string, string | number>> = {
    Casual: {
      ExpRate: 1.3, PalCaptureRate: 2.0, PlayerDamageRateAttack: 1.5,
      PlayerDamageRateDefense: 0.7, CollectionDropRate: 2.0, EnemyDropItemRate: 2.0,
      PalEggDefaultHatchingTime: 0, DeathPenalty: 'None',
    },
    Normal: {
      ExpRate: 1.0, PalCaptureRate: 1.0, PlayerDamageRateAttack: 1.0,
      PlayerDamageRateDefense: 1.0, CollectionDropRate: 1.0, EnemyDropItemRate: 1.0,
      PalEggDefaultHatchingTime: 2, DeathPenalty: 'ItemAndEquipment',
    },
    Hard: {
      ExpRate: 0.8, PalCaptureRate: 0.8, PlayerDamageRateAttack: 0.5,
      PlayerDamageRateDefense: 4.0, CollectionDropRate: 0.5, EnemyDropItemRate: 0.5,
      PalEggDefaultHatchingTime: 4, DeathPenalty: 'All',
    },
  }

  const setEdit = (key: string, value: string | number | boolean) => {
    if (key === 'Difficulty' && typeof value === 'string' && DIFFICULTY_PRESETS[value]) {
      setEdits((prev) => ({ ...prev, [key]: value, ...DIFFICULTY_PRESETS[value] }))
      toast.info(`Applied ${value} preset — 8 related settings updated, review before saving`)
      return
    }
    setEdits((prev) => {
      const next = { ...prev, [key]: value }
      // Drop an edit that equals the field's LIVE value. Without this, reverting
      // a field back to its current value (e.g. the per-field reset icon when
      // default === live) leaves a phantom entry that keeps SAVE(N) and the
      // per-category count stale until a page refresh (verified bug).
      const live = fields?.find((f) => f.key === key)?.value
      if (live !== undefined && String(value) === String(live)) delete next[key]
      return next
    })
  }

  const resetField = (field: SettingField) => {
    setEdit(field.key, decodeRaw(field.defaultValue))
  }

  const dirtyCount = Object.keys(edits).length

  // Shared by the reset button and the box highlight / per-category count --
  // "changed" means the field's current effective value (pending edit, or
  // else its live value from the server) differs from the real default.
  const isFieldChanged = useCallback(
    (field: SettingField) => {
      const current = edits[field.key] ?? field.value
      return String(current) !== String(decodeRaw(field.defaultValue))
    },
    [edits]
  )

  const save = useCallback(async () => {
    if (!config || dirtyCount === 0) return
    setSaving(true)
    try {
      const response = await fetch('/api/palworld-settings', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: edits }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      toast.success(`Saved ${data.updated.length} setting${data.updated.length === 1 ? '' : 's'} — restart to apply`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }, [config, dirtyCount, edits, load])

  // --- Paste / Upload: parse a full ini's OptionSettings client-side (same
  // tested parser used server-side) and stage every recognized value as a
  // pending edit for review -- nothing is saved until "Save" is clicked. ---
  const applyImport = useCallback(
    (text: string) => {
      if (!fields) return
      let parsed: Map<string, string>
      try {
        parsed = parseOptionSettings(text)
      } catch {
        toast.error("Couldn't find OptionSettings=(...) in that content")
        return
      }
      const knownKeys = new Set(fields.map((f) => f.key))
      const next: Record<string, string | number | boolean> = {}
      let matched = 0
      let unknown = 0
      for (const [key, raw] of parsed.entries()) {
        if (!knownKeys.has(key)) {
          unknown++
          continue
        }
        next[key] = decodeRaw(raw)
        matched++
      }
      setEdits((prev) => ({ ...prev, ...next }))
      toast.success(`Staged ${matched} setting${matched === 1 ? '' : 's'} for review${unknown ? ` (${unknown} unrecognized key${unknown === 1 ? '' : 's'} skipped)` : ''}`)
      setImportOpen(false)
      setImportText('')
    },
    [fields]
  )

  const onFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => applyImport(String(reader.result ?? ''))
    reader.readAsText(file)
    e.target.value = ''
  }

  // --- Copy / Download: build the live OptionSettings tuple from current
  // (baseline + pending edits) values, formatted the same way the real ini
  // stores them. ---
  const buildIniText = useCallback((): string => {
    if (!fields) return ''
    const parts = fields
      .filter((f) => f.category !== 'Advanced' || f.value !== null) // skip nothing, just documents intent
      .map((f) => {
        const current = edits[f.key] ?? f.value ?? decodeRaw(f.defaultValue)
        const kind = f.kind
        let raw: string
        if (kind === 'string') raw = `"${String(current)}"`
        else if (kind === 'boolean') raw = current ? 'True' : 'False'
        else raw = String(current)
        return `${f.key}=${raw}`
      })
    return `[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(${parts.join(',')})\n`
  }, [fields, edits])

  const copyAll = () => {
    void copyToClipboard(buildIniText(), { label: 'PalWorldSettings.ini contents' })
  }

  const downloadIni = () => {
    const blob = new Blob([buildIniText()], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'PalWorldSettings.ini'
    a.click()
    URL.revokeObjectURL(url)
  }

  const renderControl = (field: SettingField) => {
    const current = edits[field.key] ?? field.value
    const isPassword = field.key === 'AdminPassword' || field.key === 'ServerPassword'
    const isDefault = !isFieldChanged(field)

    let control: React.ReactNode
    if (field.kind === 'boolean') {
      control = <Switch checked={Boolean(current)} onCheckedChange={(checked) => setEdit(field.key, checked)} />
    } else if (field.kind === 'enum' && field.options) {
      control = (
        <select
          value={String(current ?? '')}
          onChange={(e) => setEdit(field.key, e.target.value)}
          className="rounded-md border border-border/60 bg-muted/20 px-2 py-1 text-sm"
        >
          {field.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      )
    } else if ((field.kind === 'integer' || field.kind === 'float') && field.min !== undefined && field.max !== undefined) {
      // Ranged numeric fields get a slider (native <input type="range"> --
      // no new dependency needed) plus a compact number readout for precise entry.
      const step = field.step ?? (field.kind === 'integer' ? 1 : 0.1)
      control = (
        <div className="flex items-center gap-2">
          <input
            type="range"
            value={Number(current ?? field.min)}
            min={field.min}
            max={field.max}
            step={step}
            onChange={(e) => setEdit(field.key, field.kind === 'integer' ? parseInt(e.target.value, 10) : parseFloat(e.target.value))}
            className="w-28 accent-primary"
          />
          <Input
            type="number"
            value={String(current ?? '')}
            min={field.min}
            max={field.max}
            step={step}
            onChange={(e) => setEdit(field.key, field.kind === 'integer' ? parseInt(e.target.value, 10) : parseFloat(e.target.value))}
            className="w-20"
          />
        </div>
      )
    } else if (field.kind === 'integer' || field.kind === 'float') {
      // No known range (mostly auto-labeled Advanced fields) -- plain number input.
      control = (
        <Input
          type="number"
          value={String(current ?? '')}
          step={field.step ?? (field.kind === 'integer' ? 1 : 0.1)}
          onChange={(e) => setEdit(field.key, field.kind === 'integer' ? parseInt(e.target.value, 10) : parseFloat(e.target.value))}
          className="w-28"
        />
      )
    } else if (field.kind === 'platform-list') {
      // PATCH (not upstream): CrossplayPlatforms has no schema entry upstream,
      // so it falls back to a plain text input showing the raw
      // "(Steam,Xbox,PS5,Mac)" string. Real checkboxes are much harder to
      // fat-finger into an invalid value.
      const ALL_PLATFORMS = ['Steam', 'Xbox', 'PS5', 'Mac']
      const raw = String(current ?? '').replace(/^\(|\)$/g, '')
      const selected = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
      control = (
        <div className="flex flex-wrap gap-3">
          {ALL_PLATFORMS.map((p) => (
            <label key={p} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={selected.has(p)}
                onChange={(e) => {
                  const next = new Set(selected)
                  if (e.target.checked) next.add(p)
                  else next.delete(p)
                  setEdit(field.key, `(${ALL_PLATFORMS.filter((x) => next.has(x)).join(',')})`)
                }}
              />
              {p}
            </label>
          ))}
        </div>
      )
    } else {
      control = (
        <Input
          type={isPassword ? 'password' : 'text'}
          value={String(current ?? '')}
          onChange={(e) => setEdit(field.key, e.target.value)}
          className="w-56"
        />
      )
    }

    return (
      <div className="flex items-center gap-2">
        {control}
        <button
          type="button"
          onClick={() => resetField(field)}
          disabled={isDefault}
          title={`Reset to default (${field.defaultValue.replace(/^"|"$/g, '')})`}
          className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30 shrink-0"
        >
          <RotateCcwIcon className="size-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontalIcon className="size-5" />
          <h2 className="text-lg font-semibold">World Settings</h2>
          {fields && <span className="text-xs text-muted-foreground">({fields.length} settings)</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setImportOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:bg-muted"
          >
            <ClipboardPasteIcon className="size-3.5" /> Paste / Upload
          </button>
          <button onClick={copyAll} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:bg-muted">
            <CopyIcon className="size-3.5" /> Copy
          </button>
          <button onClick={downloadIni} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:bg-muted">
            <DownloadIcon className="size-3.5" /> Download .ini
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:bg-muted disabled:opacity-50"
          >
            <RefreshCwIcon className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} /> Refresh
          </button>
          <Button onClick={save} disabled={dirtyCount === 0 || saving} size="sm">
            {saving ? <Spinner className="mr-2 size-4" /> : <SaveIcon className="mr-2 size-4" />}
            {saving ? 'Saving…' : `Save${dirtyCount > 0 ? ` (${dirtyCount})` : ''}`}
          </Button>
        </div>
      </div>

      {importOpen && (
        <div className="flex flex-col gap-2 rounded-md border p-3">
          <p className="text-sm text-muted-foreground">
            Paste a full <code>PalWorldSettings.ini</code>, or upload the file — recognized values are staged for
            review below, nothing saves until you click Save.
          </p>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="[/Script/Pal.PalGameWorldSettings]&#10;OptionSettings=(...)"
            className="h-28 w-full rounded-md border bg-muted/20 p-2 font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => applyImport(importText)} disabled={!importText.trim()}>
              Load pasted text
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
              <UploadIcon className="mr-2 size-3.5" /> Upload .ini file
            </Button>
            <input ref={fileInputRef} type="file" accept=".ini,.txt" className="hidden" onChange={onFileSelected} />
          </div>
        </div>
      )}

      <p className="text-muted-foreground text-sm">
        Changes are written directly to <code>PalWorldSettings.ini</code> and take effect on the next server
        restart. Requires an admin-tier password to save — a mod-tier login can view but not change these.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !fields && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading world settings…
        </div>
      )}

      {fields &&
        categories.map((category) => {
          const isCollapsed = collapsed[category] ?? false
          const categoryFields = fields.filter((f) => f.category === category)
          const changedCount = categoryFields.filter(isFieldChanged).length
          return (
            <div key={category} className="rounded-md border">
              <button
                type="button"
                onClick={() => setCollapsed((prev) => ({ ...prev, [category]: !isCollapsed }))}
                className="flex w-full items-center justify-between border-b bg-muted/20 px-3 py-2 text-sm font-semibold hover:bg-muted/30"
              >
                <span className="flex items-center gap-2">
                  <ChevronRightIcon className={`size-4 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
                  {category}
                </span>
                <span className="flex items-center gap-2">
                  {changedCount > 0 && (
                    <span className="text-xs font-medium text-primary">{changedCount} changed</span>
                  )}
                  <span className="text-xs font-normal text-muted-foreground">{categoryFields.length}</span>
                </span>
              </button>
              {!isCollapsed && (
                <ul className="grid grid-cols-1 divide-y md:grid-cols-2 md:divide-y-0 [&>li:nth-child(odd)]:md:border-r">
                  {categoryFields.map((field) => (
                    <li
                      key={field.key}
                      className={`flex items-center justify-between gap-3 border-border/60 px-3 py-2 [&:not(:last-child)]:border-b ${
                        isFieldChanged(field) ? 'bg-primary/5 ring-1 ring-inset ring-primary/40' : ''
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-sm">{field.label}</div>
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          <code className="opacity-70">{field.key}</code>
                          <span>· default: {field.defaultValue.replace(/^"|"$/g, '') || '(empty)'}</span>
                        </div>
                        {field.description && <div className="text-xs text-muted-foreground">{field.description}</div>}
                      </div>
                      {renderControl(field)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
    </div>
  )
}
