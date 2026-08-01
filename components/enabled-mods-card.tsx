'use client'

import { useEffect, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { isFrameworkDefault } from '@/lib/ue4ss-framework-defaults'
import { PanelSection } from '@/components/server-control-cards'
import { Badge } from '@/components/ui/badge'

interface GameModEntry {
  id: string
  kind: 'ue4ss' | 'pak'
  name: string
  enabled: boolean
}

// PATCH (not upstream): read-only summary for the main dashboard — deliberately
// no toggle/remove actions here. All mod *management* stays on the Mods tab;
// this card exists purely so "what's actually running" is visible at a glance
// without leaving the overview.
export function EnabledModsCard() {
  const { config } = useServer()
  const [mods, setMods] = useState<GameModEntry[] | null>(null)

  useEffect(() => {
    if (!config) return
    let cancelled = false

    fetch('/api/game-mods', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setMods(data.mods ?? [])
      })
      .catch(() => {
        if (!cancelled) setMods([])
      })

    return () => {
      cancelled = true
    }
  }, [config])

  const active = (mods ?? []).filter((m) => m.enabled && !isFrameworkDefault(m.kind, m.name))

  return (
    <PanelSection title="Enabled Mods" subtitle="Active Loadout" status={active.length > 0 ? 'active' : 'complete'}>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {mods === null ? 'Loading…' : `${active.length} Active`}
      </p>
      {mods !== null && active.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-3">No mods enabled</p>
      )}
      {active.length > 0 && (
        <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
          {active.map((mod) => (
            <div key={mod.id} className="flex items-center gap-2 p-2 rounded-lg bg-secondary/50 border border-border">
              <Badge variant={mod.kind === 'ue4ss' ? 'default' : 'secondary'} className="shrink-0">
                {mod.kind === 'ue4ss' ? 'UE4SS' : 'pak'}
              </Badge>
              <span className="truncate text-sm text-foreground">{mod.name}</span>
            </div>
          ))}
        </div>
      )}
    </PanelSection>
  )
}
