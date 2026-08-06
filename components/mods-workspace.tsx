'use client'

import { useEffect, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { GameModsPanel } from '@/components/game-mods-panel'
import { ClientModsPanel } from '@/components/client-mods-panel'
import { ServerIcon, MonitorIcon } from 'lucide-react'

// PATCH (not upstream): the Mods page is split into two sub-tabs (docs/specs/client-mod-
// sync.md §6). "Server mods" is the original panel (what the SERVER runs). "Client mods"
// stages the mods a friend's client needs for the onboarding loadout — never installed on
// the server. Sub-tab only; the main tab is still `mods` (dashboard.tsx tab plumbing
// unchanged). The choice persists locally so it survives a reload.
type Sub = 'server' | 'client'
const STORE_KEY = 'modsSubTab'

function SubTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
      aria-selected={active}
      role="tab"
    >
      {icon}
      {label}
    </button>
  )
}

export function ModsWorkspace() {
  const [sub, setSub] = useState<Sub>('server')

  useEffect(() => {
    try {
      const s = localStorage.getItem(STORE_KEY)
      if (s === 'client' || s === 'server') setSub(s)
    } catch {
      /* ignore */
    }
  }, [])

  const choose = (s: Sub) => {
    setSub(s)
    try {
      localStorage.setItem(STORE_KEY, s)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2">
        <SubTab active={sub === 'server'} onClick={() => choose('server')} icon={<ServerIcon className="size-4" />} label="Server mods" />
        <SubTab active={sub === 'client'} onClick={() => choose('client')} icon={<MonitorIcon className="size-4" />} label="Client mods" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
        <ScrollArea className="h-full lg:h-auto lg:flex-1">
          {sub === 'server' ? <GameModsPanel /> : <ClientModsPanel />}
        </ScrollArea>
      </div>
    </div>
  )
}
