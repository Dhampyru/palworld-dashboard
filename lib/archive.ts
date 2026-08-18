import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'

const execFileP = promisify(execFile)

// Two shell extractors for the formats adm-zip can't read (zip stays in-process):
// bsdtar (libarchive, BSD) is primary — robust RAR5/7z/tar/gzip; unar (The Unarchiver,
// GPL) is the fallback. unar's RAR5 decoder is incomplete and fails mid-file on some
// archives, which is why bsdtar leads. Both overridable for tests.
const UNAR_BIN = process.env.UNAR_BIN ?? 'unar'
const BSDTAR_BIN = process.env.BSDTAR_BIN ?? 'bsdtar'

export type ArchiveFormat = 'zip' | '7z' | 'rar' | 'tar' | 'gzip' | 'unknown'

// Sniff by magic bytes, not extension — a Nexus "download" is an opaque buffer.
// Extract a .zip to destDir per-entry — robust to archives with MALFORMED directory entries
// (a 0-byte "dir" entry with no trailing slash that unar turns into a FILE, then fails every
// subdir with "Could not create directory" and still exits 0; some mods, e.g. OathrBGM, ship
// this). Skips phantom dir entries (a 0-byte entry that's the path-prefix of another), creates
// each file's parent, path-escape guarded. Preferred over unar for zips.
export async function extractZipTolerant(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true })
  const entries = new AdmZip(zipPath).getEntries()
  const names = entries.map((e) => e.entryName.replace(/\\/g, '/'))
  const isPhantomDir = (n: string) => names.some((o) => o !== n && o.startsWith(n + '/'))
  for (const e of entries) {
    const name = e.entryName.replace(/\\/g, '/')
    if (e.isDirectory || name.endsWith('/') || isPhantomDir(name)) continue
    const dest = join(destDir, name)
    if (dest !== destDir && !dest.startsWith(destDir + sep)) continue
    await mkdir(join(dest, '..'), { recursive: true })
    await writeFile(dest, e.getData())
  }
}

export function archiveFormat(buffer: Buffer): ArchiveFormat {
  if (buffer.length < 6) return 'unknown'
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return 'zip' // "PK"
  if (
    buffer[0] === 0x37 && buffer[1] === 0x7a && buffer[2] === 0xbc &&
    buffer[3] === 0xaf && buffer[4] === 0x27 && buffer[5] === 0x1c
  ) return '7z' // 7z\xBC\xAF\x27\x1C
  if (buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 && buffer[3] === 0x21) return 'rar' // "Rar!"
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) return 'gzip' // \x1F\x8B (.gz / .tgz / .tar.gz)
  if (buffer.length >= 262 && buffer.toString('ascii', 257, 262) === 'ustar') return 'tar' // POSIX/GNU tar magic @257
  return 'unknown'
}

// A FOMOD is a Nexus installer archive: a single download whose `fomod/ModuleConfig.xml`
// declares MULTIPLE mutually-exclusive variant options (SelectExactlyOne). It has one MAIN
// file, so the bulk "multiple MAIN files → manual" guard misses it, and its variant files
// don't map to any mod-folder layout — so it can't be auto-installed. Detect it (on a
// normalized zip buffer) and route it to a manual single-install + variant choice.
export const FOMOD_MESSAGE =
  'This is a FOMOD installer with multiple variant options — it can’t be auto-installed. Download it, pick a variant, and upload the chosen files (or place them manually).'

export function isFomodArchive(zipBuffer: Buffer): boolean {
  try {
    return new AdmZip(zipBuffer)
      .getEntries()
      .some((e) => /(^|\/)fomod\/moduleconfig\.xml$/i.test(e.entryName.replace(/\\/g, '/')))
  } catch {
    return false
  }
}

// Normalize any supported archive to a ZIP buffer so the existing adm-zip based
// install pipeline (detectModKind / installUe4ssModArchive / installPakArchive /
// installPalSchemaSubmod) handles .rar and .7z without touching any of it.
//   zip / unknown → returned unchanged (let the caller's own error path speak).
//   7z / rar      → extracted with `unar` into a temp dir, then re-packed to zip.
// Throws only if the archive is genuinely corrupt/unreadable by unar; callers
// treat a throw the same as any other "couldn't open this" and surface it.
export async function normalizeArchiveToZip(buffer: Buffer): Promise<Buffer> {
  const fmt = archiveFormat(buffer)
  if (fmt === 'zip' || fmt === 'unknown') return buffer

  const work = await mkdtemp(join(tmpdir(), 'modarch-'))
  try {
    // gzip is almost always a .tar.gz here — name it .tgz so the inner tar tree extracts
    // rather than just one gzip layer to a lone .tar file. (Extractors detect by content;
    // the extension is only a hint.)
    const src = join(work, `archive.${fmt === 'gzip' ? 'tgz' : fmt}`)
    await writeFile(src, buffer)
    const out = await extractToDir(src, work)
    const zip = new AdmZip()
    await addDirToZip(zip, out, out)
    if (zip.getEntries().length === 0) throw new Error('archive extracted to nothing')
    return zip.toBuffer()
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

// Extract into a temp dir whose layout mirrors the archive's own root (the install pipeline
// expects that). bsdtar (libarchive) is PRIMARY — its RAR5/7z support is far more complete
// than unar's (unar's RAR5 decoder fails mid-file on some archives, e.g. Nexus mod 3771 with
// "Attempted to read more data than was available"). unar is the FALLBACK for anything
// libarchive can't open. Each attempt must exit clean AND produce files, else we try the next.
async function extractToDir(src: string, work: string): Promise<string> {
  const attempts: { bin: string; args: (out: string) => string[] }[] = [
    { bin: BSDTAR_BIN, args: (out) => ['-x', '-f', src, '-C', out] },
    // -q quiet, -f force-overwrite, -D never wrap in a containing dir (lowercase -d FORCES one).
    { bin: UNAR_BIN, args: (out) => ['-q', '-f', '-D', '-o', out, src] },
  ]
  const failures: string[] = []
  for (let i = 0; i < attempts.length; i++) {
    const out = join(work, `out${i}`)
    await mkdir(out, { recursive: true })
    try {
      await execFileP(attempts[i].bin, attempts[i].args(out), { maxBuffer: 64 * 1024 * 1024 })
      if (await dirHasFiles(out)) return out
      failures.push(`${attempts[i].bin}: extracted nothing`)
    } catch (e) {
      failures.push(`${attempts[i].bin}: ${e instanceof Error ? e.message.split('\n')[0] : 'failed'}`)
    }
  }
  throw new Error(`Could not extract archive (${failures.join('; ')})`)
}

async function dirHasFiles(dir: string): Promise<boolean> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isFile()) return true
    if (e.isDirectory() && (await dirHasFiles(join(dir, e.name)))) return true
  }
  return false
}

async function addDirToZip(zip: AdmZip, root: string, dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await addDirToZip(zip, root, full)
    else if (entry.isFile()) {
      const rel = relative(root, full).split(sep).join('/')
      zip.addFile(rel, await readFile(full))
    }
  }
}
