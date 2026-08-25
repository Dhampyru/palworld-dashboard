'use client'

import { useEffect, useState } from 'react'

// PATCH (not upstream): the share page's install controls (docs/specs/client-mod-sync.md
// §5.2/§8a). Two paths sharing one passphrase input:
//  1. Download the .zip (universal) — pre-checks then navigates so a wrong pass / dead link
//     shows a message instead of raw JSON, and only the real download counts a use.
//  2. FSA "sync into my Palworld folder" (Chrome/Edge only) — picks the folder once, then
//     streams each file straight to disk (memory-safe), no manual extract. Counts one use.

type DirHandle = FileSystemDirectoryHandle
type PickerWindow = { showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<DirHandle> }

async function ensureFileHandle(root: DirHandle, relpath: string): Promise<FileSystemFileHandle> {
  const parts = relpath.split('/').filter(Boolean)
  let dir = root
  for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true })
  return dir.getFileHandle(parts[parts.length - 1], { create: true })
}

export function ShareDownload({
  token,
  requiresPass,
  sizeLabel,
}: {
  token: string
  requiresPass: boolean
  sizeLabel: string
}) {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasFSA, setHasFSA] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [synced, setSynced] = useState(false)

  useEffect(() => {
    setHasFSA(typeof window !== 'undefined' && 'showDirectoryPicker' in window)
  }, [])

  const passQ = requiresPass ? `&pass=${encodeURIComponent(pass)}` : ''
  const needPass = () => {
    if (requiresPass && !pass.trim()) {
      setError('Enter the passphrase your host gave you.')
      return true
    }
    return false
  }

  const download = async () => {
    setError(null)
    if (needPass()) return
    setBusy(true)
    try {
      const res = await fetch(`/api/share/${token}/download?check=1${passQ}`)
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? 'This link is not available.')
        return
      }
      window.location.href = `/api/share/${token}/download${requiresPass ? `?pass=${encodeURIComponent(pass)}` : ''}`
    } catch {
      setError('Could not reach the server — try again, or ask your host for a new link.')
    } finally {
      setBusy(false)
    }
  }

  const syncToFolder = async () => {
    setError(null)
    setSynced(false)
    if (needPass()) return
    // showDirectoryPicker must run in the user gesture — call it first, before any await.
    const picker = (window as unknown as PickerWindow).showDirectoryPicker
    if (!picker) return
    let dir: DirHandle
    try {
      dir = await picker({ mode: 'readwrite' })
    } catch {
      // Cancelled — or Chrome blocked the folder ("contains system files"), which happens
      // when Palworld is under Program Files. Point them at the reliable path.
      setError('No folder selected. If Windows said it "contains system files" (Palworld in Program Files), Chrome can’t write there — use the Download button below instead.')
      return
    }
    setSyncing(true)
    setProgress(null)
    try {
      // Sanity-check it's the Palworld folder (the one containing Pal/).
      try {
        await dir.getDirectoryHandle('Pal')
      } catch {
        setError('That doesn’t look like your Palworld folder — pick the one that contains the “Pal” folder.')
        return
      }
      const mres = await fetch(`/api/share/${token}/files?check=0${passQ}`)
      if (!mres.ok) {
        setError((await mres.json().catch(() => ({}))).error ?? 'This link is not available.')
        return
      }
      const files: string[] = (await mres.json()).files ?? []
      setProgress({ done: 0, total: files.length })
      for (let i = 0; i < files.length; i++) {
        const rel = files[i]
        const fr = await fetch(`/api/share/${token}/file?path=${encodeURIComponent(rel)}${passQ}`)
        if (!fr.ok || !fr.body) throw new Error(`Failed on ${rel}`)
        const handle = await ensureFileHandle(dir, rel)
        const writable = await handle.createWritable()
        await fr.body.pipeTo(writable)
        setProgress({ done: i + 1, total: files.length })
      }
      setSynced(true)
    } catch (e) {
      setError(e instanceof Error ? `Sync failed: ${e.message}` : 'Sync failed. You can use the download instead.')
    } finally {
      setSyncing(false)
    }
  }

  const disabled = busy || syncing
  return (
    <div className="mt-6 flex flex-col gap-2">
      {requiresPass && (
        <input
          type="password"
          placeholder="Passphrase from your host"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void download()
          }}
          className="rounded-md border bg-muted/20 px-3 py-2 text-sm"
        />
      )}
      <button
        onClick={download}
        disabled={disabled}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy ? 'Checking…' : `⬇ Download the .zip (${sizeLabel})`}
      </button>
      {hasFSA && (
        <div className="mt-1 flex flex-col gap-1">
          <button
            onClick={syncToFolder}
            disabled={disabled}
            className="flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-60"
          >
            {syncing
              ? progress
                ? `Syncing… ${progress.done}/${progress.total}`
                : 'Preparing…'
              : '⚡ Or sync straight into my Palworld folder (advanced)'}
          </button>
          <p className="text-center text-[11px] text-muted-foreground">
            Chrome/Edge only, and <b>only works for custom installs outside protected system folders</b> — e.g. a
            Steam library at <code>D:\SteamLibrary</code> or <code>C:\Games</code>. It <b>won’t</b> work in the
            default <code>C:\Program&nbsp;Files&nbsp;(x86)\Steam</code> location — use Download + <b>Palworld Mod Manager.bat</b> there.
          </p>
        </div>
      )}
      {synced && (
        <p className="text-center text-xs text-emerald-600 dark:text-emerald-400">
          ✓ Synced! Launch Palworld — mods load ~1–2 minutes into the world.
        </p>
      )}
      {error && <p className="text-center text-xs text-destructive">{error}</p>}
    </div>
  )
}
