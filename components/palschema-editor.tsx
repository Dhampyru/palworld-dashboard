'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { FileJsonIcon, SaveIcon } from 'lucide-react'

// PATCH (not upstream): per-submod PalSchema data editor, rendered UNDER a PalSchema mod's row
// in the server tab (docs/specs/palschema-editor.md). Lists that submod's .jsonc/.json files
// and edits them. Saves write the live server file AND an overlay the loadout ships to clients
// (parity — PalSchema data is client-rendered). Admin-only; effective on the next restart.
type PsFile = { rel: string; format: 'json' | 'jsonc' | 'ini' | 'lua'; overridden: boolean }

export function PalSchemaSubmodEditor({ submod }: { submod: string }) {
  const { config } = useServer()
  const [files, setFiles] = useState<PsFile[] | null>(null)
  const [editing, setEditing] = useState<PsFile | null>(null)
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

  useEffect(() => {
    if (!config) return
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/palschema-config?submod=${encodeURIComponent(submod)}`, { headers: headers(), cache: 'no-store' })
        const j = await r.json()
        if (!cancelled) setFiles(r.ok ? ((j.files as PsFile[]) ?? []) : [])
      } catch {
        if (!cancelled) setFiles([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [config, submod, headers])

  const openFile = useCallback(
    async (file: PsFile) => {
      if (!config) return
      setEditing(file)
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
    [config, submod, headers],
  )

  const save = useCallback(async () => {
    if (!config || !editing) return
    setBusy(true)
    const toastId = toast.loading('Saving…')
    try {
      const r = await fetch('/api/palschema-config', {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ submod, file: editing.rel, content: text }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'Save failed')
      toast.success(j.note ?? 'Saved', { id: toastId })
      setDirty(false)
      setFiles((fs) => (fs ?? []).map((x) => (x.rel === editing.rel ? { ...x, overridden: true } : x)))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed', { id: toastId })
    } finally {
      setBusy(false)
    }
  }, [config, editing, submod, text, headers])

  return (
    <div className="mt-1.5 rounded-md border border-border/40 bg-muted/20 p-1.5">
      {files === null ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">Loading files…</p>
      ) : files.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">No editable data files.</p>
      ) : (
        files.map((f) => (
          <button
            key={f.rel}
            onClick={() => void openFile(f)}
            className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/50"
          >
            <FileJsonIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <code className="truncate font-mono">{f.rel}</code>
            {f.overridden && (
              <Badge className="ml-auto bg-emerald-500/15 text-[10px] text-emerald-600 dark:text-emerald-400">edited</Badge>
            )}
          </button>
        ))
      )}

      <Sheet open={!!editing} onOpenChange={(o) => !o && !busy && setEditing(null)}>
        <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="truncate">{editing ? `${submod} / ${editing.rel}` : ''}</SheetTitle>
          </SheetHeader>
          <p className="text-xs text-muted-foreground">
            Validated on save (must be valid {editing?.format?.toUpperCase() ?? 'JSON'}). Takes effect server-side on the
            next restart; clients get it on their next loadout download.
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
    </div>
  )
}
