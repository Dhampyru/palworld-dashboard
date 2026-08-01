'use client'

// PATCH (not upstream): read-only Restart automation chip for the Dashboard
// Overview (docs/specs/restart-automation.md). Shows restarts-used-this-hour vs
// cap and the next scheduled restart; goes amber when the hourly cap is hit.
// Click -> the Maintenance tab's Restart automation card. No controls, no new
// data source (same /api/auto-restart the card uses; admin-only, so it renders
// nothing for the mod tier).
import { useCallback, useEffect, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { RotateCwIcon, TriangleAlertIcon } from 'lucide-react'

type ChipData = {
  settings: {
    crashEnabled: boolean
    memoryEnabled: boolean
    scheduledEnabled: boolean
    maxPerHour: number
  }
  nextScheduled: string | null
  usedThisHour: number
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function RestartAutomationChip({ onOpen }: { onOpen: () => void }) {
  const { config } = useServer()
  const [d, setD] = useState<ChipData | null>(null)

  const load = useCallback(async () => {
    if (!config) return
    try {
      const res = await fetch('/api/auto-restart', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.ok) setD(json as ChipData)
      else setD(null)
    } catch {
      /* keep last */
    }
  }, [config])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 60_000)
    return () => clearInterval(t)
  }, [load])

  if (!d) return null

  const anyOn = d.settings.crashEnabled || d.settings.memoryEnabled || d.settings.scheduledEnabled
  const capped = d.usedThisHour >= d.settings.maxPerHour
  const amber = capped && anyOn

  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open Restart automation (Maintenance)"
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] transition-colors hover:bg-muted/60 ${
        amber
          ? 'border-amber-500/50 text-amber-700 dark:text-amber-400'
          : 'text-muted-foreground'
      }`}
    >
      {amber ? <TriangleAlertIcon className="size-3.5" /> : <RotateCwIcon className="size-3.5" />}
      {!anyOn ? (
        <span>Auto-restart: off</span>
      ) : (
        <>
          <span>
            Auto-restart · <span className="text-foreground">{d.usedThisHour}</span>/{d.settings.maxPerHour} this hr
          </span>
          {d.nextScheduled && <span>· next {fmtTime(d.nextScheduled)}</span>}
          {capped && <span className="font-medium">· cap hit</span>}
        </>
      )}
    </button>
  )
}
