'use client'

// PATCH (not upstream): collapsible "Give Item & Pal Kits" category wrapping the item-kit
// and Pal-team cards (docs/specs/give-kits.md), so they tuck away in the PalDefender tab.
// Mirrors the world-settings collapsible-category pattern (manual collapsed state + chevron).

import { useState } from 'react'
import { ChevronRightIcon, GiftIcon } from 'lucide-react'
import { GiveKitsCard } from '@/components/give-kits-card'
import { PalKitsCard } from '@/components/pal-kits-card'

export function KitsSection() {
  const [collapsed, setCollapsed] = useState(true)
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center justify-between bg-muted/20 px-3 py-2 text-sm font-semibold hover:bg-muted/30"
        aria-expanded={!collapsed}
      >
        <span className="flex items-center gap-2">
          <ChevronRightIcon className={`size-4 transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          <GiftIcon className="size-4" />
          Give Item &amp; Pal Kits
        </span>
        <span className="text-xs font-normal text-muted-foreground">give items or a Pal team to a player</span>
      </button>
      {!collapsed && (
        <div className="flex flex-col gap-4 border-t p-3">
          <GiveKitsCard />
          <PalKitsCard />
        </div>
      )}
    </div>
  )
}
