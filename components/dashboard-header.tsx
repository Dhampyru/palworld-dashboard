'use client'

import { useEffect, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { useTheme } from '@/lib/theme-context'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import Link from 'next/link'
import { BookOpenIcon, CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, HomeIcon, LayersIcon, LogOutIcon, PaletteIcon, SettingsIcon, UserPlusIcon } from 'lucide-react'
import { copyToClipboard } from '@/lib/clipboard'
import { PanelSettingsDialog } from '@/components/panel-settings-dialog'
import { ServerActionCluster } from '@/components/server-action-cluster'
import { GameUpdatePill } from '@/components/game-update-pill'

type DashboardTab = 'dashboard' | 'map' | 'mods' | 'world' | 'guilds' | 'engine' | 'paldefender' | 'saves' | 'invite'

interface DashboardHeaderProps {
  activeTab?: DashboardTab
  onTabChange?: (tab: DashboardTab) => void
  onPlayersClick?: () => void
  onOpenConsole?: () => void
}

// The ONE connection truth on the dashboard view. Colors match the previous
// SignalIndicator status palette (green/amber/red).
const CONNECTION_DOT_CLASS: Record<'connected' | 'checking' | 'disconnected', string> = {
  connected: 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]',
  checking: 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.6)] animate-pulse',
  disconnected: 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.6)] animate-pulse',
}

const CONNECTION_TEXT_CLASS: Record<'connected' | 'checking' | 'disconnected', string> = {
  connected: 'text-green-500',
  checking: 'text-amber-500',
  disconnected: 'text-red-500',
}

