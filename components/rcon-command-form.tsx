'use client'

// PATCH (not upstream): parameter form + live preview for the RCON console
// upgrade (docs/specs/rcon-console.md §6). Renders whatever the registry
// describes -- there is deliberately no per-command component.
//
// The preview and the payload both come from buildCommandString(). Never
// compute them separately: the preview is a safety mechanism, and it only
// works if it is the same string that gets sent.

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { SendIcon, TriangleAlertIcon, InfoIcon } from 'lucide-react'
import type { Player } from '@/lib/types'
import {
  type ParamValues,
  type RconCommand,
  type RconParam,
  buildCommandString,
  isRunnable,
  missingRequiredParams,
} from '@/lib/rcon-commands'
import { type DatasetEntry, type RuntimeDatasets, fetchDatasets } from '@/lib/rcon-datasets'
import { DatasetCombobox } from '@/components/dataset-combobox'

type Props = {
  command: RconCommand
  values: ParamValues
  onChange: (key: string, value: string) => void
  players: Player[]
  adminCheatsEnabled: boolean
  onSubmit: (commandString: string) => void
  running: boolean
  demoMode?: boolean
  // Enumerated live from the server's own gettechids -- see lib/rcon-datasets.ts.
  techIds?: DatasetEntry[]
}

// data/*.json for items/pals/eggs (empty until verified — data/README.md), and
// the live list for technologies.
function datasetForParam(
  param: RconParam,
  techIds: DatasetEntry[],
  datasets: RuntimeDatasets,
): DatasetEntry[] {
  switch (param.kind) {
    case 'itemId':
      return datasets.items
    case 'palId':
      return datasets.pals
    case 'eggId':
      return datasets.eggs
    case 'techId':
      return techIds
    default:
      return []
  }
}

// Coordinates ride in one registry param but render as three inputs; the value
// is stored space-separated so the builder can emit `X Y Z` without special-casing.
function coordParts(value: string): [string, string, string] {
  const parts = value.trim().split(/\s+/)
  return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? '']
}

function joinCoords(parts: [string, string, string]): string {
  // Trailing blanks are dropped so a Z-less "X Y" stays valid, but an interior
  // blank would silently shift Y into X's place -- keep those as-is and let
  // required-param validation catch it.
  const trimmed = [...parts]
  while (trimmed.length && !trimmed[trimmed.length - 1]?.trim()) trimmed.pop()
  return trimmed.join(' ').trim()
}

