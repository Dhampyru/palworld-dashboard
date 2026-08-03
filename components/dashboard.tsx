'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { DashboardHeader } from '@/components/dashboard-header'
import { OnlinePlayersPanel } from '@/components/online-players-panel'
import { MobilePlayersSheet } from '@/components/mobile-players-sheet'
import { ConsolePanel } from '@/components/console-panel'
import { ChatPanel } from '@/components/chat-panel'
import { HUDCornerFrame } from '@/components/hud-corner-frame'
import { LiveMap } from '@/components/live-map'
import { GameModsPanel } from '@/components/game-mods-panel'
import { EnabledModsCard } from '@/components/enabled-mods-card'
import { RestartAutomationChip } from '@/components/restart-automation-chip'
import { WorldSettingsPanel } from '@/components/world-settings-panel'
import { RconConsoleModal } from '@/components/rcon-console-modal'
import { GuildsPanel } from '@/components/guilds-panel'
import { InvitePanel } from '@/components/invite-panel'
import { EngineTuningPanel } from '@/components/engine-tuning-panel'
import { GameDataCard } from '@/components/game-data-card'
import { PalDefenderPanel } from '@/components/paldefender-panel'
import { SavesPanel } from '@/components/saves-panel'
import { FleetView } from '@/components/fleet-view'
import {
  AnnouncementCard,
  ServerManagementCard,
  BanManagementCard,
  MetricsCard,
  SettingsCard
} from '@/components/server-control-cards'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useServer } from '@/lib/server-context'

const ACTIVE_TAB_STORAGE_KEY = 'activeDashboardTab'

type DashboardTab = 'dashboard' | 'map' | 'mods' | 'world' | 'guilds' | 'engine' | 'paldefender' | 'saves' | 'invite'

function readStoredTab(): DashboardTab {
  // Dashboard only mounts client-side (RequireServerConfig gates on post-mount
  // config hydration), so reading localStorage in the initializer is safe.
  if (typeof window === 'undefined') {
    return 'dashboard'
  }

  const stored = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY)
  // A stale 'rcon' (from before the console became a modal) is no longer a valid
  // tab -- it falls through to 'dashboard' rather than restoring a dead tab.
  return stored === 'map' ? 'map' : stored === 'mods' ? 'mods' : stored === 'world' ? 'world' : stored === 'guilds' ? 'guilds' : stored === 'engine' ? 'engine' : stored === 'paldefender' ? 'paldefender' : stored === 'saves' ? 'saves' : stored === 'invite' ? 'invite' : 'dashboard'
}

