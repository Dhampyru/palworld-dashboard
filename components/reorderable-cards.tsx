'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { GripVerticalIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

// PATCH (not upstream): drag-to-reorder for the Overview cards (2026-08-10). Native HTML5 DnD
// (no new dependency); a real grip handle replaces the old decorative 9-dot flourish (which
// looked like a handle but was pointer-events-none). Order persists to localStorage, namespaced
// per instance. Desktop-only by design — the handle is hidden below `sm` (mobile is a single
// column, and HTML5 DnD doesn't fire on touch anyway).
export type OverviewCard = { id: string; node: ReactNode }

function reconcile(saved: string[], defaults: string[]): string[] {
  // Keep saved order for still-present cards, append any new ones, drop unknown ids.
  const known = saved.filter((id) => defaults.includes(id))
  const missing = defaults.filter((id) => !known.includes(id))
  return [...known, ...missing]
}

function loadOrder(key: string, defaults: string[]): string[] {
  if (typeof window === 'undefined') return defaults
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return defaults
    const saved = JSON.parse(raw) as unknown
    if (!Array.isArray(saved)) return defaults
    return reconcile(saved.filter((x): x is string => typeof x === 'string'), defaults)
  } catch {
    return defaults
  }
}

export function ReorderableCards({
  cards,
  storageKey,
  className,
}: {
  cards: OverviewCard[]
  storageKey: string
  className?: string
}) {
  const defaults = cards.map((c) => c.id)
  const defaultsKey = defaults.join('|')
  const [order, setOrder] = useState<string[]>(() => loadOrder(storageKey, defaults))
  const [armedId, setArmedId] = useState<string | null>(null) // card whose handle is pressed → draggable
  const [overId, setOverId] = useState<string | null>(null) // current drop target (for the ring)
  const draggingId = useRef<string | null>(null)

  // Re-hydrate when the storage key (active instance) changes, and reconcile the card set.
  useEffect(() => {
    setOrder(loadOrder(storageKey, defaultsKey.split('|')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, defaultsKey])

  // Safety net: a handle press that never becomes a drag (click, or release off-target) must
  // still disarm, or the card would stay draggable and swallow clicks.
  useEffect(() => {
    const clear = () => setArmedId(null)
    window.addEventListener('pointerup', clear)
    window.addEventListener('pointercancel', clear)
    return () => {
      window.removeEventListener('pointerup', clear)
      window.removeEventListener('pointercancel', clear)
    }
  }, [])

  const persist = useCallback(
    (next: string[]) => {
      setOrder(next)
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {
        /* private mode / quota — order still applies for this session */
      }
    },
    [storageKey],
  )

  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return
    setOrder((cur) => {
      const from = cur.indexOf(fromId)
      const to = cur.indexOf(toId)
      if (from < 0 || to < 0) return cur
      const next = cur.slice()
      next.splice(from, 1)
      next.splice(to, 0, fromId)
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  const byId = new Map(cards.map((c) => [c.id, c.node]))

  return (
    // items-start + content-sized rows (no grid-auto-rows:1fr): expanding a collapsible card
    // grows ONLY that card. With equal-height rows, one card expanding stretched every card in
    // the grid (chat/logs included). Cards keep their own min-heights, so feeds stay tall.
    <div className={cn('grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3', className)}>
      {order.map((id) => {
        const node = byId.get(id)
        if (!node) return null
        const isDragging = draggingId.current === id
        const isDropTarget = overId === id && draggingId.current && draggingId.current !== id
        return (
          <div
            key={id}
            className={cn(
              'reorderable-card relative rounded-[0.28rem] transition',
              isDropTarget && 'ring-2 ring-primary/70 ring-offset-2 ring-offset-background',
              isDragging && 'opacity-60',
            )}
            draggable={armedId === id}
            onDragStart={(e) => {
              if (armedId !== id) {
                e.preventDefault()
                return
              }
              draggingId.current = id
              e.dataTransfer.effectAllowed = 'move'
              try {
                e.dataTransfer.setData('text/plain', id)
              } catch {
                /* some browsers require a payload; ignore if it throws */
              }
            }}
            onDragEnd={() => {
              draggingId.current = null
              setArmedId(null)
              setOverId(null)
            }}
            onDragOver={(e) => {
              if (!draggingId.current) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (overId !== id) setOverId(id)
            }}
            onDragLeave={() => {
              if (overId === id) setOverId(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              const from = draggingId.current
              if (from) reorder(from, id)
              draggingId.current = null
              setArmedId(null)
              setOverId(null)
            }}
          >
            {/* Real grip handle — arms the wrapper for dragging only while pressed, so the
                card's own buttons/inputs stay fully interactive otherwise. */}
            <button
              type="button"
              aria-label="Drag to reorder card"
              title="Drag to reorder"
              onPointerDown={() => setArmedId(id)}
              className="absolute right-1.5 top-1.5 z-20 hidden cursor-grab touch-none rounded p-1 text-primary/40 transition-colors hover:bg-muted/60 hover:text-primary/90 active:cursor-grabbing sm:block"
            >
              <GripVerticalIcon className="size-4" />
            </button>
            {node}
          </div>
        )
      })}
    </div>
  )
}