function ParamField({
  param,
  value,
  onChange,
  players,
  dataset,
}: {
  param: RconParam
  value: string
  onChange: (value: string) => void
  players: Player[]
  // Empty is a normal state: the picker falls back to free-text ID entry.
  dataset: DatasetEntry[]
}) {
  const label = (
    <Label htmlFor={`rcon-param-${param.key}`} className="text-xs">
      {param.label}
      {param.optional && <span className="ml-1 font-normal text-muted-foreground">(optional)</span>}
    </Label>
  )

  const help = param.help && <p className="text-[11px] text-muted-foreground">{param.help}</p>

  switch (param.kind) {
    case 'player': {
      // Combobox: online players by name, free text for offline UserIds. A
      // datalist keeps both without pulling in a new dependency.
      const listId = `rcon-players-${param.key}`
      return (
        <div className="flex flex-col gap-1">
          {label}
          <Input
            id={`rcon-param-${param.key}`}
            list={listId}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={param.placeholder ?? 'Name or UserId'}
            className="font-mono text-sm"
          />
          <datalist id={listId}>
            {players.map((player) => (
              <option key={player.userId || player.playerId} value={player.userId}>
                {player.name}
              </option>
            ))}
          </datalist>
          {players.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              Nobody online — enter a UserId directly.
            </p>
          )}
          {help}
        </div>
      )
    }

    case 'number':
      return (
        <div className="flex flex-col gap-1">
          {label}
          <Input
            id={`rcon-param-${param.key}`}
            type="number"
            inputMode="numeric"
            min={param.min}
            max={param.max}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={param.default !== undefined ? String(param.default) : param.placeholder}
            className="font-mono text-sm"
          />
          {(param.min !== undefined || param.max !== undefined) && (
            <p className="text-[11px] text-muted-foreground">
              Range {param.min ?? '—'} to {param.max ?? '—'}.
            </p>
          )}
          {help}
        </div>
      )

    case 'select':
      return (
        <div className="flex flex-col gap-1">
          {label}
          <select
            id={`rcon-param-${param.key}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 py-1 font-mono text-sm text-foreground shadow-xs [&>option]:bg-background [&>option]:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <option value="">Select…</option>
            {(param.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {help}
        </div>
      )

    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
          <div className="flex flex-col gap-0.5">
            {label}
            {help}
          </div>
          <Switch
            id={`rcon-param-${param.key}`}
            checked={value === 'true'}
            onCheckedChange={(checked) => onChange(checked ? 'true' : '')}
          />
        </div>
      )

    case 'coords': {
      const parts = coordParts(value)
      return (
        <div className="flex flex-col gap-1">
          {label}
          <div className="grid grid-cols-3 gap-2">
            {(['X', 'Y', 'Z'] as const).map((axis, index) => (
              <Input
                key={axis}
                type="number"
                inputMode="numeric"
                aria-label={`${param.label} ${axis}`}
                value={parts[index]}
                onChange={(event) => {
                  const next = [...parts] as [string, string, string]
                  next[index] = event.target.value
                  onChange(joinCoords(next))
                }}
                placeholder={axis}
                className="font-mono text-sm"
              />
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            X and Y are required over RCON; Z is optional.
          </p>
          {help}
        </div>
      )
    }

    case 'itemId':
    case 'palId':
    case 'eggId':
    case 'techId':
    case 'palTemplate':
    default: {
      // Typeahead when a dataset is available, free text when it is not. The
      // item/pal/egg datasets ship empty (data/README.md: unguessable IDs must
      // be verified, and the provenance question is unresolved), so those stay
      // free text until filled -- which is a data change, not a code change.
      // Technology IDs ARE populated, live from the server's own gettechids.
      const hint =
        param.kind === 'itemId'
          ? 'Internal item ID, e.g. PalSphere.'
          : param.kind === 'palId'
            ? 'Internal Pal ID. Prefix BOSS_ for the Alpha variant.'
            : param.kind === 'eggId'
              ? 'Internal egg ID.'
              : param.kind === 'techId'
                ? 'Technology ID, or "all".'
                : param.kind === 'palTemplate'
                  ? 'Template filename under PalDefender/Pals/Templates.'
                  : undefined
      const isPal = param.kind === 'palId'
      const boss = value.startsWith('BOSS_')
      return (
        <div className="flex flex-col gap-1">
          {label}
          {dataset.length > 0 ? (
            // Image-capable combobox (icon + name + id). Free text still passes
            // through, so any id works whether listed or not.
            <DatasetCombobox
              id={`rcon-param-${param.key}`}
              value={value}
              onChange={onChange}
              dataset={dataset}
              placeholder={param.placeholder}
            />
          ) : (
            <Input
              id={`rcon-param-${param.key}`}
              value={value}
              onChange={(event) => onChange(event.target.value)}
              placeholder={param.placeholder}
              className="font-mono text-sm"
            />
          )}
          {dataset.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {dataset.length.toLocaleString()} available — type a name or ID to search, or enter any ID.
            </p>
          )}
          {isPal && value.trim() !== '' && (
            <label className="flex w-fit items-center gap-2 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={boss}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? `BOSS_${value.replace(/^BOSS_/, '')}`
                      : value.replace(/^BOSS_/, ''),
                  )
                }
              />
              BOSS (Alpha) variant
            </label>
          )}
          {help ?? (hint && <p className="text-[11px] text-muted-foreground">{hint}</p>)}
        </div>
      )
    }
  }
}

export function RconCommandForm({
  command,
  values,
  onChange,
  players,
  adminCheatsEnabled,
  onSubmit,
  running,
  demoMode,
  techIds = [],
}: Props) {
  const preview = useMemo(() => buildCommandString(command, values), [command, values])
  const missing = useMemo(() => missingRequiredParams(command, values), [command, values])
  // Item/Pal/egg datasets load once at runtime (empty until then → free-text).
  const [datasets, setDatasets] = useState<RuntimeDatasets>({ items: [], pals: [], eggs: [] })
  useEffect(() => {
    let alive = true
    fetchDatasets().then((d) => {
      if (alive) setDatasets(d)
    })
    return () => {
      alive = false
    }
  }, [])
  const runnable = isRunnable(command, values)
  const gated = Boolean(command.adminCheat) && !adminCheatsEnabled

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-base font-semibold">{command.name}</code>
          {command.dangerous && (
            <Badge variant="destructive" className="text-[10px]">
              dangerous
            </Badge>
          )}
          {command.source === 'paldefender' && (
            <Badge variant="secondary" className="text-[10px]">
              PalDefender
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{command.description}</p>
      </div>

      {command.note && (
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{command.note}</span>
        </p>
      )}

      {gated && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            PalDefender&apos;s <code>allowAdminCheats</code> is off, so this command will be refused
            with <em>Admin-cheats are disabled!</em> Enable it in PalDefender&apos;s Config.json and
            run <code>reloadcfg</code> — no restart needed.
          </span>
        </p>
      )}

      {command.params.length > 0 && (
        <div className="flex flex-col gap-3">
          {command.params.map((param) => (
            <ParamField
              key={param.key}
              param={param}
              value={values[param.key] ?? ''}
              onChange={(value) => onChange(param.key, value)}
              players={players}
              dataset={datasetForParam(param, techIds, datasets)}
            />
          ))}
        </div>
      )}

      {/* Preview and payload are the same string, from the same builder. */}
      <div className="flex flex-col gap-1">
        <Label className="text-xs">Will send</Label>
        <code className="block overflow-x-auto whitespace-pre rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
          {preview}
        </code>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => onSubmit(preview)} disabled={!runnable || running} className="gap-2">
          {running ? <Spinner className="size-4" /> : <SendIcon className="size-4" />}
          {demoMode ? 'Run (demo)' : 'Run'}
        </Button>
        {!runnable && (
          <span className="text-xs text-muted-foreground">
            Needs {missing.map((param) => param.label).join(', ')}.
          </span>
        )}
      </div>
    </div>
  )
}
