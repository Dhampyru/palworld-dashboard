'use client'

import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

// PATCH (not upstream): shared form renderer for DekModConfigMenu (.modconfig.json) files.
// Each setting is self-describing (type/desc/opts/init/live), so we render typed widgets and
// edit the `live` values. Handles BOTH layouts: top-level flat settings (e.g. OathrBGM) and
// grouped sections (type:"object" with a `data` map). Used by the Client mod configs panel
// and the per-mod Config button editor. Non-schema JSON should use a raw text editor instead
// (see hasModConfigSchema).
type Opts = { min?: number; max?: number; step?: number }
type Setting = { type?: string; desc?: string; opts?: Opts; init?: unknown; live?: unknown }
type Section = { type?: string; desc?: string; data?: Record<string, Setting> }
export type ConfigJson = Record<string, unknown>

const WIDGET_TYPES = new Set(['boolean', 'float', 'int', 'color', 'keybind', 'string'])
const isSetting = (v: unknown): v is Setting =>
  !!v && typeof v === 'object' && typeof (v as Setting).type === 'string' && WIDGET_TYPES.has((v as Setting).type as string)
const isSection = (v: unknown): v is Section =>
  !!v && typeof v === 'object' && (v as Section).type === 'object' && !!(v as Section).data

// A JSON blob is form-renderable when it has at least one typed setting or section.
export function hasModConfigSchema(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false
  return Object.values(json as ConfigJson).some((v) => isSetting(v) || isSection(v))
}

function rgbToHex(c: { r?: number; g?: number; b?: number }): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0')
  return `#${h(c.r ?? 0)}${h(c.g ?? 0)}${h(c.b ?? 0)}`
}
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return { r: 1, g: 1, b: 1 }
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 }
}

export function ModConfigForm({ json, onChange }: { json: ConfigJson; onChange: (next: ConfigJson) => void }) {
  // Set the value at a path (the path ends at the `.live` field of a setting).
  const setAt = (path: string[], value: unknown) => {
    const next = structuredClone(json)
    let o: Record<string, unknown> = next
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]] as Record<string, unknown>
    o[path[path.length - 1]] = value
    onChange(next)
  }

  const renderSetting = (livePath: string[], key: string, s: Setting) => {
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
          <Switch checked={!!live} onCheckedChange={(v) => setAt(livePath, v)} />
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
              onChange={(e) => setAt(livePath, Number(e.target.value))}
              className="w-32 accent-primary"
            />
            <Input
              type="number"
              min={min}
              max={max}
              step={step}
              value={n}
              onChange={(e) => setAt(livePath, Number(e.target.value))}
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
              onChange={(e) => setAt(livePath, { ...c, ...hexToRgb(e.target.value) })}
              className="h-8 w-10 cursor-pointer rounded border bg-transparent"
            />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={c.a ?? 1}
              title="opacity"
              onChange={(e) => setAt(livePath, { ...c, a: Number(e.target.value) })}
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
          <input type="checkbox" checked={!!k[name]} onChange={(e) => setAt(livePath, { ...k, [name]: e.target.checked })} />
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
            <Input value={k.key ?? ''} onChange={(e) => setAt(livePath, { ...k, key: e.target.value })} className="h-8 w-20" placeholder="Key" />
          </div>
        </div>
      )
    }
    // string / fallback
    return (
      <div key={key} className="flex items-center justify-between gap-4 py-2">
        {label}
        <Input
          value={typeof live === 'object' ? JSON.stringify(live) : String(live ?? '')}
          onChange={(e) => setAt(livePath, typeof live === 'number' ? Number(e.target.value) : e.target.value)}
          className="h-8 w-40"
        />
      </div>
    )
  }

  return (
    <div>
      {Object.entries(json).map(([key, val]) => {
        if (isSection(val)) {
          return (
            <div key={key} className="mb-4">
              <div className="mb-1 border-b pb-0.5">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{key}</div>
                {val.desc ? <div className="text-[11px] text-muted-foreground/80">{val.desc}</div> : null}
              </div>
              <div className="divide-y divide-border/40">
                {Object.entries(val.data ?? {}).map(([sk, s]) => renderSetting([key, 'data', sk, 'live'], sk, s))}
              </div>
            </div>
          )
        }
        if (isSetting(val)) return renderSetting([key, 'live'], key, val)
        return null // meta / note / non-setting keys
      })}
    </div>
  )
}
