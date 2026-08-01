'use client'

// Multi-instance (#7 Phase 6): the fleet LANDING. Shown after login when no
// server is selected — the operator picks a server (or creates one) here, then
// clicks in to open that server's full dashboard (see InstancesPanel's
// enterInstance). A minimal top bar carries only Logout; per-server controls
// (theme, settings, lifecycle) live inside the drilled-in dashboard.
import { useServer } from '@/lib/server-context'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { InstancesPanel } from '@/components/instances-panel'
import { LogOutIcon } from 'lucide-react'

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
          <div className="mx-auto w-full max-w-[1200px]">
            <InstancesPanel />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
