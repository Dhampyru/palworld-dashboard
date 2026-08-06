import { readdir, readFile, stat, mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { currentGameDir } from '@/lib/instances'
import { isSafeModFolderName, resolveUe4ssModsDir } from '@/lib/game-mods'
import { writeConfigFileWithBackup } from '@/lib/config-write'

// Mod Config Editor (docs/specs/mod-config-editor.md). Discover an installed UE4SS
// mod's OWN config file(s) and let an admin edit the data ones (JSON/JSONC/INI)
// with format validation; Lua configs are code and stay read-only. The game's own
// configs (World Settings / Engine / PalDefender) have their own editors — not here.

export type ModConfigFormat = 'json' | 'jsonc' | 'ini' | 'lua'
export type ModConfigFile = {
  id: string // stable label, also the client-facing handle (a relative path)
  label: string // shown in the UI
  format: ModConfigFormat
  editable: boolean // false for Lua (code) and for not-yet-created templates
  exists: boolean
  isTemplate: boolean // a *.default.* / *.example.* seed with no live sibling
  // server-only:
  absPath: string
  seedFrom?: string // for a template placeholder: the absolute template path to copy
}

const DATA_EXT = /\.(jsonc?|ini)$/i
const TEMPLATE_RE = /\.(default|example)\.[^.]+$/i

function formatOf(name: string): ModConfigFormat | null {
  const l = name.toLowerCase()
  if (l.endsWith('.jsonc')) return 'jsonc'
  if (l.endsWith('.json')) return 'json'
  if (l.endsWith('.ini')) return 'ini'
  if (l.endsWith('.lua')) return 'lua'
  return null
}

// Strip a *.default.ini / *.example.ini suffix down to the live filename.
function liveNameOfTemplate(name: string): string {
  return name.replace(/\.(default|example)(\.[^.]+)$/i, '$2')
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name)
  } catch {
    return []
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// The directories we scan for one mod's config, and the label prefix for each.
async function configRoots(modName: string): Promise<{ dir: string; prefix: string }[]> {
  const modsDir = await resolveUe4ssModsDir()
  const gameDir = currentGameDir()
  const roots: { dir: string; prefix: string }[] = []
  if (modsDir) {
    roots.push({ dir: join(modsDir, modName), prefix: '' })
    roots.push({ dir: join(modsDir, modName, 'Scripts'), prefix: 'Scripts/' })
    roots.push({ dir: join(modsDir, modName, 'Config'), prefix: 'Config/' })
  }
  // Runtime config location (…/Pal/Saved/<mod>/) — where mods like BaseRadiusImproved
  // keep the actually-editable JSON, reached as ../../Saved/<mod>/ from Win64.
  roots.push({ dir: join(gameDir, 'Pal', 'Saved', modName), prefix: 'Saved/' })
  return roots
}

// Discover a mod's config files. Data files (JSON/JSONC/INI) are editable; Lua is
// listed read-only; a *.default.*/*.example.* template with no live sibling is offered
// as a "create from template" placeholder.
export async function listModConfigs(modName: string): Promise<ModConfigFile[]> {
  if (!isSafeModFolderName(modName)) return []
  const roots = await configRoots(modName)
  const out: ModConfigFile[] = []
  const seen = new Set<string>()

  for (const { dir, prefix } of roots) {
    const names = await readdirSafe(dir)
    const nameSet = new Set(names.map((n) => n.toLowerCase()))
    for (const name of names) {
      const fmt = formatOf(name)
      if (!fmt) continue
      if (name.endsWith('.bak')) continue
      // Lua is a mod's source; only surface the config-looking ones (config.lua,
      // settings.lua) read-only, not every module (main.lua, storage_adapters.lua…).
      if (fmt === 'lua' && !/config|settings/i.test(name)) continue

      if (TEMPLATE_RE.test(name) && DATA_EXT.test(name)) {
        // A template. Only surface it if there's no live sibling to edit instead.
        const live = liveNameOfTemplate(name)
        if (nameSet.has(live.toLowerCase())) continue
        const id = `${prefix}${live}`
        if (seen.has(id)) continue
        seen.add(id)
        out.push({
          id,
          label: id,
          format: formatOf(live) ?? fmt,
          editable: false,
          exists: false,
          isTemplate: true,
          absPath: join(dir, live),
          seedFrom: join(dir, name),
        })
        continue
      }

      const id = `${prefix}${name}`
      if (seen.has(id)) continue
      seen.add(id)
      out.push({
        id,
        label: id,
        format: fmt,
        editable: fmt !== 'lua', // Lua is code — read-only
        exists: true,
        isTemplate: false,
        absPath: join(dir, name),
      })
    }
  }
  // Data configs first, Lua last; stable by label within each.
  return out.sort((a, b) => Number(a.format === 'lua') - Number(b.format === 'lua') || a.label.localeCompare(b.label))
}

// Look up one discovered file by its client handle. Re-discovering and matching by id
// is the path guard — the client can only ever name a file discovery produced, so no
// traversal outside the mod's own config roots is possible.
async function resolveFile(modName: string, id: string): Promise<ModConfigFile | null> {
  return (await listModConfigs(modName)).find((f) => f.id === id) ?? null
}

export async function readModConfig(modName: string, id: string): Promise<{ file: ModConfigFile; content: string }> {
  const file = await resolveFile(modName, id)
  if (!file) throw new Error('Config file not found')
  const content = file.exists ? await readFile(file.absPath, 'utf8') : ''
  return { file, content }
}

// Validate content for a data format; throws a human error on invalid input so a bad
// edit is never written. Returns normalized content to write.
export function validateConfigContent(format: ModConfigFormat, content: string): string {
  if (format === 'json') {
    try {
      JSON.parse(content)
    } catch (e) {
      throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`)
    }
  } else if (format === 'jsonc') {
    // Tolerant: strip // and /* */ comments, then parse. Only for validation.
    const stripped = content
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n\r]*/g, '$1')
    try {
      JSON.parse(stripped)
    } catch (e) {
      throw new Error(`Invalid JSONC: ${e instanceof Error ? e.message : 'parse error'}`)
    }
  } else if (format === 'ini') {
    // No ini dep: a lenient structural check — every non-blank, non-comment line must
    // be a [section] header or a key=value. Catches gross corruption without a parser.
    const lines = content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim()
      if (t === '' || t.startsWith(';') || t.startsWith('#')) continue
      if (t.startsWith('[') && t.endsWith(']') && t.length > 2) continue
      if (t.includes('=')) continue
      throw new Error(`Invalid INI at line ${i + 1}: "${lines[i]}" (expected a [section] or key=value)`)
    }
  } else {
    throw new Error('This config is Lua code and is read-only here — edit it on disk.')
  }
  return content
}

export async function writeModConfig(modName: string, id: string, content: string): Promise<void> {
  const file = await resolveFile(modName, id)
  if (!file) throw new Error('Config file not found')
  if (!file.editable) throw new Error('This config is not editable here')
  const normalized = validateConfigContent(file.format, content)
  await writeConfigFileWithBackup(file.absPath, normalized)
}

// Create a missing live config from its *.default.*/*.example.* template (the only
// generically-detectable "create missing" case). Creates the parent dir if needed
// (e.g. Pal/Saved/<mod>/, which the volume lets uid 2001 write).
export async function createModConfigFromTemplate(modName: string, id: string): Promise<void> {
  const file = await resolveFile(modName, id)
  if (!file || !file.isTemplate || !file.seedFrom) throw new Error('No template to create from')
  if (await exists(file.absPath)) throw new Error('Config already exists')
  await mkdir(join(file.absPath, '..'), { recursive: true })
  await copyFile(file.seedFrom, file.absPath)
}
