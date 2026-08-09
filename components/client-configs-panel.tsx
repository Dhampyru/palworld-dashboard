'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { ModConfigForm } from '@/components/modconfig-form'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { SlidersHorizontal, Upload, Trash2, Save } from 'lucide-react'

// PATCH (not upstream): schema-driven editor for CLIENT mod runtime configs
// (docs/specs/client-mod-sync.md). Mods using DekModConfigMenu write self-describing JSON
// (each setting carries type/desc/opts/init/live). We render a form from that schema, edit the
// `live` values, and save — the loadout overlays the file so friends install pre-configured.

type ConfigJson = Record<string, unknown>
type ConfigFile = { name: string; json: ConfigJson }


export function ClientConfigsPanel() {
  const { config } = useServer()
  const [configs, setConfigs] = useState<ConfigFile[]>([])
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [draft, setDraft] = useState<ConfigJson | null>(null)
  const [busy, setBusy] = useState(false)
  const [detected, setDetected] = useState<string[]>([]) // client mods that ship an in-game config menu

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    try {
      const res = await fetch('/api/client-configs', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Failed to load')
      setConfigs((await res.json()).configs ?? [])
      // Which staged client mods produce a Mod Config Menu JSON (auto-detected on add)?
      const mres = await fetch('/api/client-mods', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      if (mres.ok) {
        const mods = ((await mres.json()).mods ?? []) as { name: string; keep: boolean; configMenu?: boolean }[]
        setDetected(mods.filter((m) => m.configMenu && m.keep).map((m) => m.name))
      }
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

      {detected.length > 0 && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-xs">
          <div className="font-medium">Detected mods with an in-game config menu</div>
          <div className="mb-1 text-muted-foreground">
            These write a <code>*.modconfig.json</code> to <code>LogicMods\</code> on the client — upload each to
            pre-configure it here.
          </div>
          <ul className="space-y-0.5">
            {detected.map((n) => {
              const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')
              const covered = configs.some((c) => {
                const cn = norm(c.name.replace(/\.modconfig\.json$/i, '').replace(/\.json$/i, ''))
                const mn = norm(n)
                return cn.includes(mn) || mn.includes(cn)
              })
              return (
                <li key={n} className="flex items-center gap-1.5">
                  <span className={covered ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                    {covered ? '✓' : '•'}
                  </span>
                  <span>{n}</span>
                  <span className="text-muted-foreground">{covered ? '— config uploaded' : '— no config yet'}</span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

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
            <ModConfigForm json={draft} onChange={setDraft} />
          </div>
        </div>
      )}
    </div>
  )
}
