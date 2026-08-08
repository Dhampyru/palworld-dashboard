'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { SlidersHorizontal, Upload, Trash2, Save } from 'lucide-react'

// PATCH (not upstream): schema-driven editor for CLIENT mod runtime configs
// (docs/specs/client-mod-sync.md). Mods using DekModConfigMenu write self-describing JSON
// (each setting carries type/desc/opts/init/live). We render a form from that schema, edit the
// `live` values, and save — the loadout overlays the file so friends install pre-configured.

type Opts = { min?: number; max?: number; step?: number }
type Setting = { type?: string; desc?: string; opts?: Opts; init?: unknown; live?: unknown }
type Section = { type?: string; desc?: string; data?: Record<string, Setting> }
type ConfigJson = Record<string, unknown>
type ConfigFile = { name: string; json: ConfigJson }

const isSection = (v: unknown): v is Section =>
  !!v && typeof v === 'object' && (v as Section).type === 'object' && !!(v as Section).data

function rgbToHex(c: { r?: number; g?: number; b?: number }): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0')
  return `#${h(c.r ?? 0)}${h(c.g ?? 0)}${h(c.b ?? 0)}`
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return { r: 1, g: 1, b: 1 }
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 }
}

export function ClientConfigsPanel() {
  const { config } = useServer()
  const [configs, setConfigs] = useState<ConfigFile[]>([])
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [draft, setDraft] = useState<ConfigJson | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    try {
      const res = await fetch('/api/client-configs', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to load')
      setConfigs((await res.json()).configs ?? [])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load client configs')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    void load()
  }, [load])

  const select = (c: ConfigFile) => {
    setSel(c.name)
    setDraft(structuredClone(c.json))
  }

  // Update one setting's `live` value in the draft.
  const setLive = (section: string, key: string, value: unknown) => {
    setDraft((prev) => {
      if (!prev) return prev
      const next = structuredClone(prev)
      const sec = next[section] as Section
      if (sec?.data?.[key]) sec.data[key].live = value
      return next
    })
  }

  const upload = async (file: File) => {
    if (!config) return
    setBusy(true)
    try {
      const content = await file.text()
      const res = await fetch('/api/client-configs', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upload', name: file.name, content }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? 'Upload failed')
      toast.success(`Added ${file.name}`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!config || !sel || !draft) return
    setBusy(true)
    try {
      const res = await fetch('/api/client-configs', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', name: sel, json: draft }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? 'Save failed')
      toast.success(`Saved ${sel} — ships in the next loadout/share`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (!config) return
    setBusy(true)
    try {
      const res = await fetch(`/api/client-configs?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: buildPalworldProxyHeaders(config),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Delete failed')
      toast.success(`Removed ${name}`)
      if (sel === name) {
        setSel(null)
        setDraft(null)
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  const renderSetting = (section: string, key: string, s: Setting) => {
    const live = s.live
    const label = (
      <div className="min-w-0">
        <div className="text-sm font-medium">{key}</div>
        {s.desc ? <div className="text-[11px] leading-tight text-muted-foreground">{s.desc}</div> : null}
      </div>
    )
    if (s.type === 'boolean') {
      return (
        <div key={key} className="flex items-center justify-between gap-4 py-2">
          {label}
          <Switch checked={!!live} onCheckedChange={(v) => setLive(section, key, v)} />
        </div>
      )
    }
    if (s.type === 'float' || s.type === 'int') {
      const n = typeof live === 'number' ? live : Number(live) || 0
      const min = s.opts?.min ?? 0
      const max = s.opts?.max ?? 100
      const step = s.opts?.step ?? (s.type === 'int' ? 1 : 0.1)
      return (
        <div key={key} className="flex items-center justify-between gap-4 py-2">
          {label}
          <div className="flex shrink-0 items-center gap-2">
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={n}
              onChange={(e) => setLive(section, key, Number(e.target.value))}
              className="w-32 accent-primary"
            />
            <Input
              type="number"
              min={min}
              max={max}
              step={step}
              value={n}
              onChange={(e) => setLive(section, key, Number(e.target.value))}
              className="h-8 w-24 text-right"
            />
          </div>
        </div>
      )
    }
    if (s.type === 'color' && live && typeof live === 'object') {
      const c = live as { r?: number; g?: number; b?: number; a?: number }
      return (
        <div key={key} className="flex items-center justify-between gap-4 py-2">
          {label}
          <div className="flex shrink-0 items-center gap-2">
            <input
              type="color"
              value={rgbToHex(c)}
              onChange={(e) => setLive(section, key, { ...c, ...hexToRgb(e.target.value) })}
              className="h-8 w-10 cursor-pointer rounded border bg-transparent"
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={c.a ?? 1}
              title="opacity"
              onChange={(e) => setLive(section, key, { ...c, a: Number(e.target.value) })}
              className="w-20 accent-primary"
            />
          </div>
        </div>
      )
    }
    if (s.type === 'keybind' && live && typeof live === 'object') {
      const k = live as { key?: string; bShift?: boolean; bCtrl?: boolean; bAlt?: boolean; bCmd?: boolean }
      const mod = (name: 'bShift' | 'bCtrl' | 'bAlt' | 'bCmd', txt: string) => (
        <label className="flex items-center gap-1 text-[11px]">
          <input type="checkbox" checked={!!k[name]} onChange={(e) => setLive(section, key, { ...k, [name]: e.target.checked })} />
          {txt}
        </label>
      )
      return (
        <div key={key} className="flex items-center justify-between gap-4 py-2">
          {label}
          <div className="flex shrink-0 items-center gap-2">
            {mod('bCtrl', 'Ctrl')}
            {mod('bShift', 'Shift')}
            {mod('bAlt', 'Alt')}
            <Input
              value={k.key ?? ''}
              onChange={(e) => setLive(section, key, { ...k, key: e.target.value })}
              className="h-8 w-20"
              placeholder="Key"
            />
          </div>
        </div>
      )
    }
    // fallback — number or text
    return (
      <div key={key} className="flex items-center justify-between gap-4 py-2">
        {label}
        <Input
          value={typeof live === 'object' ? JSON.stringify(live) : String(live ?? '')}
          onChange={(e) => setLive(section, key, typeof live === 'number' ? Number(e.target.value) : e.target.value)}
          className="h-8 w-40"
        />
      </div>
    )
  }

  const meta = draft?.meta as { desc?: string; vers?: string } | undefined

  return (
    <div className="border-t border-border/60 p-4">
      <div className="mb-1 flex items-center gap-2">
        <SlidersHorizontal className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">Client mod configs</h3>
      </div>
      <p className="mb-3 max-w-2xl text-xs text-muted-foreground">
        Pre-configure mods that use the in-game <b>Mod Config Menu</b> (e.g. YetAnotherMinimap). Upload a mod&apos;s{' '}
        <code>*.modconfig.json</code> from your client&apos;s <code>Pal\Content\Paks\LogicMods\</code> folder, tune it
        here, and every friend&apos;s loadout ships pre-configured. Values are the mod&apos;s own — edited settings apply
        on the client&apos;s next launch.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted">
          <Upload className="size-4" />
          Upload .modconfig.json
          <input
            type="file"
            accept=".json,application/json"
            multiple
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              void (async () => {
                for (const f of files) await upload(f)
              })()
            }}
          />
        </label>
        {loading ? <Spinner className="size-4" /> : <span className="text-xs text-muted-foreground">{configs.length} config(s)</span>}
      </div>

      {configs.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {configs.map((c) => (
            <div key={c.name} className="flex items-center">
              <button
                onClick={() => select(c)}
                className={`rounded-l-md border px-2.5 py-1 text-xs transition-colors ${
                  sel === c.name ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'
                }`}
                title={c.name}
              >
                {c.name.replace(/\.modconfig\.json$/i, '').replace(/\.json$/i, '')}
              </button>
              <button
                onClick={() => void remove(c.name)}
                disabled={busy}
                className="rounded-r-md border border-l-0 px-1.5 py-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                title={`Remove ${c.name}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {sel && draft && (
        <div className="rounded-lg border">
          <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{sel}</div>
              {meta ? (
                <div className="truncate text-[11px] text-muted-foreground">
                  {meta.desc} {meta.vers ? `· v${meta.vers}` : ''}
                </div>
              ) : null}
            </div>
            <Button size="sm" onClick={() => void save()} disabled={busy}>
              <Save className="mr-1 size-4" />
              Save
            </Button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-3">
            {Object.entries(draft).map(([section, val]) =>
              isSection(val) ? (
                <div key={section} className="mb-4">
                  <div className="mb-1 border-b pb-0.5">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section}</div>
                    {val.desc ? <div className="text-[11px] text-muted-foreground/80">{val.desc}</div> : null}
                  </div>
                  <div className="divide-y divide-border/40">
                    {Object.entries(val.data ?? {}).map(([key, s]) => renderSetting(section, key, s))}
                  </div>
                </div>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  )
}
