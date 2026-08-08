import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import { isSafeConfigName, listClientConfigs, removeClientConfig, saveClientConfig } from '@/lib/client-configs'

// PATCH (not upstream): CRUD for CLIENT mod runtime configs (docs/specs/client-mod-sync.md).
// Admin-only. The friend-facing loadout overlays these; nothing here touches the game server.

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

function requireAdmin(request: NextRequest): NextResponse | null {
  const ip = clientIp(request)
  if (isLockedOut(ip)) return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: client mod configs are admin-only' }, { status: 403 })
  }
  return null
}

export async function GET(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const denied = requireAdmin(request)
    if (denied) return denied
    return NextResponse.json({ configs: await listClientConfigs() })
  })
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const denied = requireAdmin(request)
    if (denied) return denied
    if (DEMO_MODE) return NextResponse.json({ dryRun: true })

    let body: { action?: string; name?: string; json?: unknown; content?: string }
    try {
      body = (await request.json()) as typeof body
    } catch {
      return NextResponse.json({ error: 'Malformed request body' }, { status: 400 })
    }
    const name = String(body.name ?? '').trim()
    if (!isSafeConfigName(name)) {
      return NextResponse.json({ error: 'Invalid filename — use a plain *.json name (e.g. YetAnotherMinimap.modconfig.json).' }, { status: 400 })
    }
    try {
      // 'upload' carries raw text (validate it parses); 'save' carries an already-parsed object.
      let json: unknown
      if (body.action === 'upload') {
        try {
          json = JSON.parse(String(body.content ?? ''))
        } catch {
          return NextResponse.json({ error: 'That file is not valid JSON.' }, { status: 400 })
        }
      } else {
        json = body.json
        if (json === undefined) return NextResponse.json({ error: 'Missing config data' }, { status: 400 })
      }
      await saveClientConfig(name, json)
      return NextResponse.json({ saved: name })
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save config' }, { status: 500 })
    }
  })
}

export async function DELETE(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), async () => {
    const denied = requireAdmin(request)
    if (denied) return denied
    const name = request.nextUrl.searchParams.get('name') ?? ''
    if (!isSafeConfigName(name)) return NextResponse.json({ error: 'Invalid filename' }, { status: 400 })
    await removeClientConfig(name)
    return NextResponse.json({ removed: name })
  })
}
