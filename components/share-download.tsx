'use client'

import { useState } from 'react'

// PATCH (not upstream): the share page's download control (docs/specs/client-mod-sync.md §8a).
// Pre-checks the link (and passphrase, if set) before triggering the real download — so a
// wrong passphrase / dead link shows a message instead of navigating to raw JSON, and only
// the actual download counts against a use limit.
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

  const download = async () => {
    setError(null)
    if (requiresPass && !pass.trim()) {
      setError('Enter the passphrase your host gave you.')
      return
    }
    setBusy(true)
    try {
      const passQ = requiresPass ? `&pass=${encodeURIComponent(pass)}` : ''
      const res = await fetch(`/api/share/${token}/download?check=1${passQ}`)
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        setError(j.error ?? 'This link is not available.')
        return
      }
      // OK — trigger the real (counted) download by navigating to it.
      window.location.href = `/api/share/${token}/download${requiresPass ? `?pass=${encodeURIComponent(pass)}` : ''}`
    } catch {
      setError('Could not reach the server — try again, or ask your host for a new link.')
    } finally {
      setBusy(false)
    }
  }

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
        disabled={busy}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy ? 'Checking…' : `⬇ Download the mod bundle (${sizeLabel})`}
      </button>
      {error && <p className="text-center text-xs text-destructive">{error}</p>}
    </div>
  )
}
