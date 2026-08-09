'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { DatabaseIcon, ChevronRightIcon, ChevronDownIcon, FileJsonIcon, SaveIcon } from 'lucide-react'

// PATCH (not upstream): edit ANY installed PalSchema mod's data files (jsonc). Saves write the
// live server file AND an overlay the loadout ships to clients, so server + client stay in
// sync (PalSchema data is client-rendered). Admin-only; effective on the next server restart.
type Submod = { name: string; fileCount: number }
type PsFile = { rel: string; format: 'json' | 'jsonc' | 'ini' | 'lua'; overridden: boolean }

export function PalSchemaEditor() {
  const { config } = useServer()
  const [submods, setSubmods] = useState<Submod[] | null>(null)
  const [openMod, setOpenMod] = useState<string | null>(null)
  const [files, setFiles] = useState<Record<string, PsFile[]>>({})
  const [editing, setEditing] = useState<{ submod: string; file: PsFile } | null>(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)

  const headers = useCallback(
    (json = false) => ({
      ...(config ? buildPalworldProxyHeaders(config) : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    }),
    [config],
  )

  const loadSubmods = useCallback(async () => {
    if (!config) return
    try {
      const r = await fetch('/api/palschema-config', { headers: headers(), cache: 'no-store' })
      const j = await r.json()
      if (r.ok) setSubmods((j.submods as Submod[]) ?? [])
      else setSubmods([])
    } catch {
      setSubmods([])
    }
  }, [config, headers])

  useEffect(() => {
    void loadSubmods()
  }, [loadSubmods])

  const toggle = useCallback(
    async (name: string) => {
      if (openMod === name) {
        setOpenMod(null)
        return
      }
      setOpenMod(name)
      if (!files[name]) {
        try {
          const r = await fetch(`/api/palschema-config?submod=${encodeURIComponent(name)}`, { headers: headers(), cache: 'no-store' })
          const j = await r.json()
          if (r.ok) setFiles((f) => ({ ...f, [name]: (j.files as PsFile[]) ?? [] }))
        } catch {
          /* ignore */
        }
      }
    },
    [openMod, files, headers],
  )

  const openFile = useCallback(
    async (submod: string, file: PsFile) => {
      if (!config) return
      setEditing({ submod, file })
      setText('')
      setDirty(false)
      try {
        const r = await fetch(
          `/api/palschema-config?submod=${encodeURIComponent(submod)}&file=${encodeURIComponent(file.rel)}`,
          { headers: headers(), cache: 'no-store' },
        )
        const j = await r.json()
        if (r.ok) setText(j.content ?? '')
        else toast.error(j.error ?? 'Failed to load file')
      } catch {
        toast.error('Failed to load file')
      }
    },
    [config, headers],
  )

  const save = useCallback(async () => {
    if (!config || !editing) return
    setBusy(true)
    const toastId = toast.loading('Saving…')
    try {
      const r = await fetch('/api/palschema-config', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ submod: editing.submod, file: editing.file.rel, content: text }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'Save failed')
      toast.success(j.note ?? 'Saved', { id: toastId })
      setDirty(false)
      // reflect the new "overridden" state
      setFiles((f) => ({
        ...f,
        [editing.submod]: (f[editing.submod] ?? []).map((x) => (x.rel === editing.file.rel ? { ...x, overridden: true } : x)),
      }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed', { id: toastId })
    } finally {
      setBusy(false)
    }
  }, [config, editing, text, headers])

  if (submods !== null && submods.length === 0) return null // nothing to edit → hide the card

  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center gap-2">
        <DatabaseIcon className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">PalSchema data</h3>
        <span className="text-[11px] text-muted-foreground">
          edit items / recipes / tech-tree JSON — applies to the server (restart) and ships to clients in the loadout
        </span>
      </div>

      {submods === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="flex flex-col gap-1">
          {submods.map((m) => (
            <div key={m.name} className="rounded-md border border-border/50">
              <button
                onClick={() => void toggle(m.name)}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted/40"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  {openMod === m.name ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" />}
                  <span className="truncate">{m.name}</span>
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{m.fileCount} file{m.fileCount === 1 ? '' : 's'}</span>
              </button>
              {openMod === m.name && (
                <div className="border-t border-border/40 p-1.5">
                  {(files[m.name] ?? []).map((f) => (
                    <button
                      key={f.rel}
                      onClick={() => void openFile(m.name, f)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/40"
                    >
                      <FileJsonIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <code className="truncate font-mono">{f.rel}</code>
                      {f.overridden && (
                        <Badge className="ml-auto bg-emerald-500/15 text-[10px] text-emerald-600 dark:text-emerald-400">edited</Badge>
                      )}
                    </button>
                  ))}
                  {files[m.name] && files[m.name].length === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">No editable files.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Sheet open={!!editing} onOpenChange={(o) => !o && !busy && setEditing(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="truncate">
              {editing ? `${editing.submod} / ${editing.file.rel}` : ''}
            </SheetTitle>
          </SheetHeader>
          <p className="text-xs text-muted-foreground">
            Validated on save (must be valid {editing?.file.format?.toUpperCase() ?? 'JSON'}). Takes effect server-side on
            the next restart; clients get it on their next loadout download.
          </p>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setDirty(true)
            }}
            spellCheck={false}
            className="min-h-0 flex-1 rounded-md border bg-muted/20 p-3 font-mono text-xs"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void save()} disabled={busy || !dirty} className="gap-1.5">
              <SaveIcon className="size-3.5" /> {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
              Close
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </section>
  )
}
