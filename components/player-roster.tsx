'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getPlayerKey, buildPalworldProxyHeaders } from '@/lib/palworld'
import { getPlayerAvatarColor } from '@/lib/player-avatar-colors'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { copyToClipboard } from '@/lib/clipboard'
import {
  MoreVerticalIcon,
  UserIcon,
  BanIcon,
  WifiIcon,
  EyeIcon,
  CheckIcon,
  CopyIcon,
  TerminalIcon
} from 'lucide-react'
import type { Player } from '@/lib/types'

function getPingColor(ping: number) {
  if (ping < 80) return 'text-green-500'
  if (ping < 150) return 'text-yellow-500'
  return 'text-red-500'
}

function getPlayerInitial(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  return trimmed.charAt(0).toUpperCase()
}

interface PlayerRosterProps {
  search: string
  /** Called after a successful kick/ban so the owner can refresh its roster. */
  onAfterAction?: () => void
  /** 'widget' keeps the row action menu always visible for touch screens. */
  variant?: 'sidebar' | 'widget'
  className?: string
}

// Shared personnel ledger: watchlist tier + roster rows with kick/ban/unban
// and watchlist toggle. Rendered by the full-admin sidebar
// (OnlinePlayersPanel) and by the mod-tier ModWidget. Extracted 2026-07-10
// for the two-tier password build — behavior matches the former inline
// sidebar rendering exactly.
// Accounts hidden from the MOD-tier widget only. Exact userId match — admin sidebar shows everyone.
const MOD_WIDGET_HIDDEN_USERIDS = new Set(
  (process.env.NEXT_PUBLIC_MOD_WIDGET_HIDDEN_USERIDS ?? '')
    .split(',')
    .map((userId) => userId.trim())
    .filter(Boolean)
)

// PATCH (item B): roster quick-actions that open the RCON console with a
// command preselected and the player prefilled. give*/tp are admin-cheat gated;
// kick/ban need only PalDefender. No new execution path -- the send still goes
// through the console UI and its confirms.
const CONSOLE_ACTIONS: { label: string; command: string; cheat: boolean; danger?: boolean }[] = [
  { label: 'Give Pal', command: 'givepal', cheat: true },
  { label: 'Give Pal Egg', command: 'giveegg', cheat: true },
  { label: 'Give Item', command: 'give', cheat: true },
  { label: 'Teleport', command: 'tp', cheat: true },
  { label: 'Kick', command: 'kick', cheat: false },
  { label: 'Ban', command: 'ban', cheat: false, danger: true },
]

