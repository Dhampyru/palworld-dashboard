import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { scanClientKeybinds } from '@/lib/keybind-scan'
import { applyManualRemap, clearRemap, CONFLICT_REMAP, isRemapApplied, PAYLOAD_EDITS } from '@/lib/keybind-remap'
import { listAllBindSlots, listModBindSlots } from '@/lib/keybind-descriptors'
import { applySingleRemap, autoResolve, planSingleRemap, suggestForCombo } from '@/lib/keybind-autoremap'
import { clearOperatorSheet, getEffectiveKeybindSheet } from '@/lib/keybind-cheatsheet'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const cls = classifyPassword(request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? '')
  if (cls === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(cls) !== 'admin') return NextResponse.json({ error: 'Forbidden: admin-only' }, { status: 403 })
  return null
}

// PATCH (not upstream): keybind conflicts across the kept client mods (see lib/keybind-scan).
// GET returns the conflict scan; POST previews/applies/clears the auto-remap (lib/keybind-remap).
// Admin-only, instance-scoped.
export async function GET(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    try {
      return NextResponse.json(await scanClientKeybinds())
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Scan failed' }, { status: 500 })
    }
  })
}

export async function POST(request: NextRequest) {
  const denied = requireAdmin(request)
  if (denied) return denied
  let body: {
    action?: unknown
    modId?: string
    combo?: string
    toKey?: string
    toMods?: string[]
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
  }
  const mods = Array.isArray(body.toMods) ? body.toMods.filter((m): m is string => typeof m === 'string') : []
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    try {
      // ── Phase 1 manual remap (hand-authored list) ──
      if (body.action === 'remapPlan')
        return NextResponse.json({ remap: CONFLICT_REMAP, payloadEdits: PAYLOAD_EDITS, applied: await isRemapApplied() })
      if (body.action === 'remapApply') return NextResponse.json({ ok: true, ...(await applyManualRemap()) })
      if (body.action === 'remapClear') return NextResponse.json({ ok: true, cleared: await clearRemap() })

      // ── Phase 2 descriptor-driven remap ──
      // Full editable bind table (all kept mods, or one mod).
      if (body.action === 'binds')
        return NextResponse.json({ slots: body.modId ? await listModBindSlots(body.modId) : await listAllBindSlots() })
      // Suggest a free key for a specific conflicting bind.
      if (body.action === 'suggest') {
        if (!body.modId || !body.combo) return NextResponse.json({ error: 'modId and combo required' }, { status: 400 })
        return NextResponse.json({ suggestion: await suggestForCombo(body.combo, body.modId) })
      }
      // Preview / apply a single per-key reassignment.
      if (body.action === 'remapKeyPlan' || body.action === 'remapKeyApply') {
        if (!body.modId || !body.combo || !body.toKey)
          return NextResponse.json({ error: 'modId, combo and toKey required' }, { status: 400 })
        const plan =
          body.action === 'remapKeyApply'
            ? await applySingleRemap(body.modId, body.combo, body.toKey, mods)
            : await planSingleRemap(body.modId, body.combo, body.toKey, mods)
        return NextResponse.json(plan.ok ? { ...plan } : { ok: false, error: plan.reason }, { status: plan.ok ? 200 : 422 })
      }
      // Auto-resolve every real conflict — dry-run (plan) then apply.
      if (body.action === 'autoResolvePlan') return NextResponse.json(await autoResolve(true))
      if (body.action === 'autoResolveApply') return NextResponse.json(await autoResolve(false))

      // ── Phase 4 propagation: the friend cheat-sheet ──
      // Effective sheet (operator override if present, else always-live auto-generated).
      if (body.action === 'cheatsheet') return NextResponse.json(await getEffectiveKeybindSheet())
      // Drop the operator override so the sheet reverts to auto-generation.
      if (body.action === 'clearCheatsheet') return NextResponse.json({ cleared: await clearOperatorSheet() })

      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed' }, { status: 500 })
    }
  })
}