export function Dashboard() {
  const { consoleRequest, activeInstanceId } = useServer()
  const [playersSheetOpen, setPlayersSheetOpen] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<DashboardTab>(readStoredTab)

  // A roster quick-action (item B) sets a console request; open the console
  // MODAL so the panel can consume it (the console is no longer a tab, roadmap
  // #3). Also close the players sheet if open. The panel mounts with the modal
  // and reads consoleRequest on mount, so the prefill still lands.
  useEffect(() => {
    if (!consoleRequest) return
    setConsoleOpen(true)
    setPlayersSheetOpen(false)
  }, [consoleRequest])

  // Interactive-glow theme spans BOTH dashboard and map tabs (moved here from
  // DashboardHeader, which unmounts on the map tab and took the glow with it).
  useEffect(() => {
    document.body.classList.add('dashboard-interactive-glow')
    return () => document.body.classList.remove('dashboard-interactive-glow')
  }, [])

  const handleTabChange = useCallback((tab: DashboardTab) => {
    setActiveTab(tab)
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab)
  }, [])

  // When you switch INTO a server (fleet → open, or a different server), land on
  // the Overview rather than inheriting the previous server's last tab. A plain
  // reload (same instance across mount) keeps whatever tab you were on.
  const prevInstanceRef = useRef(activeInstanceId)
  useEffect(() => {
    if (activeInstanceId && activeInstanceId !== prevInstanceRef.current) {
      setActiveTab('dashboard')
      window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, 'dashboard')
    }
    prevInstanceRef.current = activeInstanceId
  }, [activeInstanceId])

  // Fleet-first navigation (#7): with no server selected, show the fleet landing.
  // Selecting one (enterInstance) scopes every request to it and renders the
  // full dashboard below; the header's "Instances" button returns here.
  if (!activeInstanceId) {
    return <FleetView />
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Shared header on every tab, including the Live Map (#3/#5): the map
          used to render its own overlay header instead, which read as
          inconsistent. Nav + action cluster + console all come from here now. */}
      <DashboardHeader
        activeTab={activeTab}
        onTabChange={handleTabChange}
        onPlayersClick={() => setPlayersSheetOpen(true)}
        onOpenConsole={() => setConsoleOpen(true)}
      />

      {/* `relative` so the Live Map branch can fill this box via `absolute
          inset-0`. Its canvas is absolutely positioned (zero layout height) and
          height:100% doesn't resolve under the min-h-screen root, so it needs a
          parent box to pin to. Other tabs stay in normal flow, unaffected. */}
      <div className="relative flex-1 lg:overflow-hidden">
        {activeTab === 'dashboard' ? (
          <div key="dashboard-tab" className="dashboard-tab-content dashboard-tab-content-animate mx-auto flex h-full w-full max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-4 lg:px-6 lg:py-4">
            <div className="flex min-h-0 flex-1 gap-4 lg:overflow-hidden">
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 backdrop-blur-sm lg:rounded-[1.75rem]">
                <HUDCornerFrame position="top-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="top-right" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-right" size={44} className="hidden lg:block" />

                <main className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
                  <div className="flex-1 overflow-y-auto lg:overflow-hidden">
                    <ScrollArea className="h-full lg:h-auto lg:flex-1">
                      <div className="p-3 sm:p-4 lg:p-6">
                        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
                          <h2 className="font-mono text-lg font-semibold uppercase tracking-[0.14em] text-foreground sm:text-2xl sm:tracking-[0.24em]">Dashboard Overview</h2>
                          <RestartAutomationChip onOpen={() => handleTabChange('saves')} />
                        </div>

                        {/* Hero: live performance */}
                        <div className="mb-4">
                          <MetricsCard />
                        </div>

                        {/* Top row: live feeds, kept tall (feeds have no intrinsic height). */}
                        <div className="grid gap-4 [grid-auto-rows:1fr] md:grid-cols-2 xl:grid-cols-3">
                          <BanManagementCard />
                          <ConsolePanel />
                          <ChatPanel />
                        </div>

                        {/* Bottom row: config/controls sized to their own content — lines
                            up with the Announcements card (Config Snapshot JSON flexes). */}
                        <div className="mt-4 grid gap-4 [grid-auto-rows:1fr] md:grid-cols-2 xl:grid-cols-3">
                          <SettingsCard />
                          <ServerManagementCard />
                          <AnnouncementCard />
                          <EnabledModsCard />
                        </div>
                      </div>
                    </ScrollArea>
                  </div>
                </main>
              </div>

              <div className="hidden xl:flex xl:min-h-0">
                <OnlinePlayersPanel />
              </div>
            </div>
          </div>
        ) : activeTab === 'mods' ? (
          <div key="mods-tab" className="dashboard-tab-content dashboard-tab-content-animate mx-auto flex h-full w-full max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-4 lg:px-6 lg:py-4">
            <div className="flex min-h-0 flex-1 gap-4 lg:overflow-hidden">
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 backdrop-blur-sm lg:rounded-[1.75rem]">
                <HUDCornerFrame position="top-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="top-right" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-right" size={44} className="hidden lg:block" />

                <main className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
                  <div className="flex-1 overflow-y-auto lg:overflow-hidden">
                    <ScrollArea className="h-full lg:h-auto lg:flex-1">
                      <GameModsPanel />
                    </ScrollArea>
                  </div>
                </main>
              </div>
            </div>
          </div>
        ) : activeTab === 'world' ? (
          <div key="world-tab" className="dashboard-tab-content dashboard-tab-content-animate mx-auto flex h-full w-full max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-4 lg:px-6 lg:py-4">
            <div className="flex min-h-0 flex-1 gap-4 lg:overflow-hidden">
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 backdrop-blur-sm lg:rounded-[1.75rem]">
                <HUDCornerFrame position="top-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="top-right" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-right" size={44} className="hidden lg:block" />

                <main className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
                  <div className="flex-1 overflow-y-auto lg:overflow-hidden">
                    <ScrollArea className="h-full lg:h-auto lg:flex-1">
                      <WorldSettingsPanel />
                    </ScrollArea>
                  </div>
                </main>
              </div>
            </div>
          </div>
        ) : activeTab === 'paldefender' ? (
          <div key="paldefender-tab" className="dashboard-tab-content dashboard-tab-content-animate mx-auto flex h-full w-full max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-4 lg:px-6 lg:py-4">
            <div className="flex min-h-0 flex-1 gap-4 lg:overflow-hidden">
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 backdrop-blur-sm lg:rounded-[1.75rem]">
                <HUDCornerFrame position="top-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="top-right" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-right" size={44} className="hidden lg:block" />

                <main className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
                  <div className="flex-1 overflow-y-auto lg:overflow-hidden">
                    <ScrollArea className="h-full lg:h-auto lg:flex-1">
                      <PalDefenderPanel />
                    </ScrollArea>
                  </div>
                </main>
              </div>
            </div>
          </div>
        ) : activeTab === 'saves' ? (
          <div key="saves-tab" className="dashboard-tab-content dashboard-tab-content-animate mx-auto flex h-full w-full max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-4 lg:px-6 lg:py-4">
            <div className="flex min-h-0 flex-1 gap-4 lg:overflow-hidden">
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 backdrop-blur-sm lg:rounded-[1.75rem]">
                <HUDCornerFrame position="top-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="top-right" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-right" size={44} className="hidden lg:block" />

                <main className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
                  <div className="flex-1 overflow-y-auto lg:overflow-hidden">
                    <ScrollArea className="h-full lg:h-auto lg:flex-1">
                      <SavesPanel />
                    </ScrollArea>
                  </div>
                </main>
              </div>
            </div>
          </div>
        ) : activeTab === 'engine' ? (
          <div key="engine-tab" className="dashboard-tab-content dashboard-tab-content-animate mx-auto flex h-full w-full max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-4 lg:px-6 lg:py-4">
            <div className="flex min-h-0 flex-1 gap-4 lg:overflow-hidden">
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 backdrop-blur-sm lg:rounded-[1.75rem]">
                <HUDCornerFrame position="top-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="top-right" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-right" size={44} className="hidden lg:block" />

                <main className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
                  <div className="flex-1 overflow-y-auto lg:overflow-hidden">
                    <ScrollArea className="h-full lg:h-auto lg:flex-1">
                      <div className="px-3 pt-3 sm:px-4">
                        <GameDataCard />
                      </div>
                      <EngineTuningPanel />
                    </ScrollArea>
                  </div>
                </main>
              </div>
            </div>
          </div>
        ) : activeTab === 'invite' ? (
          <div key="invite-tab" className="dashboard-tab-content dashboard-tab-content-animate mx-auto flex h-full w-full max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-4 lg:px-6 lg:py-4">
            <div className="flex min-h-0 flex-1 gap-4 lg:overflow-hidden">
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 backdrop-blur-sm lg:rounded-[1.75rem]">
                <HUDCornerFrame position="top-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="top-right" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-right" size={44} className="hidden lg:block" />

                <main className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
                  <div className="flex-1 overflow-y-auto lg:overflow-hidden">
                    <ScrollArea className="h-full lg:h-auto lg:flex-1">
                      <InvitePanel />
                    </ScrollArea>
                  </div>
                </main>
              </div>
            </div>
          </div>
        ) : activeTab === 'guilds' ? (
          <div key="guilds-tab" className="dashboard-tab-content dashboard-tab-content-animate mx-auto flex h-full w-full max-w-[1680px] flex-col gap-4 px-3 py-3 sm:px-4 lg:px-6 lg:py-4">
            <div className="flex min-h-0 flex-1 gap-4 lg:overflow-hidden">
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/40 backdrop-blur-sm lg:rounded-[1.75rem]">
                <HUDCornerFrame position="top-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="top-right" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-left" size={44} className="hidden lg:block" />
                <HUDCornerFrame position="bottom-right" size={44} className="hidden lg:block" />

                <main className="flex min-h-0 flex-1 flex-col lg:overflow-hidden">
                  <div className="flex-1 overflow-y-auto lg:overflow-hidden">
                    <ScrollArea className="h-full lg:h-auto lg:flex-1">
                      <GuildsPanel />
                    </ScrollArea>
                  </div>
                </main>
              </div>
            </div>
          </div>
        ) : (
          <div key="map-tab" className="dashboard-tab-content dashboard-tab-content-animate absolute inset-0 flex flex-col">
            {/* Fills the space below the shared header (was h-dvh full-viewport
                with its own StatusBar; the map's compact strip now carries the
                connection + tracked count). */}
            <div className="relative min-h-0 w-full flex-1 overflow-hidden bg-card/60">
              <HUDCornerFrame position="top-left" size={48} className="hidden lg:block" />
              <HUDCornerFrame position="top-right" size={48} className="hidden lg:block" />
              <HUDCornerFrame position="bottom-left" size={48} className="hidden lg:block" />
              <HUDCornerFrame position="bottom-right" size={48} className="hidden lg:block" />
              <LiveMap />
            </div>
          </div>
        )}
      </div>

      {/* RCON console modal (replaces the old RCON tab, roadmap #3). Rendered
          at the top level so it opens over any view, including the Live Map. */}
      <RconConsoleModal open={consoleOpen} onOpenChange={setConsoleOpen} />

      {/* Mobile players sheet */}
      <MobilePlayersSheet
        open={playersSheetOpen}
        onOpenChange={setPlayersSheetOpen}
      />
    </div>
  )
}
