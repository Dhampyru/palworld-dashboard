import { randomBytes } from 'node:crypto'

// PATCH (not upstream): one-time download tokens for the client loadout (docs/specs/
// client-mod-sync.md §6). The bundle is ~1GB, so the browser can't buffer it via
// fetch→blob. Instead: POST generates + mints a short-lived, single-use, unguessable
// token; the browser then NAVIGATES to a tokened GET, which streams straight to disk (no
// header needed → plain navigation works). The token IS the capability — 256-bit random,
// consumed on first use, and expired entries are swept (their temp dirs removed). In-memory
// + single-process, which matches this single-container deploy (a multi-instance/k8s
// deploy would swap this for a shared store — the route contract is unchanged).
export type LoadoutTokenEntry = {
  zipPath: string
  fileName: string
  sizeBytes: number
  cleanup: () => Promise<void>
  expiresAt: number
}

const store = new Map<string, LoadoutTokenEntry>()
const TTL_MS = 15 * 60 * 1000 // generous — the browser navigates within seconds of the POST

function sweep(): void {
  const now = Date.now()
  for (const [tok, e] of store) {
    if (e.expiresAt <= now) {
      store.delete(tok)
      void e.cleanup()
    }
  }
}

export function mintLoadoutToken(entry: Omit<LoadoutTokenEntry, 'expiresAt'>): string {
  sweep()
  const token = randomBytes(32).toString('hex')
  store.set(token, { ...entry, expiresAt: Date.now() + TTL_MS })
  return token
}

// One-time: returns AND removes the entry (null if unknown/expired). Caller streams the
// file then calls entry.cleanup() to remove the temp dir.
export function takeLoadoutToken(token: string): LoadoutTokenEntry | null {
  sweep()
  const e = store.get(token)
  if (!e) return null
  store.delete(token)
  if (e.expiresAt <= Date.now()) {
    void e.cleanup()
    return null
  }
  return e
}

export const LOADOUT_TOKEN_RE = /^[a-f0-9]{64}$/
