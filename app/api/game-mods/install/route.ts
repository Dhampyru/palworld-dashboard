import { NextRequest, NextResponse } from 'next/server'
import { mkdir, writeFile, rename, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import { classifyPassword, tierForClass } from '@/lib/access-tier'
import { clientIp, isLockedOut, recordFailure } from '@/lib/rate-limit'
import { DEMO_MODE } from '@/lib/demo-mode'
import { PALWORLD_PROXY_HEADERS } from '@/lib/palworld'
import { runWithInstance } from '@/lib/instances'
import {
  pakModsDir,
  resolveUe4ssModsDir,
  readModsTxt,
  serializeModsTxt,
  SAFE_MOD_NAME,
  SAFE_PAK_FILENAME,
} from '@/lib/game-mods'
import { md5AutoAssociate } from '@/lib/nexus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// PATCH (not upstream): mod installation. Two real risks this route exists
// specifically to guard against:
//  1. Zip-slip — a malicious archive entry named e.g. "../../../etc/cron.d/x"
//     that escapes the intended extraction folder. Every entry's resolved
//     path is checked against the target directory BEFORE anything is
//     written; if any single entry fails, the WHOLE upload is rejected (fail
//     closed, not skip-and-continue).
//  2. Zip bombs / disk exhaustion — both the raw upload and the total
//     uncompressed size are capped.
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024 // 300MB raw upload
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024 // 500MB total once extracted

function presentedPassword(request: NextRequest) {
  return request.headers.get(PALWORLD_PROXY_HEADERS.adminPassword) ?? ''
}

// Derive a mod folder name from a zip's own filename when the caller doesn't
// supply one explicitly, stripping the extension and anything unsafe.
function deriveModName(filename: string): string {
  return filename.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9_-]/g, '')
}

