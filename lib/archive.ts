import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'

const execFileP = promisify(execFile)

// The Unarchiver (`unar`, GPL — redistributable in the image) handles .rar
// (incl. RAR5), .7z, .zip, .tar and more with one binary. We only shell out for
// the formats adm-zip can't read; zip stays in-process. Overridable for tests.
const UNAR_BIN = process.env.UNAR_BIN ?? 'unar'

export type ArchiveFormat = 'zip' | '7z' | 'rar' | 'unknown'

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
    const src = join(work, `archive.${fmt}`)
    const out = join(work, 'out')
    await writeFile(src, buffer)
    // -q quiet, -f force-overwrite, -D never wrap in a containing dir (so `out/`
    // mirrors the archive's own root layout — the install pipeline expects that;
    // note -D is "no-directory", whereas lowercase -d FORCES one).
    await execFileP(UNAR_BIN, ['-q', '-f', '-D', '-o', out, src], { maxBuffer: 64 * 1024 * 1024 })
    const zip = new AdmZip()
    await addDirToZip(zip, out, out)
    if (zip.getEntries().length === 0) throw new Error('archive extracted to nothing')
    return zip.toBuffer()
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
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
