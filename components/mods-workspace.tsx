'use client'

import { useEffect, useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { GameModsPanel } from '@/components/game-mods-panel'
import { ClientModsPanel } from '@/components/client-mods-panel'
import { ClientConfigsPanel } from '@/components/client-configs-panel'
import { ReshadeCard } from '@/components/reshade-card'
import { UnifiedModUploader } from '@/components/unified-mod-uploader'
import { Ue4ssLoaderCard } from '@/components/ue4ss-loader-card'
import { FrameworkUpdatesCard } from '@/components/framework-updates-card'
import { ModProfilesCard } from '@/components/mod-profiles-card'
import { ModSyncCard } from '@/components/mod-sync-card'
import { ServerIcon, MonitorIcon, SparklesIcon } from 'lucide-react'

// PATCH (not upstream): the Mods page. ONE uploader (UnifiedModUploader) sits ABOVE the two
// sub-tabs — it scans an upload/URL, decides server/client/both, and installs there. The
// tabs below are now just LISTS: "Server mods" = what the SERVER runs; "Client mods" = the
// friend loadout staging. The old per-tab uploaders are hidden (hideInstall/hideUploader);
// a bumped reloadKey refreshes both lists after the shared uploader commits. Sub-tab only;
// the main dashboard tab is still `mods`. The sub-tab choice persists locally.
type Sub = 'server' | 'client' | 'reshade'
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
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    try {
      const s = localStorage.getItem(STORE_KEY)
      if (s === 'client' || s === 'server' || s === 'reshade') setSub(s)
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
      {/* Shared, always-visible loader + uploader above the tabs. */}
      <div className="shrink-0 space-y-3 border-b border-border/60 p-3">
        <Ue4ssLoaderCard onChanged={() => setReloadKey((k) => k + 1)} />
        <FrameworkUpdatesCard />
        <UnifiedModUploader onInstalled={() => setReloadKey((k) => k + 1)} />
        <ModProfilesCard reloadKey={reloadKey} onChanged={() => setReloadKey((k) => k + 1)} />
        <ModSyncCard reloadKey={reloadKey} onChanged={() => setReloadKey((k) => k + 1)} />
      </div>

      <div role="tablist" className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-2">
        <SubTab active={sub === 'server'} onClick={() => choose('server')} icon={<ServerIcon className="size-4" />} label="Server mods" />
        <SubTab active={sub === 'client'} onClick={() => choose('client')} icon={<MonitorIcon className="size-4" />} label="Client mods" />
        <SubTab active={sub === 'reshade'} onClick={() => choose('reshade')} icon={<SparklesIcon className="size-4" />} label="ReShade" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
        <ScrollArea className="h-full lg:h-auto lg:flex-1">
          {sub === 'server' ? (
            <GameModsPanel reloadKey={reloadKey} />
          ) : sub === 'client' ? (
            <>
              <ClientModsPanel hideUploader reloadKey={reloadKey} />
              <ClientConfigsPanel />
            </>
          ) : (
            <div className="p-4">
              <ReshadeCard />
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  )
}
