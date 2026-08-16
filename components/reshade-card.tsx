'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { SparklesIcon, UploadIcon, Trash2Icon, PlusIcon } from 'lucide-react'

// PATCH (not upstream): ReShade in the client loadout. Toggle + operator-supplied base bundle
// (BSD-3 injector + shaders) + presets (upload / Nexus URL). When enabled, the loadout drops it
// into Pal/Binaries/Win64/. See docs/specs/reshade-loadout.md.
type Preset = { file: string; name: string; source: string; addedAt: number }
type Status = {
  enabled: boolean
  base: { name: string; sizeBytes: number; fileCount: number; addedAt: number } | null
  basePresent: boolean
  presets: Preset[]
}

export function ReshadeCard() {
  const { config } = useServer()
  const [st, setSt] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [presetUrl, setPresetUrl] = useState('')
  const baseRef = useRef<HTMLInputElement | null>(null)
  const presetRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    if (!config) return
    try {
      const r = await fetch('/api/reshade', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      if (r.ok) setSt(await r.json())
    } catch {
      /* ignore */
    }
  }, [config])

  useEffect(() => {
    void load()
  }, [load])

  const postJson = useCallback(
    async (body: Record<string, unknown>) => {
      if (!config) return
      setBusy(true)
      try {
        const r = await fetch('/api/reshade', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error ?? 'Failed')
        setSt(j)
        return j
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed')
      } finally {
        setBusy(false)
      }
    },
    [config],
  )

  const upload = useCallback(
    async (field: 'base' | 'preset', file: File) => {
      if (!config) return
      setBusy(true)
      const tid = toast.loading(field === 'base' ? 'Uploading ReShade base…' : 'Adding preset…')
      try {
        const form = new FormData()
        form.append(field, file)
        const r = await fetch('/api/reshade', { method: 'POST', headers: buildPalworldProxyHeaders(config), body: form })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error ?? 'Upload failed')
        setSt(j)
        toast.success(field === 'base' ? `ReShade base set (${j.base?.fileCount ?? '?'} files)` : 'Preset added', { id: tid })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Upload failed', { id: tid })
      } finally {
        setBusy(false)
      }
    },
    [config],
  )

  const enabled = st?.enabled ?? false
  const hasBase = st?.basePresent ?? false

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-primary" />
          <span className="text-sm font-semibold">ReShade (visual preset)</span>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy || (!hasBase && !enabled)}
            onChange={(e) => postJson({ action: 'setEnabled', enabled: e.target.checked })}
            className="size-4 accent-primary"
          />
          Include in loadout
        </label>
      </div>

      <p className="text-xs text-muted-foreground">
        Client-side graphics post-processing (color/sharpness). When on, the loadout drops ReShade into every friend&apos;s{' '}
        <span className="font-mono">Pal\Binaries\Win64</span>. Coexists with UE4SS. Upload the ReShade{' '}
        <span className="font-medium text-foreground">base</span> once (the injector <span className="font-mono">dxgi.dll</span> +{' '}
        <span className="font-mono">reshade-shaders\</span> from your own install), then add preset(s).
      </p>

      {/* Base bundle */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={baseRef}
          type="file"
          accept=".zip,.7z,.rar"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload('base', f)
            e.target.value = ''
          }}
        />
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={busy} onClick={() => baseRef.current?.click()}>
          {busy ? <Spinner className="size-3.5" /> : <UploadIcon className="size-3.5" />}
          {hasBase ? 'Replace base' : 'Upload ReShade base (.zip)'}
        </Button>
        {hasBase ? (
          <span className="inline-flex items-center gap-2 text-[11px] text-emerald-600 dark:text-emerald-400">
            base: {st?.base?.name} ({st?.base?.fileCount} files, {Math.round((st?.base?.sizeBytes ?? 0) / 1024 / 1024)} MB)
            <button
              className="text-muted-foreground hover:text-destructive"
              disabled={busy}
              onClick={() => postJson({ action: 'clearBase' })}
              title="Remove base"
            >
              <Trash2Icon className="size-3.5" />
            </button>
          </span>
        ) : (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">no base uploaded — required before enabling</span>
        )}
      </div>

      {/* Presets */}
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={presetUrl}
            onChange={(e) => setPresetUrl(e.target.value)}
            placeholder="Nexus preset URL (e.g. …/palworld/mods/197)"
            className="h-8 flex-1 min-w-[200px] text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5 text-xs"
            disabled={busy || !presetUrl.trim()}
            onClick={async () => {
              const j = await postJson({ action: 'addPresetUrl', url: presetUrl.trim() })
              if (j) setPresetUrl('')
            }}
          >
            <PlusIcon className="size-3.5" /> Add URL
          </Button>
          <input
            ref={presetRef}
            type="file"
            accept=".ini,.zip,.7z"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload('preset', f)
              e.target.value = ''
            }}
          />
          <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={busy} onClick={() => presetRef.current?.click()}>
            <UploadIcon className="size-3.5" /> Upload .ini
          </Button>
        </div>
        {st?.presets?.length ? (
          <ul className="flex flex-col gap-1">
            {st.presets.map((p) => (
              <li key={p.file} className="flex items-center justify-between gap-2 rounded border px-2 py-1 text-[11px]">
                <span className="truncate">
                  <span className="font-medium text-foreground">{p.name}</span>{' '}
                  <span className="text-muted-foreground">· {p.source}</span>
                </span>
                <button
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  onClick={() => postJson({ action: 'removePreset', file: p.file })}
                  title="Remove preset"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">No presets yet — add a Nexus URL or upload a .ini.</p>
        )}
      </div>

      {enabled && hasBase && (
        <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
          ReShade ships in the next loadout build. Friends run it after installing; press{' '}
          <span className="font-mono">Home</span> in-game to toggle the ReShade overlay.
        </p>
      )}
    </div>
  )
}
