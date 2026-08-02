'use client'

// PATCH (not upstream): Game Data card (docs/specs/gamedata-upload-extract-spec.md,
// Phase 4). Admin uploads a mappings.usmap; the control daemon runs the extractor
// against this instance's pak and writes the picker names + Pal icons the runtime
// /api/datasets + /api/game-icon serve — no rebuild. The web tier never runs
// docker: this card only uploads the usmap and drops a flag file.
//
// Extraction is heavy (parses a multi-GB pak) and overwrites the datasets, so it's
// a GUARDED one-time run: the button is disabled while a run is in flight, and
// re-running once data already exists requires an explicit confirm.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  DatabaseIcon,
  UploadIcon,
  SparklesIcon,
  CheckCircle2Icon,
  AlertTriangleIcon,
  FileUpIcon,
} from 'lucide-react'
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

type GDStatus = { phase?: string; pct?: number; message?: string; updatedAt?: string } | null
type Payload = {
  status: GDStatus
  hasUsmap: boolean
  source: 'extracted' | 'baked'
  coverage: { pals: number; items: number; eggs: number; icons: number }
}

export function GameDataCard() {
  const { config } = useServer()
  const isAdmin = config?.accessTier === 'admin'
  const [p, setP] = useState<Payload | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [confirmReextract, setConfirmReextract] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [iconUploading, setIconUploading] = useState(false)
  const iconRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/game-data/status', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok) setP(json as Payload)
    } catch {
      /* keep last known state */
    }
  }, [config])

  useEffect(() => {
    void load()
  }, [load])

  const running = p?.status?.phase === 'queued' || p?.status?.phase === 'extracting'

  // Poll while a run is in flight so progress + final coverage update live.
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [running, load])

  const upload = useCallback(async () => {
    if (!config || !file) return
    setUploading(true)
    const id = toast.loading('Uploading usmap…')
    try {
      const fd = new FormData()
      fd.append('file', file)
      // NB: no Content-Type header — the browser sets the multipart boundary.
      const res = await fetch('/api/game-data/usmap', {
        method: 'POST',
        headers: buildPalworldProxyHeaders(config),
        body: fd,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      toast.success(`Uploaded (${Math.round((json.size ?? 0) / 1024)} KB)`, { id })
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Upload failed', { id })
    } finally {
      setUploading(false)
    }
  }, [config, file, load])

  const uploadIcons = useCallback(async () => {
    if (!config || !iconFile) return
    setIconUploading(true)
    const id = toast.loading('Uploading icons…')
    try {
      const fd = new FormData()
      fd.append('file', iconFile)
      const res = await fetch('/api/game-data/icons', {
        method: 'POST',
        headers: buildPalworldProxyHeaders(config),
        body: fd,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      toast.success(`Uploaded ${json.count ?? 0} icons`, { id })
      setIconFile(null)
      if (iconRef.current) iconRef.current.value = ''
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Icon upload failed', { id })
    } finally {
      setIconUploading(false)
    }
  }, [config, iconFile, load])

  const doExtract = useCallback(async () => {
    if (!config) return
    setStarting(true)
    const id = toast.loading('Queuing extraction…')
    try {
      const res = await fetch('/api/game-data/extract', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      toast.success('Extraction queued', { id })
      await load()
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to queue', { id })
    } finally {
      setStarting(false)
    }
  }, [config, load])

  // One-time-run guard: confirm before overwriting existing extracted data.
  const onExtractClick = useCallback(() => {
    if (p?.source === 'extracted') setConfirmReextract(true)
    else void doExtract()
  }, [p, doExtract])

  const cov = p?.coverage
  const phase = p?.status?.phase

  return (
    <section className="flex flex-col gap-3 rounded-md border p-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <DatabaseIcon className="size-3.5" /> Game data (names &amp; icons)
      </h3>

      <p className="text-[11px] text-muted-foreground">
        Populate the RCON command pickers with your game&apos;s real item/Pal names. Upload a{' '}
        <code className="font-mono">mappings.usmap</code> made on a PC with UE4SS; the host extracts from your own
        pak — nothing is redistributed, and no rebuild is needed. One usmap per game version.
      </p>

      {/* Coverage */}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        Coverage:{' '}
        <span className="text-foreground">
          {cov ? `${cov.pals} pals · ${cov.items} items · ${cov.eggs} eggs · ${cov.icons} icons` : '—'}
        </span>
        {p && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
            {p.source === 'extracted' ? 'extracted' : 'baked defaults'}
          </span>
        )}
      </p>

      {/* Live run / last result */}
      {running ? (
        <p className="flex items-center gap-2 text-[11px] text-foreground">
          <Spinner className="size-3.5" />
          {p?.status?.message ?? 'Working…'}
          {typeof p?.status?.pct === 'number' && p.status.pct > 0 ? ` (${p.status.pct}%)` : ''}
        </p>
      ) : phase === 'ready' ? (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <CheckCircle2Icon className="size-3.5" /> {p?.status?.message ?? 'Extraction complete'}
        </p>
      ) : phase === 'failed' ? (
        <p className="flex items-center gap-1.5 text-[11px] text-destructive">
          <AlertTriangleIcon className="size-3.5" /> {p?.status?.message ?? 'Extraction failed'}
        </p>
      ) : null}

      {/* Upload row */}
      <div className="flex flex-col gap-2 border-t pt-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".usmap"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => fileRef.current?.click()}
            disabled={!isAdmin || uploading}
          >
            <FileUpIcon className="size-3.5" /> Choose usmap…
          </Button>
          <span className="max-w-[14rem] truncate text-[11px] text-muted-foreground">
            {file ? file.name : p?.hasUsmap ? 'A usmap is uploaded ✓' : 'No usmap uploaded yet'}
          </span>
          <Button size="sm" className="h-8 gap-1.5" onClick={upload} disabled={!isAdmin || !file || uploading}>
            {uploading ? <Spinner className="size-3.5" /> : <UploadIcon className="size-3.5" />}
            Upload
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={p?.source === 'extracted' ? 'outline' : 'default'}
            className="h-8 gap-1.5"
            onClick={onExtractClick}
            disabled={!isAdmin || !p?.hasUsmap || running || starting}
            title={
              !p?.hasUsmap
                ? 'Upload a mappings.usmap first'
                : running
                  ? 'An extraction is already running'
                  : 'Runs the extractor against this server’s pak (a few minutes)'
            }
          >
            {starting || running ? <Spinner className="size-3.5" /> : <SparklesIcon className="size-3.5" />}
            {p?.source === 'extracted' ? 'Re-extract' : 'Extract'}
          </Button>
          {!isAdmin && <span className="text-[11px] text-muted-foreground">Admin access required.</span>}
        </div>
      </div>

      {/* Pal icons (optional) — a server pak has no texture data, so icons must be
          extracted from a CLIENT pak on a PC and uploaded here as a zip. */}
      <div className="flex flex-col gap-2 border-t pt-2">
        <p className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Pal icons (optional).</span> A dedicated-server pak has no
          texture data, so icons can&apos;t be extracted here. On the PC where you made the usmap, run the extractor
          against your <em>client</em> pak, then upload the resulting <code className="font-mono">pal/*.png</code> as a
          zip — they&apos;re matched to Pals by id.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={iconRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => setIconFile(e.target.files?.[0] ?? null)}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => iconRef.current?.click()}
            disabled={!isAdmin || iconUploading}
          >
            <FileUpIcon className="size-3.5" /> Choose icons .zip…
          </Button>
          <span className="max-w-[14rem] truncate text-[11px] text-muted-foreground">
            {iconFile ? iconFile.name : cov && cov.icons > 0 ? `${cov.icons} icons uploaded ✓` : 'No icons uploaded'}
          </span>
          <Button
            size="sm"
            className="h-8 gap-1.5"
            onClick={uploadIcons}
            disabled={!isAdmin || !iconFile || iconUploading}
          >
            {iconUploading ? <Spinner className="size-3.5" /> : <UploadIcon className="size-3.5" />}
            Upload icons
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmReextract} onOpenChange={setConfirmReextract}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-extract game data?</AlertDialogTitle>
            <AlertDialogDescription>
              This server already has extracted data. Re-extracting parses the multi-GB pak again (a few minutes,
              CPU/RAM-heavy on the game host) and <strong>overwrites</strong> the current datasets + icons. Only do
              this after a game update with a fresh usmap.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReextract(false)
                void doExtract()
              }}
            >
              Re-extract
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
