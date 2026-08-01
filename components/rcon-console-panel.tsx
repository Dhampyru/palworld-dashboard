'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useServer } from '@/lib/server-context'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { DEMO_MODE } from '@/lib/demo-mode'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
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
import { TerminalIcon, SendIcon, ShieldAlertIcon } from 'lucide-react'
import { RconCommandBrowser } from '@/components/rcon-command-browser'
import { RconCommandForm } from '@/components/rcon-command-form'
import {
  type ParamValues,
  type RconCommand,
  availableCommands,
  compareWithLiveRegistry,
  findCommand,
  parseRconCmds,
} from '@/lib/rcon-commands'
import { type DatasetEntry, parseIdListResponse } from '@/lib/rcon-datasets'

// PATCH (not upstream): the RCON console upgrade (docs/specs/rcon-console.md).
// Replaces the raw single-input console with a searchable command registry and
// generated parameter forms. The raw input is kept as an escape hatch -- the
// registry cannot cover a command a future PalDefender adds, and locking an
// admin out of typing one would be a regression.

// Defaults from the registry, so a form opens pre-filled rather than empty.
function initialValues(command: RconCommand): ParamValues {
  const values: ParamValues = {}
  for (const param of command.params) {
    if (param.default !== undefined) values[param.key] = String(param.default)
  }
  return values
}

// PalDefender refusals and gates are plain strings in the response body, not
// error statuses, so they arrive looking like success. Surfacing them
// distinctly is what keeps criterion 7 from degrading to a generic error (§7).
const GATE_MESSAGES = [
  'Admin-cheats are disabled!',
  'This command is available only via RCON.',
  'Chat only command.',
  'Insufficient permission to execute the command.',
]

function isGateRefusal(response: string): boolean {
  return GATE_MESSAGES.some((message) => response.includes(message))
}

type Capabilities = {
  palDefender: boolean
  allowAdminCheats: boolean | null
  drift: { missing: string[]; unknown: string[] } | null
  // Technology IDs straight from the operator's own server (§9 / data/README.md).
  techIds: DatasetEntry[]
}

