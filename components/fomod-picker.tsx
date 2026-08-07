'use client'

import { useCallback, useEffect, useState } from 'react'
import { buildPalworldProxyHeaders } from '@/lib/palworld'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { PackageIcon } from 'lucide-react'

// PATCH (not upstream): FOMOD variant picker UI (docs/specs/client-mod-sync.md §2c). Opened
// when a Nexus install is detected as a FOMOD; fetches the parsed options, lets the admin
// pick a variant per group, and installs the chosen file(s) to their declared destinations.
type Plugin = { name: string; description: string; recommended: boolean }
type Group = { name: string; type: string; plugins: Plugin[] }
type Config = Parameters<typeof buildPalworldProxyHeaders>[0]

const isRadio = (t: string) => t === 'SelectExactlyOne' || t === 'SelectAtMostOne'

export function FomodPicker({
  url,
  config,
  onClose,
  onInstalled,
}: {
  url: string
  config: Config
  onClose: () => void
  onInstalled: (note: string) => void
}) {
  const [loading, setLoading] = useState(true)
  const [moduleName, setModuleName] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  const [sel, setSel] = useState<Record<number, number[]>>({})
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const res = await fetch('/api/nexus/install', {
          method: 'POST',
          headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'fomodOptions', url }),
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? res.statusText)
        if (cancelled) return
        setModuleName(json.moduleName ?? 'FOMOD installer')
        const gs: Group[] = json.groups ?? []
        setGroups(gs)
        // Default selection: recommended plugins; a SelectExactlyOne with none recommended → first.
        const init: Record<number, number[]> = {}
        gs.forEach((g, gi) => {
          const rec = g.plugins.map((p, i) => (p.recommended ? i : -1)).filter((i) => i >= 0)
          if (g.type === 'SelectExactlyOne') init[gi] = rec.length ? [rec[0]] : g.plugins.length ? [0] : []
          else if (g.type === 'SelectAll') init[gi] = g.plugins.map((_, i) => i)
          else init[gi] = rec
        })
        setSel(init)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not read FOMOD options')
        onClose()
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url, config, onClose])

  const toggle = (gi: number, pi: number, t: string) => {
    setSel((prev) => {
      const cur = prev[gi] ?? []
      if (isRadio(t)) return { ...prev, [gi]: cur[0] === pi && t === 'SelectAtMostOne' ? [] : [pi] }
      return { ...prev, [gi]: cur.includes(pi) ? cur.filter((x) => x !== pi) : [...cur, pi] }
    })
  }

  const install = useCallback(async () => {
    setInstalling(true)
    try {
      const res = await fetch('/api/nexus/install', {
        method: 'POST',
        headers: { ...buildPalworldProxyHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fomodInstall', url, selections: sel }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? res.statusText)
      onInstalled(json.note ?? 'Installed')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Install failed')
    } finally {
      setInstalling(false)
    }
  }, [url, config, sel, onInstalled])

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-3 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <PackageIcon className="size-4 text-primary" />
            {moduleName || 'FOMOD installer'}
          </SheetTitle>
        </SheetHeader>
        <p className="text-xs text-muted-foreground">
          This mod is a FOMOD with variant options. Pick what you want — it installs to the mod&apos;s own destination.
          Restart the server to load it.
        </p>
        {loading ? (
          <p className="text-sm text-muted-foreground">Reading options…</p>
        ) : (
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
            {groups.map((g, gi) => (
              <div key={gi} className="flex flex-col gap-1.5">
                <div className="text-sm font-medium">
                  {g.name} <span className="text-xs font-normal text-muted-foreground">({g.type.replace('Select', '')})</span>
                </div>
                {g.plugins.map((p, pi) => {
                  const checked = (sel[gi] ?? []).includes(pi)
                  return (
                    <label key={pi} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm hover:bg-muted/40">
                      <input
                        type={isRadio(g.type) ? 'radio' : 'checkbox'}
                        name={`fomod-g${gi}`}
                        checked={checked}
                        onChange={() => toggle(gi, pi, g.type)}
                        disabled={g.type === 'SelectAll'}
                        className="mt-0.5 size-4 accent-primary"
                      />
                      <div className="min-w-0">
                        <div className="font-medium">
                          {p.name}
                          {p.recommended && <span className="ml-1.5 text-xs text-emerald-600 dark:text-emerald-400">recommended</span>}
                        </div>
                        {p.description && <div className="text-xs text-muted-foreground">{p.description}</div>}
                      </div>
                    </label>
                  )
                })}
              </div>
            ))}
            {!groups.length && <p className="text-sm text-muted-foreground">No selectable options found in this FOMOD.</p>}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-9 gap-1.5 text-xs" onClick={install} disabled={loading || installing}>
            {installing ? <Spinner className="size-3.5" /> : null}
            Install selected
          </Button>
          <button onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
