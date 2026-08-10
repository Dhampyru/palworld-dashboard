// SERVER-ONLY. PATCH (not upstream): read player chat / join / leave from PalDefender's own
// rotating logs. On a PalDefender server the game does NOT emit `[CHAT]` to stdout/console.log
// (the format the generic chat-source expects) — PalDefender captures chat into
// Pal/Binaries/Win64/PalDefender/Logs/<session>.log instead, in its own format:
//   [HH:MM:SS][info] [Chat::Global]['Name' (UserId=…, IP=…)]: message
//   [HH:MM:SS][info] 'Name' (UserId=…, IP=…) has logged in.
//   [HH:MM:SS][info] 'Name' (UserId=…, IP=…) has logged out.
// The chat route merges these with its console.log events + admin echoes, so the dashboard chat
// card shows real player chat again. Deployments without PalDefender just get an empty list.
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { currentGameDir } from '@/lib/instances'

export type PalDefenderEvent = { type: 'chat' | 'join' | 'leave'; ts: string; name: string; text?: string }

const TAIL_BYTES = 256 * 1024
const CHAT_RE = /^\[([^\]]+)\]\[info\]\s+\[Chat::[^\]]*\]\['([^']+)'\s+\(UserId=[^)]*\)\]:\s?(.*)$/
const LOGIN_RE = /^\[([^\]]+)\]\[info\]\s+'([^']+)'\s+\(UserId=[^)]*\)\s+has logged in\./
const LOGOUT_RE = /^\[([^\]]+)\]\[info\]\s+'([^']+)'\s+\(UserId=[^)]*\)\s+has logged out\./

// PalDefender rotates its log per session; resolve the newest .log by mtime.
async function newestLog(): Promise<string | null> {
  const dir = join(currentGameDir(), 'Pal', 'Binaries', 'Win64', 'PalDefender', 'Logs')
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  let best: { p: string; m: number } | null = null
  for (const e of entries) {
    if (!e.toLowerCase().endsWith('.log')) continue
    const p = join(dir, e)
    try {
      const st = await stat(p)
      if (st.isFile() && (!best || st.mtimeMs > best.m)) best = { p, m: st.mtimeMs }
    } catch {
      /* skip */
    }
  }
  return best ? best.p : null
}

async function readTail(path: string, limit: number): Promise<string> {
  const info = await stat(path)
  if (info.size <= limit) return readFile(path, 'utf8')
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, info.size - limit)
    const text = buffer.toString('utf8', 0, bytesRead)
    const nl = text.indexOf('\n')
    return nl >= 0 ? text.slice(nl + 1) : text
  } finally {
    await handle.close()
  }
}

// Recent chat/join/leave events from PalDefender's newest log (empty if none/unreadable). Only
// [Chat::…] lines become chat — admin broadcasts log under a different tag, so they don't
// duplicate the route's in-memory announce echoes.
export async function readPalDefenderChatEvents(): Promise<PalDefenderEvent[]> {
  const path = await newestLog()
  if (!path) return []
  let log = ''
  try {
    log = await readTail(path, TAIL_BYTES)
  } catch {
    return []
  }
  const out: PalDefenderEvent[] = []
  for (const raw of log.split('\n')) {
    const line = raw.trim()
    let m = CHAT_RE.exec(line)
    if (m) {
      const text = m[3]!.trim()
      if (text) out.push({ type: 'chat', ts: m[1]!.trim(), name: m[2]!.trim(), text })
      continue
    }
    m = LOGIN_RE.exec(line)
    if (m) {
      out.push({ type: 'join', ts: m[1]!.trim(), name: m[2]!.trim() })
      continue
    }
    m = LOGOUT_RE.exec(line)
    if (m) out.push({ type: 'leave', ts: m[1]!.trim(), name: m[2]!.trim() })
  }
  return out
}
