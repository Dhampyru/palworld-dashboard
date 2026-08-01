'use client'

// PATCH (not upstream): per-player detail panel for the live map (roadmap
// item 4). Opens when a map marker is clicked. Two entity kinds:
//
//  - online  -> from the live snapshot (name, level, guild, ping, precise x/y/z)
//  - offline -> from the PalDefender guild export (lib/guilds.ts): last-seen
//    time and last-known position, which the snapshot cannot provide at all.
//
// Purely presentational; the map owns selection state and positioning.

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { MapPinIcon, ClockIcon, ShieldIcon, SignalIcon } from 'lucide-react'
import type { Player } from '@/lib/types'
import type { GuildMember } from '@/lib/guilds'

export type SelectedMapEntity =
  | { kind: 'online'; player: Player }
  | { kind: 'offline'; member: GuildMember; guildName: string }

function relativeTime(iso: string | null): string {
  if (!iso) return 'unknown'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'unknown'
  const minutes = Math.floor((Date.now() - then) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`
}

function Row({ icon, label, children }: { icon?: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/50 py-2 last:border-b-0">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </span>
      <span className="text-right text-sm">{children}</span>
    </div>
  )
}

export function PlayerDetailPanel({
  selected,
  onClose,
}: {
  selected: SelectedMapEntity | null
  onClose: () => void
}) {
  return (
    <Sheet open={selected !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-sm">
        {selected?.kind === 'online' && <OnlineDetail player={selected.player} />}
        {selected?.kind === 'offline' && (
          <OfflineDetail member={selected.member} guildName={selected.guildName} />
        )}
      </SheetContent>
    </Sheet>
  )
}

function OnlineDetail({ player }: { player: Player }) {
  const precise = player.preciseLocation
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          {player.name}
          <Badge className="bg-emerald-500/15 text-[10px] text-emerald-600 dark:text-emerald-400">online</Badge>
        </SheetTitle>
      </SheetHeader>
      <div className="flex flex-col">
        <Row label="Level">{player.level || '—'}</Row>
        {player.guildName && player.guildName !== 'Unnamed Guild' && (
          <Row icon={<ShieldIcon className="size-3.5" />} label="Guild">
            {player.guildName}
          </Row>
        )}
        <Row icon={<SignalIcon className="size-3.5" />} label="Ping">
          {player.ping ? `${Math.round(player.ping)} ms` : '—'}
        </Row>
        <Row icon={<MapPinIcon className="size-3.5" />} label="World position">
          <span className="font-mono text-xs">
            {player.location_x.toFixed(0)}, {player.location_y.toFixed(0)}
          </span>
        </Row>
        {precise && (
          <Row label="Precise (x, y, z)">
            <span className="font-mono text-xs">
              {precise.x.toFixed(0)}, {precise.y.toFixed(0)}, {precise.z.toFixed(0)}
            </span>
          </Row>
        )}
        {player.userId && (
          <Row label="UserId">
            <span className="break-all font-mono text-[11px] text-muted-foreground">{player.userId}</span>
          </Row>
        )}
      </div>
    </>
  )
}

function OfflineDetail({ member, guildName }: { member: GuildMember; guildName: string }) {
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          {member.nickName}
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            offline
          </Badge>
        </SheetTitle>
      </SheetHeader>
      <div className="flex flex-col">
        <Row icon={<ClockIcon className="size-3.5" />} label="Last seen">
          {relativeTime(member.lastOnline)}
        </Row>
        <Row label="Level">{member.level || '—'}</Row>
        <Row label="Experience">{member.exp ? member.exp.toLocaleString() : '—'}</Row>
        <Row icon={<ShieldIcon className="size-3.5" />} label="Guild">
          {guildName}
        </Row>
        {member.worldPosition && (
          <Row icon={<MapPinIcon className="size-3.5" />} label="Last-known position">
            <span className="font-mono text-xs">
              {member.worldPosition.x.toFixed(0)}, {member.worldPosition.y.toFixed(0)}
            </span>
          </Row>
        )}
        {member.mapPosition && (
          <Row label="Map grid">
            <span className="font-mono text-xs">
              {member.mapPosition.x.toFixed(0)}, {member.mapPosition.y.toFixed(0)}
            </span>
          </Row>
        )}
        <p className="pt-2 text-[11px] text-muted-foreground">
          Last-known data from PalDefender — this player is not currently connected.
        </p>
      </div>
    </>
  )
}
