'use client'

import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

// PATCH (not upstream): detects when a NEW dashboard build has been deployed while
// a tab is open (the tab keeps running the old bundle until reloaded) and prompts
// a one-click refresh — so operators don't have to guess whether a stale-looking
// UI needs a hard refresh. Polls the build id; fires once when it changes.
export function VersionWatcher() {
  const loaded = useRef<string | null>(null)
  const notified = useRef(false)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/api/app-version', { cache: 'no-store' })
        if (!res.ok) return
        const { version } = (await res.json()) as { version?: string }
        if (typeof version !== 'string') return
        if (loaded.current === null) {
          loaded.current = version // remember the build this tab is running
          return
        }
        if (version !== loaded.current && !notified.current) {
          notified.current = true
          toast('A new dashboard version is available', {
            id: 'app-version',
            duration: Infinity,
            description:
              'Refresh to load it. If the page still looks stale afterward, hard-refresh (Ctrl/Cmd+Shift+R).',
            action: { label: 'Refresh', onClick: () => window.location.reload() },
          })
        }
      } catch {
        /* offline / transient — try again next tick */
      }
    }
    void check()
    const id = setInterval(() => {
      if (!cancelled) void check()
    }, 45000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return null
}