export function PlayerRoster({ search, onAfterAction, variant = 'sidebar', className }: PlayerRosterProps) {
  const { apiCall, players, addBannedPlayer, bannedPlayers, config, requestConsole } = useServer()
  const [confirmAction, setConfirmAction] = useState<{ type: 'kick' | 'ban'; player: Player } | null>(null)
  // Console-command availability, so the quick-action menu only offers what the
  // current gating allows (spec B). Admin-only; the mod-tier widget skips it.
  const [caps, setCaps] = useState<{ detected: boolean; cheats: boolean } | null>(null)
  useEffect(() => {
    if (variant === 'widget' || !config) return
    let cancelled = false
    ;(async () => {
      try {
        const response = await fetch('/api/rcon', { headers: buildPalworldProxyHeaders(config) })
        if (!response.ok) return
        const data = await response.json()
        if (!cancelled) setCaps({ detected: Boolean(data.palDefender), cheats: data.allowAdminCheats !== false })
      } catch {
        /* leave null -- no console actions */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [config, variant])

  const consoleActions = caps?.detected
    ? CONSOLE_ACTIONS.filter((a) => (a.cheat ? caps.cheats : true))
    : []

  const handleKick = async (player: Player) => {
    if (!player.userId) {
      toast.error(`Cannot kick ${player.name}: missing user ID`)
      setConfirmAction(null)
      return
    }

    try {
      await apiCall('kick', 'POST', { userid: player.userId })
      toast.success(`Kicked ${player.name}`)
      onAfterAction?.()
    } catch {
      toast.error(`Failed to kick ${player.name}`)
    }
    setConfirmAction(null)
  }

  const handleBan = async (player: Player) => {
    if (!player.userId) {
      toast.error(`Cannot ban ${player.name}: missing user ID`)
      setConfirmAction(null)
      return
    }

    try {
      await apiCall('ban', 'POST', { userid: player.userId })
      addBannedPlayer({ name: player.name, steamId: player.userId, bannedAt: new Date().toISOString() })
      toast.success(`Banned ${player.name}`)
      onAfterAction?.()
    } catch {
      toast.error(`Failed to ban ${player.name}`)
    }
    setConfirmAction(null)
  }

  const searchQuery = search.trim().toLowerCase()
  const bannedPlayerIds = useMemo(() => new Set(bannedPlayers.map((player) => player.steamId)), [bannedPlayers])

  // Watchlist: operator-flagged players pinned to a top tier (owner order 2026-07-10).
  // Persisted by player key so it survives refreshes and re-joins.
  const [watchlist, setWatchlist] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    try {
      const raw = localStorage.getItem('playerWatchlist')
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
    } catch {
      return new Set()
    }
  })
  const toggleWatch = useCallback((player: Player) => {
    setWatchlist((prev) => {
      const next = new Set(prev)
      const key = getPlayerKey(player)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem('playerWatchlist', JSON.stringify([...next]))
      return next
    })
  }, [])

  // PATCH (not upstream): quick actions for the IP surfaced by the earlier
  // casing-bug fix -- copy for reference, or ban directly via PalDefender
  // without the copy-then-navigate-to-Ban-Management round trip.
  const handleCopyIp = (ip: string) => {
    void copyToClipboard(ip, { label: ip })
  }

  const handleBanIp = async (player: Player) => {
    if (!player.ip || !config) return
    try {
      const headers = new Headers(buildPalworldProxyHeaders(config))
      const res = await fetch(`/api/paldefender/banip/${encodeURIComponent(player.ip)}`, {
        method: 'POST',
        headers,
        cache: 'no-store',
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.Success) {
        toast.success(`Banned IP ${player.ip} (${player.name})`)
      } else {
        toast.error(`Failed to ban IP ${player.ip} — is PalDefender installed and configured?`)
      }
    } catch {
      toast.error(`Failed to ban IP ${player.ip}`)
    }
  }

  const filteredPlayers = useMemo(() => {
    const base = searchQuery
      ? players.filter((player) =>
          player.name.toLowerCase().includes(searchQuery) ||
          player.userId.toLowerCase().includes(searchQuery)
        )
      : players
    const scoped = variant === 'widget'
      ? base.filter((player) => !MOD_WIDGET_HIDDEN_USERIDS.has(player.userId))
      : base
    // Default sort: alphabetical by display name (owner order 2026-07-10)
    return [...scoped].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  }, [players, searchQuery, variant])

  const watchedPlayers = useMemo(() => filteredPlayers.filter((p) => watchlist.has(getPlayerKey(p))), [filteredPlayers, watchlist])
  const regularPlayers = useMemo(() => filteredPlayers.filter((p) => !watchlist.has(getPlayerKey(p))), [filteredPlayers, watchlist])

  // The "more options" (⋮) trigger. It MUST carry an explicit text colour: the
  // ghost button variant sets no base colour (only hover), so without this the
  // icon inherits whatever the row happens to give it and goes near-invisible in
  // some themes (reported missing) — Kick/Ban stay visible only because they set
  // their own colours. Matches the Kick button's muted->foreground treatment.
  const actionTriggerClass = `${variant === 'widget' ? 'h-9 w-9' : 'h-8 w-8'} text-muted-foreground hover:text-foreground`

  const renderPlayerRow = (player: Player) => {
    const isBanned = bannedPlayerIds.has(player.userId)
    const avatarColor = getPlayerAvatarColor(getPlayerKey(player))
    const watched = watchlist.has(getPlayerKey(player))
    return (
      <div
        key={getPlayerKey(player)}
        className={`flex items-center gap-2 p-2 rounded-lg hover:bg-secondary/50 transition-colors group ${isBanned ? 'border border-destructive/30 bg-destructive/5' : ''}`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div
            className={`avatar-circle w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 border border-white/20 ${isBanned ? 'ring-1 ring-destructive/60' : ''}`}
            style={{ backgroundColor: avatarColor }}
          >
            <span className="font-mono text-sm font-semibold text-white">
              {getPlayerInitial(player.name)}
            </span>
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              {/* PATCH (not upstream): hover to see IP -- useful for the new
                  PalDefender IP-ban feature. Was previously always empty due
                  to a casing bug (see normalizePlayersPayload in lib/palworld.ts). */}
              <p
                className="text-sm font-medium text-foreground truncate"
                title={player.ip ? `IP: ${player.ip}` : undefined}
              >
                {player.name}
              </p>
              {isBanned && <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-destructive/15 text-destructive shrink-0">BANNED</span>}
            </div>
            {/* min-w-0 is load-bearing: this is a flex row whose no-wrap
                children (coords) would otherwise force a min-content width that
                propagates up and pushes the shrink-0 Kick/Ban/⋮ group off the
                ~320px panel's clipped right edge. min-w-0 lets it shrink+clip. */}
            <p className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
              Lvl {player.level}
              {player.accountName && player.accountName !== player.name && (
                <><span className="mx-0.5">·</span><span className="truncate max-w-20">{player.accountName}</span></>
              )}
              {/* PATCH (not upstream): PalDefender enrichment -- absent
                  entirely when PalDefender isn't installed/configured, and
                  skipped for the generic "Unnamed Guild" default too. */}
              {player.guildName && player.guildName !== 'Unnamed Guild' && (
                <><span className="mx-0.5">·</span><span className="truncate max-w-24">{player.guildName}</span></>
              )}
              {/* World position intentionally NOT shown here (removed 2026-07-25):
                  it lives on the Live Map + the player-detail panel, and its
                  whitespace-nowrap width added nothing but row bloat. */}
            </p>
          </div>
        </div>
        {/* PATCH (not upstream): hidden in the narrow sidebar variant to make
            room for the always-visible kick/ban buttons below -- ping is
            less critical here than being able to actually act on a player. */}
        {variant !== 'sidebar' && (
          <div className="flex w-16 shrink-0 items-center justify-end gap-1 font-mono text-xs tabular-nums">
            <span className={getPingColor(Math.floor(player.ping ?? 0))}>{Math.floor(player.ping ?? 0)}ms</span>
            <WifiIcon className={`h-3 w-3 shrink-0 ${getPingColor(Math.floor(player.ping ?? 0))}`} />
          </div>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          {/* PATCH (not upstream): kick/ban were only reachable via a dropdown
              that's invisible until row hover -- easy to miss entirely. These
              are the same handlers, just always-visible icon buttons. */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            title={`Kick ${player.name}`}
            onClick={() => setConfirmAction({ type: 'kick', player })}
          >
            <UserIcon className="w-4 h-4" />
          </Button>
          {/* PATCH (not upstream): Unban removed from here -- it's now
              exclusively the Ban Management card's job, avoiding two
              controls for the same action in different places. */}
          {!isBanned && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
              title={`Ban ${player.name}`}
              onClick={() => setConfirmAction({ type: 'ban', player })}
            >
              <BanIcon className="w-4 h-4" />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={actionTriggerClass}
              >
                <MoreVerticalIcon className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => toggleWatch(player)}>
                <EyeIcon className="w-4 h-4 mr-2" />
                Watchlist
                {watched && <CheckIcon className="w-4 h-4 ml-auto text-primary" />}
              </DropdownMenuItem>
              {/* Console quick-actions (item B): open the RCON console with the
                  command preselected and this player prefilled. Only what the
                  current gating allows; nothing sends without the console's own
                  review + confirm. Needs a UserId to target. */}
              {consoleActions.length > 0 && player.userId && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Console
                  </DropdownMenuLabel>
                  {consoleActions.map((action) => (
                    <DropdownMenuItem
                      key={action.command}
                      onClick={() => requestConsole(action.command, player.userId)}
                      className={action.danger ? 'text-destructive focus:text-destructive' : undefined}
                    >
                      <TerminalIcon className="w-4 h-4 mr-2" />
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
              {/* PATCH (not upstream): only shown once the IP is actually
                  known -- was previously always empty due to a casing bug. */}
              {player.ip && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleCopyIp(player.ip)}>
                    <CopyIcon className="w-4 h-4 mr-2" />
                    Copy IP
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => handleBanIp(player)}
                    className="text-destructive focus:text-destructive"
                  >
                    <BanIcon className="w-4 h-4 mr-2" />
                    Ban IP (PalDefender)
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Radix ScrollArea wraps content in a `display:table; min-width:100%`
          element that sizes to CONTENT, so a no-wrap flex row (our roster row)
          has no bounded width to shrink against -- flex-1/min-w-0/truncate are
          all defeated and the Kick/Ban/⋮ group gets clipped off the right edge
          (QA regression). Force that wrapper back to `block` so the row is bound
          to the panel width and the name/coords truncate instead. Scoped to this
          instance's viewport only, so other (e.g. horizontal) scroll areas are
          unaffected. */}
      <ScrollArea
        className={cn('[&_[data-slot=scroll-area-viewport]>div]:block!', className ?? 'min-h-0 flex-1')}
      >
        <div className="p-2">
          {filteredPlayers.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              {search ? 'No players found' : 'No players online'}
            </div>
          ) : (
            <div className="space-y-1">
              {watchedPlayers.length > 0 && (
                <>
                  <div className="flex items-center gap-1.5 px-1 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-primary/80">
                    <EyeIcon className="h-3 w-3" /> Watchlist
                  </div>
                  {watchedPlayers.map((player) => renderPlayerRow(player))}
                  <div className="my-1.5 border-t border-border/40" />
                </>
              )}
              {regularPlayers.map((player) => renderPlayerRow(player))}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Confirmation Dialog */}
      <AlertDialog open={!!confirmAction} onOpenChange={() => setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.type === 'kick' ? 'Kick Player' : 'Ban Player'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to {confirmAction?.type} {confirmAction?.player.name}?
              {confirmAction?.type === 'ban' && ' This action can be reversed by unbanning the player.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmAction?.type === 'kick') {
                  handleKick(confirmAction.player)
                } else if (confirmAction?.type === 'ban') {
                  handleBan(confirmAction.player)
                }
              }}
              className={confirmAction?.type === 'ban' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
            >
              {confirmAction?.type === 'kick' ? 'Kick' : 'Ban'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
