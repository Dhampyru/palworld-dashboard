// Auth brute-force limiter: 4 failed attempts / 4 minutes.
// Counts ONLY failed (invalid-password) attempts per client IP; a locked-out IP
// is blocked entirely for the window (even a subsequently-correct guess).
// Successful auth is never counted, so a valid-password poll (e.g. the mod
// widget) can never lock itself out. In-memory, single self-hosted instance.
const WINDOW_MS = 4 * 60 * 1000
const MAX_FAILURES = 4
const failures = new Map<string, number[]>()
const FAILURE_DEDUP_MS = 1500 // collapse one login attempt's burst of calls into a single counted failure
const lastFailureAt = new Map<string, number>()

// Trust proxy-supplied client-IP headers? Default OFF. A directly exposed panel
// must NOT trust x-real-ip / x-forwarded-for — otherwise an attacker mints a
// fresh bucket per request (spoofed header) and walks straight past the limiter.
// Set RATE_LIMIT_TRUST_PROXY=true ONLY when the panel sits behind a reverse
// proxy you control that overwrites these headers. When false, every caller
// shares one 'local' bucket: spoof-proof, though one client's failures can lock
// the window for everyone — an acceptable trade for a small self-hosted admin
// panel, and the reason a real reverse proxy is recommended before exposing it.
const TRUST_PROXY = process.env.RATE_LIMIT_TRUST_PROXY === 'true'

export function clientIp(request: { headers: Headers }): string {
  if (TRUST_PROXY) {
    const realIp = request.headers.get('x-real-ip')
    if (realIp) return realIp.trim()
    const xff = request.headers.get('x-forwarded-for')
    if (xff) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
      // The trusted edge appends its observed peer as the LAST token.
      if (parts.length > 0) return parts[parts.length - 1]!
    }
  }
  return 'local'
}

function recent(ip: string, now: number): number[] {
  const arr = (failures.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  if (arr.length > 0) failures.set(ip, arr)
  else {
    failures.delete(ip)
    lastFailureAt.delete(ip)
  }
  return arr
}

export function isLockedOut(ip: string, now = Date.now()): boolean {
  return recent(ip, now).length >= MAX_FAILURES
}

export function recordFailure(ip: string, now = Date.now()): void {
  // One user attempt can fire several requests within ~1s; count it ONCE.
  if (now - (lastFailureAt.get(ip) ?? 0) < FAILURE_DEDUP_MS) return
  lastFailureAt.set(ip, now)
  const arr = recent(ip, now)
  arr.push(now)
  failures.set(ip, arr)
  // opportunistic sweep so neither map can grow unbounded under a distributed probe
  if (failures.size > 2048 || lastFailureAt.size > 2048) {
    for (const [k, v] of failures) {
      if (v.every((t) => now - t >= WINDOW_MS)) {
        failures.delete(k)
        lastFailureAt.delete(k)
      }
    }
    for (const [k, t] of lastFailureAt) if (now - t >= WINDOW_MS) lastFailureAt.delete(k)
  }
}
