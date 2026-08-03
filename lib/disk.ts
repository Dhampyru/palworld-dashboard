import { statfs } from 'node:fs/promises'

export type DiskUsage = { totalBytes: number; freeBytes: number; usedBytes: number }

// Free/total disk on the filesystem that holds `path`. Game/save dirs are
// bind-mounted, so this reports the underlying HOST disk — the one that fills up
// with worlds and backups. `bavail` is space usable by a non-root process (what
// actually matters here); `blocks`×`bsize` is the total. Returns null if the path
// can't be stat'd (e.g. an instance not provisioned yet).
export async function diskUsage(path: string): Promise<DiskUsage | null> {
  try {
    const s = await statfs(path)
    const total = Number(s.blocks) * Number(s.bsize)
    const free = Number(s.bavail) * Number(s.bsize)
    return { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - free) }
  } catch {
    return null
  }
}
