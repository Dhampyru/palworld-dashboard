'use client'

// PATCH (not upstream): searchable, categorised command list for the RCON
// console upgrade (docs/specs/rcon-console.md §3). Purely presentational --
// it renders whatever the registry hands it and reports selection upwards.

import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SearchIcon } from 'lucide-react'
import {
  type RconCommand,
  groupByCategory,
  searchCommands,
} from '@/lib/rcon-commands'
import { useMemo } from 'react'

type Props = {
  commands: RconCommand[]
  selected: RconCommand | null
  onSelect: (command: RconCommand) => void
  query: string
  onQueryChange: (query: string) => void
  // False when PalDefender's allowAdminCheats is off: cheat-gated commands are
  // still listed, but flagged, so they don't just fail with a generic error (§7).
  adminCheatsEnabled: boolean
}

export function RconCommandBrowser({
  commands,
  selected,
  onSelect,
  query,
  onQueryChange,
  adminCheatsEnabled,
}: Props) {
  // Search spans name, description, category and notes, so "ban" surfaces
  // every ban-related command across categories (acceptance criterion 2).
  const groups = useMemo(() => groupByCategory(searchCommands(commands, query)), [commands, query])
  const matchCount = useMemo(() => groups.reduce((n, [, list]) => n + list.length, 0), [groups])

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search commands…"
          className="pl-8"
          aria-label="Search RCON commands"
        />
      </div>

      <ScrollArea className="min-h-0 flex-1 rounded-md border">
        <div className="flex flex-col gap-3 p-2">
          {matchCount === 0 && (
            <p className="px-1 py-4 text-center text-sm text-muted-foreground">
              No command matches “{query}”.
            </p>
          )}
          {groups.map(([category, list]) => (
            <div key={category} className="flex flex-col gap-1">
              <h3 className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {category}
              </h3>
              {list.map((command) => {
                const gated = command.adminCheat && !adminCheatsEnabled
                const isSelected = selected?.name === command.name
                return (
                  <button
                    key={command.name}
                    type="button"
                    onClick={() => onSelect(command)}
                    aria-current={isSelected}
                    className={[
                      'flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                      isSelected ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-muted/60',
                    ].join(' ')}
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <code className="font-mono text-sm">{command.name}</code>
                      {command.dangerous && (
                        <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                          dangerous
                        </Badge>
                      )}
                      {gated && (
                        <Badge variant="outline" className="px-1 py-0 text-[10px] text-amber-600">
                          cheats off
                        </Badge>
                      )}
                      {command.source === 'paldefender' && (
                        <Badge variant="secondary" className="px-1 py-0 text-[10px]">
                          PalDefender
                        </Badge>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">{command.description}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