export function RconConsolePanel() {
  const { config, consoleLogs, addLog, players, consoleRequest, clearConsoleRequest } = useServer()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<RconCommand | null>(null)
  const [values, setValues] = useState<ParamValues>({})
  const [rawCommand, setRawCommand] = useState('')
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null)

  const rconLogs = useMemo(() => consoleLogs.filter((log) => log.endpoint === 'rcon'), [consoleLogs])

  // One capability probe per session (§8). Detection failure hides the
  // PalDefender half rather than showing commands that cannot work.
  useEffect(() => {
    if (!config) return
    let cancelled = false
    ;(async () => {
      try {
        const response = await fetch('/api/rcon', { headers: buildPalworldProxyHeaders(config) })
        if (!response.ok) throw new Error('probe failed')
        const data = (await response.json()) as {
          palDefender?: boolean
          registry?: string
          allowAdminCheats?: boolean | null
          techIds?: string
        }
        if (cancelled) return
        const live = data.registry ? parseRconCmds(data.registry) : null
        setCapabilities({
          palDefender: Boolean(data.palDefender),
          allowAdminCheats: data.allowAdminCheats ?? null,
          drift: live && live.size > 0 ? compareWithLiveRegistry(live) : null,
          techIds: parseIdListResponse(data.techIds ?? ''),
        })
      } catch {
        if (!cancelled)
          setCapabilities({ palDefender: false, allowAdminCheats: null, drift: null, techIds: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [config])

  const palDefender = capabilities?.palDefender ?? false
  // Unknown (null) means "assume enabled": a failed Config.json read must not
  // make every cheat command look broken.
  const adminCheatsEnabled = capabilities?.allowAdminCheats !== false
  const commands = useMemo(() => availableCommands(palDefender), [palDefender])

  // Drop a selection that is no longer available (probe RESOLVED to no
  // PalDefender). Guard on capabilities !== null: while the probe is still in
  // flight, `commands` is vanilla-only, and dropping here would wipe a command
  // a roster quick-action just prefilled (givepal etc.) before the probe
  // confirms it's available -- the blank-console bug (2026-07-22).
  useEffect(() => {
    if (!capabilities) return
    if (selected && !commands.some((command) => command.name === selected.name)) {
      setSelected(null)
    }
  }, [capabilities, commands, selected])

  const selectCommand = useCallback((command: RconCommand) => {
    setSelected(command)
    setValues(initialValues(command))
  }, [])

  // Consume a roster quick-action (item B): select the named command and
  // prefill its first player-kind param with the requested UserId, then clear
  // the request so re-visiting the tab doesn't re-trigger it. Nothing is sent --
  // the operator still reviews and presses Run.
  useEffect(() => {
    if (!consoleRequest) return
    const command = findCommand(consoleRequest.command)
    if (command) {
      const values = initialValues(command)
      // Prefer a player-kind param; fall back to the first text param so `tp`
      // (which models its target as a freeform arg) still gets the UserId.
      const target =
        command.params.find((param) => param.kind === 'player') ??
        command.params.find((param) => param.kind === 'text')
      if (target) values[target.key] = consoleRequest.userId
      setSelected(command)
      setValues(values)
    }
    clearConsoleRequest()
  }, [consoleRequest, clearConsoleRequest])

  const runCommand = useCallback(
    async (commandString: string) => {
      if (!config || !commandString.trim()) return
      setSending(true)
      try {
        const response = await fetch('/api/rcon', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: commandString }),
        })
        const data = await response.json()
        const body: string = response.ok ? data.response : data.error
        addLog({
          // A 200 carrying "Admin-cheats are disabled!" is a refusal, not a
          // success -- log it as an error so it reads as one.
          type: response.ok && !isGateRefusal(String(body ?? '')) ? 'success' : 'error',
          message: `RCON: ${commandString}`,
          endpoint: 'rcon',
          rawResponse: body,
        })
      } catch (err) {
        addLog({
          type: 'error',
          message: `RCON: ${commandString}`,
          endpoint: 'rcon',
          rawResponse: err instanceof Error ? err.message : 'Request failed',
        })
      } finally {
        setSending(false)
      }
    },
    [config, addLog],
  )

  // Dangerous commands confirm first, whether they came from a form or the raw
  // input -- the registry decides, so a typed `BanPlayer` is treated the same.
  const submit = useCallback(
    (commandString: string) => {
      const trimmed = commandString.trim()
      if (!trimmed) return
      const name = trimmed.replace(/^\//, '').split(/\s+/)[0] ?? ''
      if (findCommand(name)?.dangerous) {
        setPendingConfirm(trimmed)
        return
      }
      runCommand(trimmed)
    },
    [runCommand],
  )

  const headerLine = !capabilities
    ? 'Detecting PalDefender…'
    : palDefender
      ? `${commands.length} commands available · PalDefender commands enabled`
      : `${commands.length} commands available · PalDefender not detected — vanilla commands only`

  return (
    <div className="flex h-full min-h-[30rem] flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <TerminalIcon className="size-5" />
        <h2 className="text-lg font-semibold">RCON Console</h2>
        {palDefender && capabilities?.allowAdminCheats === false && (
          <Badge variant="outline" className="text-[10px] text-amber-600">
            admin cheats off
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{headerLine}</p>

      {capabilities?.drift && capabilities.drift.missing.length > 0 && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          This PalDefender build does not expose {capabilities.drift.missing.length} command(s) this
          console knows about ({capabilities.drift.missing.join(', ')}). They will fail if run.
        </p>
      )}

      {/* Single column on mobile, list + form side by side from md up (§3). */}
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <RconCommandBrowser
          commands={commands}
          selected={selected}
          onSelect={selectCommand}
          query={query}
          onQueryChange={setQuery}
          adminCheatsEnabled={adminCheatsEnabled}
        />

        <div className="flex min-h-0 flex-col gap-3">
          {selected ? (
            <RconCommandForm
              command={selected}
              values={values}
              onChange={(key, value) => setValues((previous) => ({ ...previous, [key]: value }))}
              players={players}
              adminCheatsEnabled={adminCheatsEnabled}
              onSubmit={submit}
              running={sending}
              demoMode={DEMO_MODE}
              techIds={capabilities?.techIds ?? []}
            />
          ) : (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
              Pick a command to build it, or type one below.
            </p>
          )}

          {/* Escape hatch: the registry cannot cover what a future PalDefender
              adds, so raw entry stays available. */}
          <div className="flex gap-2">
            <Input
              value={rawCommand}
              onChange={(event) => setRawCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && rawCommand.trim()) {
                  submit(rawCommand)
                  setRawCommand('')
                }
              }}
              placeholder="Or type a raw command…"
              className="font-mono text-sm"
              aria-label="Raw RCON command"
            />
            <Button
              onClick={() => {
                submit(rawCommand)
                setRawCommand('')
              }}
              disabled={sending || !rawCommand.trim()}
            >
              {sending ? <Spinner className="size-4" /> : <SendIcon className="size-4" />}
            </Button>
          </div>

          <div className="min-h-0 flex-1 rounded-md border bg-muted/10">
            <ScrollArea className="h-full max-h-[18rem]">
              <div className="flex flex-col gap-2 p-3 font-mono text-xs">
                {rconLogs.length === 0 && (
                  <div className="text-muted-foreground">No commands sent yet this session.</div>
                )}
                {rconLogs.map((log) => (
                  <div key={log.id} className="flex flex-col gap-0.5">
                    <div className={log.type === 'error' ? 'text-destructive' : 'text-primary'}>
                      <span className="mr-1.5 text-muted-foreground">
                        {new Date(log.timestamp).toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                      &gt; {log.message.replace(/^RCON: /, '')}
                    </div>
                    {log.rawResponse && (
                      // Long responses (whitelist_get, gettechids) must scroll
                      // rather than blow up the layout (§7).
                      <div className="max-h-64 overflow-auto whitespace-pre-wrap pl-3 text-foreground/80">
                        {log.rawResponse}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          </div>
        </div>
      </div>

      <AlertDialog open={pendingConfirm !== null} onOpenChange={(open) => !open && setPendingConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlertIcon className="size-5 text-amber-500" />
              Confirm this command
            </AlertDialogTitle>
            <AlertDialogDescription>
              <code className="rounded bg-muted px-1.5 py-0.5">{pendingConfirm}</code> can stop the
              server, remove a player, or otherwise can&apos;t be undone. Run it anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingConfirm(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingConfirm) runCommand(pendingConfirm)
                setPendingConfirm(null)
                setRawCommand('')
              }}
            >
              Run Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
