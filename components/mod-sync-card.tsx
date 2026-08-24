'use client'

import { useCallback, useEffect, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { TriangleAlertIcon, ArrowRightIcon, ArrowLeftIcon, RefreshCwIcon, CheckIcon } from 'lucide-react'

// PATCH (not upstream): server↔client mod sync (its own block, split out from the Mod
// profiles card). For a mod present on BOTH sides — matched by shared Nexus modId / Steam
// itemId, else normalized name — it flags when the server enabled state disagrees with the
// client loadout `keep`, and reconciles either way. Server-only stages (a PalSchema/
// server-side mod that happens to be staged on the client, i.e. not client-installable) are
// excluded upstream in computeDrift, so this never offers to disable a legit server mod.

type DriftEntry = {
  serverId: string
  serverName: string
  serverEnabled: boolean
  clientId: string
  clientName: string
  clientKeep: boolean
  matchBy: 'nexus' | 'steam' | 'name'
}

export function ModSyncCard({ reloadKey, onChanged }: { reloadKey?: number; onChanged?: () => void } = {}) {
  const { config } = useServer()
  const [drift, setDrift] = useState<DriftEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!config) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/mod-profiles', { headers: buildPalworldProxyHeaders(config), cache: 'no-store' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error || 'Failed to check sync')
      setDrift(Array.isArray(data.drift) ? data.drift : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to check sync')
    } finally {
      setLoading(false)
    }
  }, [config])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const resolveDrift = useCallback(
    async (d: DriftEntry, authoritative: 'server' | 'client') => {
      setBusy(`${d.serverId}|${d.clientId}`)
      try {
        if (!config) throw new Error('Not connected')
        const res = await fetch('/api/mod-profiles', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'matchDrift', serverId: d.serverId, clientId: d.clientId, authoritative }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error || 'Request failed')
        toast.success(
          authoritative === 'server'
            ? `Client loadout now matches the server for ${d.clientName}.`
            : `Server now matches the client loadout for ${d.serverName}.`,
        )
        await load()
        onChanged?.()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Failed to match sides')
      } finally {
        setBusy(null)
      }
    },
    [config, load, onChanged],
  )

  const matchAll = useCallback(
    async (authoritative: 'server' | 'client') => {
      setBusy('all')
      let ok = 0
      let fail = 0
      // Sequential — each write touches the shared mod state; serial avoids races.
      for (const d of drift) {
        try {
          if (!config) throw new Error('Not connected')
          const res = await fetch('/api/mod-profiles', {
            method: 'POST',
            headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'matchDrift', serverId: d.serverId, clientId: d.clientId, authoritative }),
          })
          if (res.ok) ok++
          else fail++
        } catch {
          fail++
        }
      }
      toast.success(`Matched ${ok} mod(s) to the ${authoritative}${fail ? `, ${fail} failed` : ''}.`)
      await load()
      onChanged?.()
      setBusy(null)
    },
    [config, drift, load, onChanged],
  )

  if (!config) return null

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <RefreshCwIcon className="size-4 text-primary" />
        <h3 className="text-sm font-semibold">Mod sync (server ↔ client)</h3>
        {loading ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
        {drift.length > 0 ? (
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!!busy}
              onClick={() => matchAll('client')}
              title="Make the server match the client loadout for every out-of-sync mod"
            >
              <ArrowLeftIcon className="mr-1 size-3" /> All to client
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-xs"
              disabled={!!busy}
              onClick={() => matchAll('server')}
              title="Make the client loadout match the server for every out-of-sync mod"
            >
              All to server <ArrowRightIcon className="ml-1 size-3" />
            </Button>
          </div>
        ) : null}
      </div>

      <div className="p-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {drift.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckIcon className="size-3.5 text-emerald-500" />
            Server and client mods are in sync.
          </p>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
              <TriangleAlertIcon className="size-4" />
              {drift.length} mod{drift.length > 1 ? 's' : ''} out of sync
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              These mods exist on both sides but the server and the client loadout disagree. Match either side (server
              changes take effect next restart; client on the next bundle).
            </p>
            <div className="space-y-1.5">
              {drift.map((d) => {
                const rowBusy = busy === `${d.serverId}|${d.clientId}` || busy === 'all'
                return (
                  <div
                    key={`${d.serverId}|${d.clientId}`}
                    className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-2 py-1.5"
                  >
                    <span className="text-sm font-medium">{d.serverName}</span>
                    <span className="text-xs text-muted-foreground">
                      server{' '}
                      <b className={d.serverEnabled ? 'text-emerald-500' : 'text-muted-foreground'}>
                        {d.serverEnabled ? 'on' : 'off'}
                      </b>
                      {' · '}client{' '}
                      <b className={d.clientKeep ? 'text-emerald-500' : 'text-muted-foreground'}>
                        {d.clientKeep ? 'kept' : 'off'}
                      </b>
                      {d.matchBy === 'name' ? ' · matched by name' : ''}
                    </span>
                    <div className="ml-auto flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={rowBusy}
                        onClick={() => resolveDrift(d, 'client')}
                        title="Make the server match the client loadout"
                      >
                        <ArrowLeftIcon className="mr-1 size-3" /> Match to client
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        disabled={rowBusy}
                        onClick={() => resolveDrift(d, 'server')}
                        title="Make the client loadout match the server"
                      >
                        Match to server <ArrowRightIcon className="ml-1 size-3" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
