'use client'

// Multi-instance (#7 Phase 6): the fleet LANDING. Shown after login when no
// server is selected — the operator picks a server (or creates one) here, then
// clicks in to open that server's full dashboard (see InstancesPanel's
// enterInstance). A minimal top bar carries only Logout; per-server controls
// (theme, settings, lifecycle) live inside the drilled-in dashboard.
//
// Two columns on wide screens: the server list on the left, and an optional
// "Game data" setup box on the right (upload usmap → names; upload icons) — it
// targets the default instance and is purely additive; the dashboard is fully
// functional without it.
import { useServer } from '@/lib/server-context'
import { GAMEDATA_SHARED_ID } from '@/lib/gamedata-icon-base'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { InstancesPanel } from '@/components/instances-panel'
import { GameDataCard } from '@/components/game-data-card'
import { LogOutIcon, InfoIcon } from 'lucide-react'

export function FleetView() {
  const { clearConfig } = useServer()
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border/60 bg-card/40 px-4 py-3 backdrop-blur-sm">
        <span className="font-mono text-sm font-semibold uppercase tracking-[0.2em] text-foreground">
          Palworld · Servers
        </span>
        <Button variant="ghost" size="sm" onClick={clearConfig} className="gap-1.5" title="Log out">
          <LogOutIcon className="size-4" /> Logout
        </Button>
      </header>
      <div className="relative flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <div className="mx-auto grid w-full max-w-[1400px] gap-4 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_380px]">
            {/* Left: the server list */}
            <div className="min-w-0">
              <InstancesPanel />
            </div>

            {/* Right: optional game-data setup */}
            <aside className="flex flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
              <div className="rounded-2xl border border-border/60 bg-card/40 p-3 backdrop-blur-sm">
                <h2 className="text-sm font-semibold text-foreground">Add game names &amp; icons</h2>
                <p className="mt-1 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    <span className="font-medium text-foreground">
                      Optional — the dashboard works fully without it.
                    </span>{' '}
                    Everything already runs on the raw game IDs; this just makes the RCON pickers show friendly names
                    (<em>Melpaca</em>) and icons instead of IDs like{' '}
                    <code className="font-mono">Special_PalSphere_Grade_01</code>.
                  </span>
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Palworld&apos;s names and art are Pocketpair&apos;s, so they can&apos;t be bundled with this
                  (MIT-licensed) project — instead you generate them from your <em>own</em> copy of the game, which is
                  unambiguously yours to extract. Nothing is redistributed by us. Applies to <strong>every</strong>{' '}
                  server here (fleet-wide).
                </p>
              </div>
              <GameDataCard scope={GAMEDATA_SHARED_ID} />
            </aside>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