export async function POST(request: NextRequest) {
  return runWithInstance(request.headers.get(PALWORLD_PROXY_HEADERS.instance), () => _POST(request))
}
async function _POST(request: NextRequest) {
  const ip = clientIp(request)
  if (isLockedOut(ip)) {
    return NextResponse.json({ error: 'Too many attempts. Try again later.' }, { status: 429 })
  }
  const passwordClass = classifyPassword(presentedPassword(request))
  if (passwordClass === 'unknown') {
    recordFailure(ip)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // Installing new code/assets onto the server is admin-only — the same bar
  // as toggling and removing.
  if (tierForClass(passwordClass) !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: installing mods is admin-only' }, { status: 403 })
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Malformed upload' }, { status: 400 })
  }

  const kind = formData.get('kind')
  const file = formData.get('file')
  const modNameField = formData.get('modName')

  if ((kind !== 'ue4ss' && kind !== 'pak') || !(file instanceof File)) {
    return NextResponse.json({ error: 'Expected a "kind" (ue4ss|pak) and a "file"' }, { status: 400 })
  }

  if (file.size === 0) {
    return NextResponse.json({ error: 'Uploaded file is empty' }, { status: 400 })
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File too large (${Math.round(file.size / 1024 / 1024)}MB — limit is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB)` },
      { status: 413 }
    )
  }

  if (DEMO_MODE) {
    return NextResponse.json({ success: true, dryRun: true })
  }

  const buffer = Buffer.from(await file.arrayBuffer())

  try {
    if (kind === 'pak') {
      if (!SAFE_PAK_FILENAME.test(file.name)) {
        return NextResponse.json(
          { error: 'Invalid filename — expected letters, numbers, - or _, ending in .pak' },
          { status: 400 }
        )
      }
      await mkdir(pakModsDir(), { recursive: true })
      const targetPath = join(pakModsDir(), file.name)
      // Never silently overwrite an existing mod — remove it explicitly first
      // if that's really the intent.
      try {
        await stat(targetPath)
        return NextResponse.json({ error: `${file.name} already exists — remove it first to replace it` }, { status: 409 })
      } catch {
        // doesn't exist yet — good, proceed
      }
      await writeFile(targetPath, buffer)
      // Best-effort: if this archive is known to Nexus, auto-link for update-watching.
      const nexusLinked = await md5AutoAssociate(`pak:${file.name}`, buffer)
      return NextResponse.json({ success: true, kind, name: file.name, nexusLinked })
    }

    // kind === 'ue4ss'
    const modsDir = await resolveUe4ssModsDir()
    if (!modsDir) {
      return NextResponse.json({ error: 'UE4SS Mods directory not found on this server' }, { status: 500 })
    }

    const rawName = typeof modNameField === 'string' && modNameField.trim() ? modNameField.trim() : deriveModName(file.name)
    if (!SAFE_MOD_NAME.test(rawName)) {
      return NextResponse.json(
        { error: 'Invalid mod name — use only letters, numbers, - or _ (derived from the zip filename if not set explicitly)' },
        { status: 400 }
      )
    }
    if (rawName.toLowerCase() === 'shared') {
      return NextResponse.json({ error: '"shared" is reserved by UE4SS itself' }, { status: 400 })
    }

    const targetModDir = resolve(join(modsDir, rawName))
    const modsDirResolved = resolve(modsDir)
    // Belt-and-suspenders: targetModDir must itself be a direct child of
    // modsDir, even though rawName was already validated against SAFE_MOD_NAME
    // (which can't contain '/' or '..' at all — this is a second, independent
    // check rather than trusting the regex alone).
    if (!targetModDir.startsWith(modsDirResolved + sep)) {
      return NextResponse.json({ error: 'Invalid mod name' }, { status: 400 })
    }

    try {
      await stat(targetModDir)
      return NextResponse.json({ error: `A mod folder named "${rawName}" already exists — remove it first to replace it` }, { status: 409 })
    } catch {
      // doesn't exist yet — good, proceed
    }

    let zip: AdmZip
    try {
      zip = new AdmZip(buffer)
    } catch {
      return NextResponse.json({ error: 'Not a valid zip file' }, { status: 400 })
    }
    const entries = zip.getEntries()

    // Pass 1: validate every entry BEFORE writing anything. Any single bad
    // entry aborts the entire install (fail closed).
    let totalUncompressed = 0
    for (const entry of entries) {
      const entryPath = resolve(join(targetModDir, entry.entryName))
      if (!entryPath.startsWith(targetModDir + sep) && entryPath !== targetModDir) {
        return NextResponse.json(
          { error: `Refusing to install: archive entry "${entry.entryName}" would extract outside the mod folder` },
          { status: 400 }
        )
      }
      totalUncompressed += entry.header.size
    }
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
      return NextResponse.json(
        { error: `Archive too large uncompressed (${Math.round(totalUncompressed / 1024 / 1024)}MB — limit is ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024}MB)` },
        { status: 413 }
      )
    }

    // Pass 2: every entry validated — now actually extract.
    await mkdir(targetModDir, { recursive: true })
    for (const entry of entries) {
      const entryPath = join(targetModDir, entry.entryName)
      if (entry.isDirectory) {
        await mkdir(entryPath, { recursive: true })
      } else {
        await mkdir(join(entryPath, '..'), { recursive: true })
        await writeFile(entryPath, entry.getData())
      }
    }

    // Register it in mods.txt as enabled. UE4SS reads this file to decide what
    // to actually load -- a mod folder sitting on disk with no entry here is
    // invisible to UE4SS, even though our own GET /api/game-mods treats an
    // unlisted mod as "enabled" for display purposes. Found this gap the hard
    // way testing a real install: the folder was correctly in place, but
    // UE4SS's own mods.json never listed it until this entry existed.
    const modsTxtPath = join(modsDir, 'mods.txt')
    const active = await readModsTxt(modsDir)
    active.set(rawName, true)
    const tmp = `${modsTxtPath}.tmp`
    await writeFile(tmp, serializeModsTxt(active), 'utf8')
    await rename(tmp, modsTxtPath)

    // Best-effort: if this archive is known to Nexus, auto-link for update-watching.
    const nexusLinked = await md5AutoAssociate(`ue4ss:${rawName}`, buffer)
    return NextResponse.json({ success: true, kind, name: rawName, nexusLinked })
  } catch (error) {
    return NextResponse.json(
      { error: `Install failed: ${error instanceof Error ? error.message : 'unknown error'}` },
      { status: 500 }
    )
  }
}
