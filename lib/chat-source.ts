// SERVER-ONLY. Reads recent in-game chat / join / leave lines from a plain log
// FILE, as an alternative to the chat route's default `journalctl` / `docker
// logs` exec. This is for environments with neither systemd nor a Docker socket
// — Kubernetes / containerd (Talos), Podman, or any setup that can drop the
// game server's stdout into a file. Activated by PALWORLD_CHAT_LOG_FILE.
//
// The file is expected to hold the game server's raw stdout lines — the same
// `[timestamp] [CHAT] <Name> msg` / join / leave lines the exec paths already
// parse. It may optionally be a Kubernetes/CRI container log, where each line is
// prefixed with `<RFC3339> stdout F `; that prefix is auto-detected and stripped
// per line so the downstream regexes see the game's original line unchanged.
//
// How the bytes reach the file (a relay sidecar streaming pod logs, a read-only
// hostPath mount of /var/log/pods, `docker logs -f >> file`, a shared volume the
// game writes) is a deployment choice — the same producer/consumer split the FPS
// sampler already uses for its ring file.
import { Buffer } from 'node:buffer'
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { currentGameDir, currentInstanceId, DEFAULT_INSTANCE_ID } from '@/lib/instances'

// Path OR glob pattern to the chat log file. A glob (containing `*` or `?`)
// resolves to its most-recently-modified match, so a Kubernetes/CRI path whose
// pod UID and restart count change across restarts can be matched with e.g.
// `/var/log/pods/games_palworld-*/app/*.log`.
//
// Multi-instance (#7): resolved per active instance. `default` honors the env
// override (today's value); every other instance reads <gameDir>/console.log
// (each container tees its stdout there on the shared mount).
export function chatLogFile(): string | undefined {
  // default: exactly as before (env override, possibly undefined so the route's
  // docker/journalctl fallback still applies). Provisioned instances always tee
  // stdout to <gameDir>/console.log, so use that.
  if (currentInstanceId() === DEFAULT_INSTANCE_ID) return process.env.PALWORLD_CHAT_LOG_FILE
  return join(currentGameDir(), 'console.log')
}

// Bound the read like the exec path's `maxBuffer`. The chat route only keeps the
// last ~120 events, so reading the tail of a large (rotated CRI) log is enough.
//
// PATCH (not upstream): make the bound configurable. The default only kicks in
// above 4MB, so a log below that is re-read IN FULL on every poll -- this
// deployment's console.log is 2.4MB of Wine noise and unrotated, i.e. a 2.4MB
// read per poll that grows forever. Setting PALWORLD_CHAT_LOG_MAX_BYTES makes
// the tail path apply at a sane size instead. Default is unchanged, so upstream
// behaviour is identical when the var is unset.
const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024

function maxReadBytes(): number {
  const configured = Number(process.env.PALWORLD_CHAT_LOG_MAX_BYTES)
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_MAX_READ_BYTES
}

// A CRI/Kubernetes container-log line: an RFC3339 timestamp, the stream name, an
// `F` (full) or `P` (partial) tag, then the actual log text. The game's own
// lines start with `[` and their bracket timestamp contains a space, so real
// chat lines never match this pattern and pass through untouched.
const CRI_LINE_RE = /^\S+ (?:stdout|stderr) [FP] (.*)$/

function isGlob(pattern: string): boolean {
  return /[*?]/.test(pattern)
}

function segmentToRegExp(segment: string): RegExp {
  const body = segment.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : `\\${ch}`,
  )
  return new RegExp(`^${body}$`)
}

// Minimal, dependency-free multi-segment glob (supports `*` and `?`). Walks the
// pattern one path segment at a time, expanding each glob segment against the
// directory entries that matched so far.
async function expandGlob(pattern: string): Promise<string[]> {
  const absolute = pattern.startsWith('/')
  const segments = pattern.split('/').filter((segment) => segment.length > 0)
  let bases: string[] = [absolute ? '/' : '.']

  for (const segment of segments) {
    if (!isGlob(segment)) {
      bases = bases.map((base) => join(base, segment))
      continue
    }
    const re = segmentToRegExp(segment)
    const next: string[] = []
    for (const base of bases) {
      try {
        const entries = await readdir(base, { withFileTypes: true })
        for (const entry of entries) {
          if (re.test(entry.name)) next.push(join(base, entry.name))
        }
      } catch {
        // Unreadable/missing directory — skip this base.
      }
    }
    bases = next
  }
  return bases
}

// Resolve the configured path/glob to a single concrete file: the newest match
// by mtime, so the current pod's log wins after a restart.
async function resolveLogFile(pattern: string): Promise<string | null> {
  const candidates = isGlob(pattern) ? await expandGlob(pattern) : [pattern]
  let best: { path: string; mtimeMs: number } | null = null
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile() && (!best || info.mtimeMs > best.mtimeMs)) {
        best = { path: candidate, mtimeMs: info.mtimeMs }
      }
    } catch {
      // Missing/unreadable candidate — skip.
    }
  }
  return best ? best.path : null
}

// Read the whole file when small, otherwise just the last MAX_READ_BYTES with
// the leading partial line dropped.
async function readTail(path: string): Promise<string> {
  const limit = maxReadBytes()
  const info = await stat(path)
  if (info.size <= limit) {
    return readFile(/* turbopackIgnore: true */ path, 'utf8')
  }
  const handle = await open(/* turbopackIgnore: true */ path, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, info.size - limit)
    const text = buffer.toString('utf8', 0, bytesRead)
    const firstNewline = text.indexOf('\n')
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : text
  } finally {
    await handle.close()
  }
}

function stripCriPrefixes(text: string): string {
  let stripped = false
  const lines = text.split('\n').map((line) => {
    const match = CRI_LINE_RE.exec(line)
    if (!match) return line
    stripped = true
    return match[1]
  })
  return stripped ? lines.join('\n') : text
}

// Returns the recent chat-log text (CRI-stripped and NUL-scrubbed), or '' when
// no file is configured or none resolves. The chat route feeds this into the
// same line parser it uses for the exec sources.
export async function readChatLog(): Promise<string> {
  const configured = chatLogFile()
  if (!configured) return ''
  const path = await resolveLogFile(configured)
  if (!path) return ''
  const raw = (await readTail(path)).replaceAll('\0', '')
  return stripCriPrefixes(raw)
}