export function DashboardHeader({ activeTab = 'dashboard', onTabChange, onPlayersClick, onOpenConsole }: DashboardHeaderProps) {
  const { config, clearConfig, players, connectionStatus, serverInfo, exitToFleet } = useServer()
  const { theme, setTheme, themes } = useTheme()
  const [addressCopied, setAddressCopied] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The public IP is masked by default (screenshots / streams); the eye toggle
  // reveals it. Copy always copies the real address regardless of this.
  const [ipRevealed, setIpRevealed] = useState(false)

  useEffect(() => {
    if (!addressCopied) return
    const timer = window.setTimeout(() => setAddressCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [addressCopied])

  const gameAddress = config ? `${config.serverIp}:${config.gamePort}` : null
  // Mask only the host; the port is not sensitive and helps confirm it's right.
  const maskedAddress = config
    ? `${/^\d+\.\d+\.\d+\.\d+$/.test(config.serverIp) ? '•••.•••.•••.•••' : '••••••••'}:${config.gamePort}`
    : null

  const copyAddress = async () => {
    if (!gameAddress) return
    // copyToClipboard falls back to execCommand on insecure (http) origins, so
    // this works over plain http://<ip> where navigator.clipboard is absent. It
    // copies the REAL address even while the display is masked.
    const ok = await copyToClipboard(gameAddress, { label: gameAddress })
    if (ok) setAddressCopied(true)
  }

  const currentTab = activeTab

  return (
    <header>
      <div className="mx-auto w-full max-w-[1680px] px-3 pt-3 sm:px-4 sm:pt-4 lg:px-6">
        <div className="rounded border border-border/50 bg-card/50 px-3 py-2.5 backdrop-blur-sm sm:px-4">
          <div className="flex flex-col gap-2.5">
            {/* Row 1 (thin, upper): identity + status left; icon utilities + Logout right */}
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <div className="flex min-w-0 items-baseline gap-2 font-mono">
                <span className="truncate text-sm font-bold uppercase tracking-[0.14em] text-foreground">
                  {serverInfo?.servername ?? 'Palworld Server'}
                </span>
                {serverInfo?.version && (
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    v{serverInfo.version}
                  </span>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <span className={cn('status-dot h-2 w-2 rounded-full', CONNECTION_DOT_CLASS[connectionStatus])} />
                <span className={cn('font-mono text-[10px] uppercase tracking-[0.2em]', CONNECTION_TEXT_CLASS[connectionStatus])}>
                  {connectionStatus}
                </span>
              </div>

              {/* Dashboard-wide game-update alert (renders on every tab; shows only when an
                  update is available). */}
              <GameUpdatePill />
              </div>

              {/* Row 1 right: icon-only Docs / Theme / Settings, a separator, then
                  Logout -- renamed from "Disconnect" (which read like a server
                  action) and kept apart from the row-2 lifecycle controls. */}
              <div className="flex items-center gap-1.5">
                {/* Invite lives with the utilities (not the content tabs) — it's an
                    onboarding action. Drives activeTab='invite' via onTabChange. */}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onTabChange?.('invite')}
                  aria-label="Invite friends"
                  title="Invite friends"
                  aria-pressed={currentTab === 'invite'}
                  className={`h-8 w-8${currentTab === 'invite' ? ' bg-primary/10 text-primary' : ''}`}
                >
                  <UserPlusIcon className="h-4 w-4" />
                </Button>
                <Button asChild variant="ghost" size="icon" aria-label="Docs" title="Docs" className="h-8 w-8">
                  <Link href="/docs">
                    <BookOpenIcon className="h-4 w-4" />
                  </Link>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Theme" title="Theme" className="h-8 w-8">
                      <PaletteIcon className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    {themes.map((option) => (
                      <DropdownMenuItem
                        key={option.value}
                        onClick={() => setTheme(option.value)}
                        data-selected={theme === option.value ? 'true' : 'false'}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-[11px] uppercase tracking-[0.2em]">{option.label}</span>
                          {theme === option.value && <CheckIcon className="h-3.5 w-3.5 text-primary" />}
                        </span>
                        <span className="flex items-center gap-2">
                          {theme === option.value && (
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-primary">Selected</span>
                          )}
                          <span
                            className="status-dot h-2.5 w-2.5 rounded-full border border-white/20"
                            style={{ backgroundColor: option.accent }}
                          />
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {config?.accessTier === 'admin' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSettingsOpen(true)}
                    aria-label="Panel settings"
                    title="Panel settings"
                    className="h-8 w-8"
                  >
                    <SettingsIcon className="h-4 w-4" />
                  </Button>
                )}
                <span className="mx-1 h-5 w-px bg-border/60" aria-hidden />
                {/* Multi-instance (#7): back to the fleet landing to switch servers. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={exitToFleet}
                  title="Back to all servers"
                  className="h-8 gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em]"
                >
                  <LayersIcon className="h-3.5 w-3.5" />
                  Instances
                </Button>
                <span className="mx-1 h-5 w-px bg-border/60" aria-hidden />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearConfig}
                  title="Log out of the panel"
                  className="no-interactive-glow h-8 gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-destructive hover:!bg-destructive hover:!text-destructive-foreground"
                >
                  <LogOutIcon className="h-3.5 w-3.5" />
                  Logout
                </Button>
              </div>
            </div>

            {/* Row 2: game address left, tabs center, lifecycle + console right. */}
            <div className="flex flex-col gap-2.5 xl:grid xl:grid-cols-[auto_1fr_auto] xl:items-center xl:gap-3">
              {/* Left: masked game address + reveal/copy */}
              <div className="flex min-w-0 items-center">
              {config && gameAddress ? (
                <div className="flex min-w-0 items-center gap-1 rounded border border-border/50 bg-muted/20 pr-1 font-mono text-[11px] tracking-[0.08em] text-foreground/80">
                  <button
                    type="button"
                    onClick={copyAddress}
                    title={ipRevealed ? `Copy ${gameAddress}` : 'Copy game address'}
                    className="group flex min-w-0 items-center gap-1.5 px-2 py-1 transition-colors hover:text-primary"
                  >
                    <span className="truncate">{ipRevealed ? gameAddress : maskedAddress}</span>
                    {addressCopied ? (
                      <CheckIcon className="h-3 w-3 shrink-0 text-primary" />
                    ) : (
                      <CopyIcon className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-primary" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIpRevealed((v) => !v)}
                    title={ipRevealed ? 'Hide IP' : 'Reveal IP'}
                    aria-label={ipRevealed ? 'Hide IP' : 'Reveal IP'}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-primary"
                  >
                    {ipRevealed ? <EyeOffIcon className="h-3 w-3" /> : <EyeIcon className="h-3 w-3" />}
                  </button>
                </div>
              ) : (
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Awaiting Server Link
                </span>
              )}
            </div>

            {/* Center: tab switcher */}
            <Tabs
              value={currentTab}
              // Values come only from the TabsTriggers below, all valid DashboardTab
              // strings -- cast directly rather than a per-tab chain that silently
              // dropped new tabs to 'dashboard' (guilds + engine both regressed this way).
              onValueChange={(value) => onTabChange?.(value as DashboardTab)}
              className="w-full min-w-0 xl:justify-self-center"
            >
              {/* Below xl the tab row is full width and 7 tabs can overflow; scroll
                  instead of squishing. A content-width (w-max) list with mx-auto
                  centers when it fits, and because the SCROLL container is the
                  wrapper (not a justify-center flex), the first tab stays reachable
                  when it doesn't. */}
              <div className="w-full overflow-x-auto scrollbar-hidden">
                <TabsList className="mx-auto h-10 w-max rounded-md border border-border/60 bg-muted/20">
                {/* Icon-only home trigger. value stays 'dashboard' so the cast
                    onValueChange handler resolves it exactly as before -- the icon
                    swap is presentational only. aria-label/title keep it named. */}
                <TabsTrigger value="dashboard" aria-label="Dashboard" title="Dashboard" className="px-3 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:border-primary/60 data-[state=active]:bg-primary/10 data-[state=active]:text-primary sm:px-4">
                  <HomeIcon className="h-3.5 w-3.5" />
                </TabsTrigger>
                <TabsTrigger value="map" className="px-3 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:border-primary/60 data-[state=active]:bg-primary/10 data-[state=active]:text-primary sm:px-4">
                  Live Map
                </TabsTrigger>
                <TabsTrigger value="mods" className="px-3 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:border-primary/60 data-[state=active]:bg-primary/10 data-[state=active]:text-primary sm:px-4">
                  Mods
                </TabsTrigger>
                <TabsTrigger value="world" className="px-3 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:border-primary/60 data-[state=active]:bg-primary/10 data-[state=active]:text-primary sm:px-4">
                  World
                </TabsTrigger>
                <TabsTrigger value="guilds" className="px-3 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:border-primary/60 data-[state=active]:bg-primary/10 data-[state=active]:text-primary sm:px-4">
                  Guilds
                </TabsTrigger>
                <TabsTrigger value="engine" className="px-3 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:border-primary/60 data-[state=active]:bg-primary/10 data-[state=active]:text-primary sm:px-4">
                  Engine
                </TabsTrigger>
                <TabsTrigger value="paldefender" className="px-3 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:border-primary/60 data-[state=active]:bg-primary/10 data-[state=active]:text-primary sm:px-4">
                  PalDefender
                </TabsTrigger>
                <TabsTrigger value="saves" className="px-3 font-mono text-[11px] uppercase tracking-[0.2em] data-[state=active]:border-primary/60 data-[state=active]:bg-primary/10 data-[state=active]:text-primary sm:px-4">
                  Maintenance
                </TabsTrigger>
                </TabsList>
              </div>
            </Tabs>

              {/* Row 2 right: mobile roster shortcut + the lifecycle / console
                  action cluster (state-aware Start/Stop, Restart, Save, Console). */}
              <div className="flex items-center justify-end gap-1.5 xl:justify-self-end">
                {onPlayersClick && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onPlayersClick}
                    className="h-8 gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] xl:hidden"
                  >
                    Roster {players.length}
                  </Button>
                )}
                <ServerActionCluster onOpenConsole={onOpenConsole} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <PanelSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  )
}
