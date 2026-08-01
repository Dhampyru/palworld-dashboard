'use client'

// PATCH (not upstream): image-capable typeahead for the RCON console's
// item/pal/egg pickers. The native <datalist> the pickers used can't render
// icons, so this is a small controlled combobox: an input plus a floating
// results list showing icon + name + id. Free-typed text always passes through
// as the value (any id works, listed or not).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { type DatasetEntry, searchDataset } from '@/lib/rcon-datasets'

type Props = {
  value: string
  onChange: (value: string) => void
  dataset: DatasetEntry[]
  placeholder?: string
  disabled?: boolean
  id?: string
}

export function DatasetCombobox({ value, onChange, dataset, placeholder, disabled, id }: Props) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // searchDataset returns all name-sorted matches; cap what we actually render
  // (a dataset can be thousands of items) and tell the user when more exist.
  const DISPLAY_LIMIT = 100
  const matches = useMemo(() => (dataset.length ? searchDataset(dataset, value) : []), [dataset, value])
  const results = useMemo(() => matches.slice(0, DISPLAY_LIMIT), [matches])
  const overflow = matches.length - results.length

  // Close when clicking outside.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const choose = useCallback(
    (entry: DatasetEntry) => {
      onChange(entry.id)
      setOpen(false)
    },
    [onChange],
  )

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true)
      return
    }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && results[active]) {
      e.preventDefault()
      choose(results[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => dataset.length > 0 && setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className="font-mono text-sm"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover p-1 shadow-lg">
          {results.map((entry, i) => (
            <li key={entry.id}>
              <button
                type="button"
                // mousedown (not click) so it fires before the input blur.
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(entry)
                }}
                onMouseEnter={() => setActive(i)}
                className={[
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left',
                  i === active ? 'bg-primary/10' : 'hover:bg-muted/60',
                ].join(' ')}
              >
                {entry.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={entry.image} alt="" className="size-6 shrink-0 object-contain" loading="lazy" />
                ) : (
                  <span className="size-6 shrink-0 rounded bg-muted/50" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{entry.name ?? entry.id}</span>
                  {entry.name && (
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">{entry.id}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
          {overflow > 0 && (
            <li className="px-2 py-1 text-[10px] text-muted-foreground">
              …{overflow} more — keep typing to narrow.
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
