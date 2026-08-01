import { Buffer } from 'node:buffer'
import { NextRequest, NextResponse } from 'next/server'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE, demoPalworldResponse } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { resolveInstance, resolveSecrets } from '@/lib/instances'
import type { AccessTier } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = {
  params: Promise<{ path: string[] }>
}

interface ProxyServerConfig {
  baseUrl: URL
  adminPassword: string
  tier: AccessTier
}

// ─── SECURITY BOUNDARY: MOD-tier endpoint allowlist ─────────────────────────
// A mod-tier request may ONLY reach the endpoints below. Enforcement is
// method-aware, runs against the full decoded upstream path, and happens BEFORE
// any upstream contact — a mod-tier session hitting POST /shutdown from devtools
// gets a 403 right here. This allowlist (not UI hiding) is the security boundary.
// Admin tier is never filtered.
const MOD_TIER_ALLOWLIST: ReadonlySet<string> = new Set([
  'GET players', // roster for the widget
  'GET info', // server name + connect validation
  'GET metrics', // player count
  'POST kick',
  'POST ban',
  'POST unban',
])

// Resolves the PINNED upstream target and injects the game's real REST admin
// password from env. The tier was already verified by the caller, so this does
// NOT re-hash the presented password — an invalid request costs one scrypt pass,
// not two.
//
// SECURITY: the upstream REST target is PINNED server-side and is NOT
// client-controllable. Before this, the proxy connected to any client-supplied
// host:port — an SSRF once the panel is WAN-exposed (probe/POST to internal
// hosts like 127.0.0.1:5432). Client serverIp/serverPort are ignored.
function getServerConfig(tier: AccessTier, instanceId: string | null): ProxyServerConfig | null {
  // Resolve the pinned upstream target + the game's real REST admin password for
  // the selected instance (default when absent). The password is injected into
  // the upstream call and never reaches the client.
  const instance = resolveInstance(instanceId)
  if (!instance) return null
  const gameAdminPassword = resolveSecrets(instanceId).adminPassword

  if (!gameAdminPassword) {
    return null
  }

  try {
    const baseUrl = new URL(instance.restUrl)
    baseUrl.pathname = '/'
    baseUrl.search = ''
    baseUrl.hash = ''
    return { baseUrl, adminPassword: gameAdminPassword, tier } satisfies ProxyServerConfig
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

async function proxyPalworldRequest(request: NextRequest, { params }: RouteContext, method: 'GET' | 'POST') {
  // Brute-force limiter: block IPs with >=4 failed auth attempts in 4 min entirely
  // for the window; count only invalid-password attempts so valid polling is unaffected.
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  // Header-only (never the query string, which leaks into logs).
  const presented = request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
  const tier = tierForClass(classifyPassword(presented))
  if (tier === 'invalid') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { path } = await params

  // MOD-tier enforcement: exact match of "<METHOD> <decoded path>" against the
  // allowlist, checked before anything is forwarded upstream. Path segments
  // arrive URL-decoded from Next, so traversal and encoded-slash tricks
  // ("players/../shutdown", "players%2F..%2Fshutdown") produce keys that simply
  // do not match and are rejected. Case-sensitive by design: fail closed on
  // anything that is not an exact allowlisted endpoint.
  const decodedPath = path.join('/')

  if (tier === 'mod' && !MOD_TIER_ALLOWLIST.has(`${method} ${decodedPath}`)) {
    return NextResponse.json(
      { error: `Forbidden: "${method} /${decodedPath}" is not available to the mod tier` },
      { status: 403 }
    )
  }

  if (DEMO_MODE) {
    return NextResponse.json(demoPalworldResponse(decodedPath, method, tier))
  }

  const instanceId = request.headers.get(PALWORLD_PROXY_HEADERS.instance)
  const serverConfig = getServerConfig(tier, instanceId)

  if (!serverConfig) {
    return NextResponse.json(
      { error: 'Server proxy is not configured (missing PALWORLD_ADMIN_PASSWORD).' },
      { status: 500 }
    )
  }

  const upstreamPath = path.map((segment) => encodeURIComponent(segment)).join('/')
  const upstreamUrl = new URL(`/v1/api/${upstreamPath}`, serverConfig.baseUrl)
  const body = method === 'POST' ? await getUpstreamRequestBody(request) : undefined

  try {
    const response = await fetch(upstreamUrl, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`admin:${serverConfig.adminPassword}`).toString('base64')}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
    })
    const text = await response.text()

    if (!response.ok) {
      return NextResponse.json(
        { error: `Server responded with ${response.status}: ${text}` },
        { status: response.status }
      )
    }

    return NextResponse.json(parseProxyResponse(text))
  } catch (error) {
    console.error('Proxy error:', error)

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to connect to server' },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxyPalworldRequest(request, context, 'GET')
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxyPalworldRequest(request, context, 'POST')
}
