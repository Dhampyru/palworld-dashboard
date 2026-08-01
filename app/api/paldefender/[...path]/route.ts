import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveInstance, resolveSecrets } from '@/lib/instances'
import type { AccessTier } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): proxy for PalDefender's OWN, separate REST API --
// distinct from the game's native REST API (see app/api/palworld/[...path]).
// Mirrors that route's security model closely: rate limiting, admin/mod tier
// gating via the SAME panel password the rest of the dashboard uses (not
// PalDefender's own token, which stays pinned server-side and is never
// client-controllable -- this proxy is what prevents SSRF and credential
// exposure). PalDefender uses Bearer-token auth (not Basic) and its real
// endpoints live under /v1/pdapi/ -- confirmed by direct testing tonight,
// since the wiki's own documented paths (without this prefix) are outdated.

type RouteContext = {
  params: Promise<{ path: string[] }>
}

interface ProxyServerConfig {
  baseUrl: URL
  token: string
  tier: AccessTier
}

// SECURITY BOUNDARY: mod-tier endpoint allowlist, same philosophy as the game
// proxy's own allowlist -- checked before any upstream contact. PalDefender
// exposes some genuinely powerful endpoints (give items/pals/progression,
// delete base, ban/kick) that mod tier should not reach; keep this to
// read-only, low-risk endpoints only. Admin tier is never filtered.
const MOD_TIER_ALLOWLIST: ReadonlySet<string> = new Set([
  'GET players',
  'GET version',
  'GET banlist',
])

function getServerConfig(tier: AccessTier, instanceId: string | null): ProxyServerConfig | null {
  const instance = resolveInstance(instanceId)
  if (!instance) return null
  const token = resolveSecrets(instanceId).paldefenderToken
  if (!token) {
    return null
  }
  try {
    const baseUrl = new URL(instance.paldefenderUrl)
    baseUrl.pathname = '/'
    baseUrl.search = ''
    baseUrl.hash = ''
    return { baseUrl, token, tier } satisfies ProxyServerConfig
  } catch {
    return null
  }
}

async function getUpstreamRequestBody(request: NextRequest) {
  const contentType = request.headers.get('content-type')
  if (!contentType?.includes('application/json')) {
    return undefined
  }
  try {
    return JSON.stringify(await request.json())
  } catch {
    return undefined
  }
}

function parseProxyResponse(text: string) {
  if (!text) {
    return { success: true }
  }
  try {
    return JSON.parse(text)
  } catch {
    return { success: true, message: text }
  }
}

async function proxyPalDefenderRequest(request: NextRequest, { params }: RouteContext, method: 'GET' | 'POST') {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const presented = request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
  const tier = tierForClass(classifyPassword(presented))
  if (tier === 'invalid') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { path } = await params
  const decodedPath = path.join('/')

  if (tier === 'mod' && !MOD_TIER_ALLOWLIST.has(`${method} ${decodedPath}`)) {
    return NextResponse.json(
      { error: `Forbidden: "${method} /${decodedPath}" is not available to the mod tier` },
      { status: 403 }
    )
  }

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, dryRun: true })
  }

  const instanceId = request.headers.get(PALWORLD_PROXY_HEADERS.instance)
  const serverConfig = getServerConfig(tier, instanceId)
  if (!serverConfig) {
    return NextResponse.json(
      { error: 'PalDefender proxy is not configured (missing PALDEFENDER_REST_TOKEN).' },
      { status: 500 }
    )
  }

  const upstreamPath = path.map((segment) => encodeURIComponent(segment)).join('/')
  const upstreamUrl = new URL(`/v1/pdapi/${upstreamPath}`, serverConfig.baseUrl)
  const body = method === 'POST' ? await getUpstreamRequestBody(request) : undefined

  try {
    const response = await fetch(upstreamUrl, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${serverConfig.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
    })
    const text = await response.text()

    if (!response.ok) {
      return NextResponse.json(
        { error: `PalDefender responded with ${response.status}: ${text}` },
        { status: response.status }
      )
    }

    return NextResponse.json(parseProxyResponse(text))
  } catch (error) {
    console.error('PalDefender proxy error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to connect to PalDefender' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyPalDefenderRequest(request, context, 'GET')
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyPalDefenderRequest(request, context, 'POST')
}
