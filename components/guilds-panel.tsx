'use client'

// PATCH (not upstream): guild/base browser (roadmap item 3, re-scoped).
//
// Sourced from PalDefender's exportguilds rather than the save file -- see
// lib/guilds.ts for why save parsing is not available on this build.
//
// The reason this earns a tab rather than a card: it is the only view of
// OFFLINE players. The live snapshot shows who is connected right now; this
// shows everyone, with last-seen times and last-known positions. On a server
// where people play at different hours that is the more useful roster.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { RefreshCwIcon, ShieldIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react'
import type { Guild } from '@/lib/guilds'

// "3 days ago" beats a raw timestamp for the question actually being asked,
// which is "has this player abandoned the server?"
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

export function GuildsPanel() {
  const { config, players } = useServer()
  const [guilds, setGuilds] = useState<Guild[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [staleWarning, setStaleWarning] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    setError(null)
    try {
      const response = await fetch('/api/guilds', {
        headers: buildPalworldProxyHeaders(config),
        cache: 'no-store',
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? response.statusText)
      setGuilds(data.guilds ?? [])
      setStaleWarning(data.refreshed === false ? (data.refreshError ?? 'Showing a cached export.') : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load guilds')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    load()
  }, [load])

  // Who is connected right now, so offline members can be distinguished from
  // online ones. PalDefender ids and the snapshot's userId are different
  // formats, so match on name -- imperfect, but the badge is informational.
  const onlineNames = useMemo(
    () => new Set(players.map((player) => player.name.toLowerCase())),
    [players],
  )

  const filtered = useMemo(() => {
    if (!guilds) return []
    const needle = query.trim().toLowerCase()
    if (!needle) return guilds
    return guilds
      .map((guild) => ({
        ...guild,
        members: guild.members.filter((member) => member.nickName.toLowerCase().includes(needle)),
      }))
      .filter(
        (guild) =>
          guild.name.toLowerCase().includes(needle) ||
          guild.adminName.toLowerCase().includes(needle) ||
          guild.members.length > 0,
      )
  }, [guilds, query])

  const totalMembers = useMemo(
    () => (guilds ?? []).reduce((sum, guild) => sum + guild.memberCount, 0),
    [guilds],
  )

  return (
    <div className="flex h-full min-h-[30rem] flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldIcon className="size-5" />
          <h2 className="text-lg font-semibold">Guilds &amp; Players</h2>
          {guilds && (
            <span className="text-xs text-muted-foreground">
              ({guilds.length} guild{guilds.length === 1 ? '' : 's'}, {totalMembers} player
              {totalMembers === 1 ? '' : 's'})
            </span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading} className="gap-1.5">
          <RefreshCwIcon className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          Refresh
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Every player who has joined, including those offline — with last-seen times and last-known
        positions. Sourced from PalDefender, not the live connection list.
      </p>

      {staleWarning && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>Could not refresh — showing the last export. {staleWarning}</span>
        </p>
      )}

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search guilds or players…"
          className="pl-8"
          aria-label="Search guilds and players"
        />
      </div>

      <ScrollArea className="min-h-0 flex-1 rounded-md border">
        <div className="flex flex-col gap-3 p-3">
          {loading && !guilds && (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner className="size-4" /> Loading guilds…
            </div>
          )}
          {guilds && filtered.length === 0 && (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {query ? `Nothing matches “${query}”.` : 'No guilds found yet.'}
            </p>
          )}
          {filtered.map((guild) => (
            <div key={guild.id} className="flex flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{guild.name}</span>
                <Badge variant="secondary" className="text-[10px]">
                  Level {guild.level}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {guild.campNum}/{guild.campNumTotal} camps
                </Badge>
                <span className="text-xs text-muted-foreground">Leader: {guild.adminName}</span>
              </div>

              <div className="flex flex-col gap-1.5">
                {guild.members.map((member) => {
                  const online = onlineNames.has(member.nickName.toLowerCase())
                  return (
                    <div
                      key={member.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/30 px-2 py-1.5 text-sm"
                    >
                      <span className="font-medium">{member.nickName}</span>
                      {online && (
                        <Badge className="bg-emerald-500/15 text-[10px] text-emerald-600 dark:text-emerald-400">
                          online
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">Lv {member.level}</span>
                      <span className="text-xs text-muted-foreground">{member.exp} exp</span>
                      <span className="text-xs text-muted-foreground">
                        {online ? 'connected now' : `last seen ${relativeTime(member.lastOnline)}`}
                      </span>
                      {member.mapPosition && (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          ({member.mapPosition.x.toFixed(0)}, {member.mapPosition.y.toFixed(0)})
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
