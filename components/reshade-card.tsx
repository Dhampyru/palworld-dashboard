'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { SparklesIcon, UploadIcon, Trash2Icon, PlusIcon, CheckIcon, AlertTriangleIcon } from 'lucide-react'

// PATCH (not upstream): ReShade in the client loadout. Toggle + operator-supplied base bundle
// (BSD-3 injector + shaders) + presets (upload / Nexus URL). When enabled, the loadout drops it
// into Pal/Binaries/Win64/. See docs/specs/reshade-loadout.md.
type ShaderResolution = { required: string[]; resolved: { file: string; source: string }[]; missing: string[]; sources: string[] }
type Preset = { file: string; name: string; source: string; addedAt: number; shaders?: ShaderResolution }
type Status = {
  enabled: boolean
  base: { name: string; sizeBytes: number; fileCount: number; addedAt: number } | null
  basePresent: boolean
  presets: Preset[]
  shaderRepos?: { name: string; license: string }[]
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
    async (field: 'base' | 'preset' | 'shader', file: File) => {
      if (!config) return
      setBusy(true)
      const label = field === 'base' ? 'Uploading ReShade base…' : field === 'preset' ? 'Adding preset (resolving shaders)…' : 'Adding shaders…'
      const tid = toast.loading(label)
      try {
        const form = new FormData()
        form.append(field, file)
        const r = await fetch('/api/reshade', { method: 'POST', headers: buildPalworldProxyHeaders(config), body: form })
        const j = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(j.error ?? 'Upload failed')
        setSt(j)
        const done =
          field === 'base'
            ? `ReShade base set (${j.base?.fileCount ?? '?'} files)`
            : field === 'preset'
              ? 'Preset added & shaders resolved'
              : 'Shaders added'
        toast.success(done, { id: tid })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Upload failed', { id: tid })
      } finally {
        setBusy(false)
      }
    },
    [config],
  )

  const shaderRef = useRef<HTMLInputElement | null>(null)
  const anyMissing = (st?.presets ?? []).some((p) => (p.shaders?.missing?.length ?? 0) > 0)

  // Drag & drop: route each dropped file to the right target by extension. A .dll is the base;
  // .ini is a preset; .fx/.fxh are gap shaders; an archive is a preset (or the base if none yet).
  const [dragOver, setDragOver] = useState(false)
  const routeAndUpload = useCallback(
    async (files: FileList | File[]) => {
      const baseNow = st?.basePresent ?? false
      for (const f of Array.from(files)) {
        const n = f.name.toLowerCase()
        let field: 'base' | 'preset' | 'shader' | null = null
        if (n.endsWith('.dll')) field = 'base'
        else if (n.endsWith('.ini')) field = 'preset'
        else if (n.endsWith('.fx') || n.endsWith('.fxh')) field = 'shader'
        else if (/\.(zip|7z|rar)$/.test(n)) field = baseNow ? 'preset' : 'base'
        if (!field) {
          toast.error(`${f.name}: unsupported — drop a .dll, .ini, .fx/.fxh, or a .zip`)
          continue
        }
        await upload(field, f)
      }
    },
    [upload, st],
  )

  const enabled = st?.enabled ?? false
  const hasBase = st?.basePresent ?? false

  return (
    <div
      className={`flex flex-col gap-2 rounded-md border p-3 transition-colors ${dragOver ? 'border-primary ring-2 ring-primary/40 bg-primary/5' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files?.length) void routeAndUpload(e.dataTransfer.files)
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-primary" />
          <span className="text-sm font-semibold">ReShade (visual preset)</span>
          {dragOver && <span className="text-[11px] text-primary">drop to add — .dll → base · .ini → preset · .fx → shader</span>}
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
        <span className="font-mono">Pal\Binaries\Win64</span>. Coexists with UE4SS. Drop your{' '}
        <span className="font-mono">dxgi.dll</span> once (from a reshade.me install — shaders are fetched automatically),
        then add preset(s). <span className="text-foreground/70">Tip: drag &amp; drop files anywhere on this card.</span>
      </p>

      {/* Base bundle */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={baseRef}
          type="file"
          accept=".dll,.zip,.7z,.rar"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload('base', f)
            e.target.value = ''
          }}
        />
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={busy} onClick={() => baseRef.current?.click()}>
          {busy ? <Spinner className="size-3.5" /> : <UploadIcon className="size-3.5" />}
          {hasBase ? 'Replace base' : 'Upload dxgi.dll (or .zip)'}
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
            {st.presets.map((p) => {
              const sh = p.shaders
              const miss = sh?.missing ?? []
              const res = sh?.resolved?.length ?? 0
              return (
                <li key={p.file} className="flex flex-col gap-1 rounded border px-2 py-1.5 text-[11px]">
                  <div className="flex items-center justify-between gap-2">
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
                  </div>
                  {sh && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {miss.length === 0 ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                          <CheckIcon className="size-3" /> {res}/{sh.required.length} shaders ready
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400" title={`Missing: ${miss.join(', ')}`}>
                          <AlertTriangleIcon className="size-3" /> {res}/{sh.required.length} ready · needs {miss.length}: {miss.slice(0, 4).join(', ')}
                          {miss.length > 4 ? '…' : ''}
                        </span>
                      )}
                      {sh.sources.length > 0 && <span className="text-muted-foreground">— from {sh.sources.join(', ')}</span>}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">No presets yet — add a Nexus URL or upload a .ini.</p>
        )}

        {/* Gap-shader upload — appears when a preset references shaders we couldn't resolve. */}
        {anyMissing && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-2">
            <span className="text-[11px] text-amber-700 dark:text-amber-300">
              Some shaders aren&apos;t in the known repos (third-party pack). Upload the missing <span className="font-mono">.fx</span>/
              <span className="font-mono">.fxh</span> (or a .zip of them):
            </span>
            <input
              ref={shaderRef}
              type="file"
              accept=".fx,.fxh,.zip,.7z"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void upload('shader', f)
                e.target.value = ''
              }}
            />
            <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={busy} onClick={() => shaderRef.current?.click()}>
              <UploadIcon className="size-3.5" /> Add shaders
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => postJson({ action: 'reresolve' })}>
              Re-resolve
            </Button>
          </div>
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
