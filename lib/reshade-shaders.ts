// SERVER-ONLY. PATCH (not upstream): ReShade shader dependency RESOLVER (docs/specs/
// reshade-loadout.md §shaders). A ReShade preset is a recipe — its `Techniques=` line names the
// `.fx` effects it needs, but the preset itself rarely ships them. This resolver satisfies each
// required shader from, in priority order: (1) files BUNDLED in the preset's own archive, (2) the
// already-resolved shader library, (3) a registry of known community shader repos on GitHub
// (fetched at the OPERATOR's instance — pointers only ship in the repo, never the shaders, same
// clean-room stance as game data). Anything left over is REPORTED as a gap for the operator to
// supply, so a preset never ships silently broken.
//
// Rate limits: GitHub's tree API is 60/hr unauthenticated, so repo indexes are CACHED. Individual
// files are fetched from raw.githubusercontent.com, which is NOT rate-limited.
import AdmZip from 'adm-zip'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DATA_DIR = resolve(process.env.DASHBOARD_DATA_DIR ?? './data')
const RESHADE_DIR = join(DATA_DIR, 'reshade')
const SHADERS_DIR = join(RESHADE_DIR, 'shaders') // → overlaid into Win64/reshade-shaders/ at build
const SHADERS_FX = join(SHADERS_DIR, 'Shaders')
const SHADERS_TEX = join(SHADERS_DIR, 'Textures')
const CACHE_FILE = join(RESHADE_DIR, 'repo-cache.json')

// Priority-ordered registry of known shader repos. `license` is informational (surfaced in the
// report); the dashboard never redistributes these — the operator's instance fetches them.
export type ShaderRepo = { name: string; owner: string; repo: string; branch: string; license: string }
export const SHADER_REPOS: ShaderRepo[] = [
  { name: 'SweetFX (classic stock effects)', owner: 'CeeJayDK', repo: 'SweetFX', branch: 'master', license: 'MIT' },
  { name: 'ReShade stock (core includes + Deband/LUT)', owner: 'crosire', repo: 'reshade-shaders', branch: 'slim', license: 'BSD-3-Clause' },
  { name: 'Depth3D (SuperDepth3D)', owner: 'BlueSkyDefender', repo: 'Depth3D', branch: 'master', license: 'custom — free, attribution (see repo)' },
  { name: 'qUINT (free effects)', owner: 'martymcmodding', repo: 'qUINT', branch: 'master', license: 'custom — free effects only (RTGI is paid/separate)' },
  { name: 'AstrayFX', owner: 'BlueSkyDefender', repo: 'AstrayFX', branch: 'master', license: 'custom — free (see repo)' },
]

const GH_HEADERS = { 'User-Agent': 'palworld-dashboard', Accept: 'application/vnd.github+json' }
const rawUrl = (r: ShaderRepo, path: string) => `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${r.branch}/${path}`

type RepoIndex = { fetchedAt: number; files: Record<string, string> } // lower-basename → repo path
type Cache = Record<string, RepoIndex> // key = owner/repo@branch
const CACHE_TTL = 24 * 60 * 60 * 1000

async function readCache(): Promise<Cache> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8')) as Cache
  } catch {
    return {}
  }
}
async function writeCache(c: Cache): Promise<void> {
  await mkdir(RESHADE_DIR, { recursive: true })
  await writeFile(CACHE_FILE, JSON.stringify(c, null, 2), 'utf8')
}

// Index one repo's .fx/.fxh files (basename → path), cached. Returns {} if GitHub is unreachable
// or rate-limited (the resolver then treats that repo's shaders as unavailable → reported gaps).
async function repoIndex(r: ShaderRepo, cache: Cache): Promise<Record<string, string>> {
  const key = `${r.owner}/${r.repo}@${r.branch}`
  const cached = cache[key]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.files
  try {
    const res = await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${r.branch}?recursive=1`, { headers: GH_HEADERS })
    if (!res.ok) return cached?.files ?? {}
    const j = (await res.json()) as { tree?: { path: string; type: string }[] }
    const files: Record<string, string> = {}
    for (const t of j.tree ?? []) {
      if (!/\.(fx|fxh)$/i.test(t.path)) continue
      const base = t.path.split('/').pop()!.toLowerCase()
      if (!(base in files)) files[base] = t.path // first path wins
    }
    cache[key] = { fetchedAt: Date.now(), files }
    return files
  } catch {
    return cached?.files ?? {}
  }
}

// `Techniques=Name@File.fx,Name2@File2.fx` → the set of required .fx basenames. ONLY the
// `Techniques=` line (the ENABLED effects the preset actually renders) — deliberately NOT
// `TechniqueSorting=`, which lists every effect the author had installed (enabled or not) as
// menu-order metadata and would balloon a 4-effect preset to 160+ phantom dependencies.
export function parseRequiredFx(iniContent: string): string[] {
  const out = new Set<string>()
  for (const line of iniContent.split(/\r?\n/)) {
    const m = /^\s*Techniques\s*=\s*(.+)$/i.exec(line)
    if (!m) continue
    for (const tok of m[1].split(',')) {
      const at = tok.indexOf('@')
      const file = (at >= 0 ? tok.slice(at + 1) : tok).trim()
      if (/\.fx$/i.test(file)) out.add(file.split(/[\\/]/).pop()!)
    }
  }
  return [...out]
}

// `#include "X.fxh"` (and .fx) → dependency basenames.
function parseIncludes(source: string): string[] {
  const out = new Set<string>()
  const re = /#\s*include\s+"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    const base = m[1].split(/[\\/]/).pop()!
    if (/\.(fx|fxh)$/i.test(base)) out.add(base)
  }
  return [...out]
}

export type ResolvedShader = { file: string; source: string } // source: 'bundled' | 'library' | repo.name
export type ShaderResolution = { required: string[]; resolved: ResolvedShader[]; missing: string[]; sources: string[] }

async function fetchFromRepos(base: string, cache: Cache): Promise<{ buf: Buffer; source: string } | null> {
  for (const r of SHADER_REPOS) {
    const idx = await repoIndex(r, cache)
    const path = idx[base.toLowerCase()]
    if (!path) continue
    try {
      const res = await fetch(rawUrl(r, path), { headers: { 'User-Agent': 'palworld-dashboard' } })
      if (!res.ok) continue
      return { buf: Buffer.from(await res.arrayBuffer()), source: r.name }
    } catch {
      /* try next repo */
    }
  }
  return null
}

// Resolve every shader a preset needs into the shared library (data/reshade/shaders/Shaders).
// `bundledZip` = the preset's own archive buffer (if any) — its .fx/.fxh/.png are used first.
// Recursively follows #include dependencies. Core includes (ReShade.fxh/ReShadeUI.fxh) always
// resolved. Idempotent: a shader already in the library counts as resolved without re-fetching.
const SRC_MANIFEST = join(SHADERS_DIR, '.sources.json')
async function readSrcManifest(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(SRC_MANIFEST, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

export async function resolvePresetShaders(iniContent: string, bundledZip?: Buffer): Promise<ShaderResolution> {
  await mkdir(SHADERS_FX, { recursive: true })
  await mkdir(SHADERS_TEX, { recursive: true })
  const cache = await readCache()
  const srcManifest = await readSrcManifest() // lower-basename → where it originally came from

  // Index the bundled archive (basename → entry) and stash any textures.
  const bundled = new Map<string, Buffer>()
  if (bundledZip) {
    try {
      for (const e of new AdmZip(bundledZip).getEntries()) {
        if (e.isDirectory) continue
        const base = e.entryName.split(/[\\/]/).pop()!
        if (/\.(fx|fxh)$/i.test(base)) bundled.set(base.toLowerCase(), e.getData())
        else if (/\.(png|jpg|jpeg|bmp|dds)$/i.test(base)) await writeFile(join(SHADERS_TEX, base), e.getData()).catch(() => {})
      }
    } catch {
      /* not a zip / unreadable — no bundled shaders */
    }
  }

  const required = parseRequiredFx(iniContent)
  const resolved: ResolvedShader[] = []
  const missing: string[] = []
  const sources = new Set<string>()
  const seen = new Set<string>()
  // Always ensure the core includes exist (every stock shader includes them).
  const queue = [...required, 'ReShade.fxh', 'ReShadeUI.fxh']
  let guard = 0

  while (queue.length && guard++ < 400) {
    const name = queue.shift()!
    const lower = name.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)

    const dest = join(SHADERS_FX, name)
    let content: Buffer | null = null
    let source = ''

    if (bundled.has(lower)) {
      content = bundled.get(lower)!
      source = 'bundled'
    } else if (existsSync(dest)) {
      content = await readFile(dest)
      source = srcManifest[lower] ?? 'library' // remember where it first came from
    } else {
      const got = await fetchFromRepos(name, cache)
      if (got) {
        content = got.buf
        source = got.source
      }
    }

    if (!content) {
      if (/\.fx$/i.test(name)) missing.push(name) // report missing effects (not core includes)
      continue
    }
    await writeFile(dest, content)
    if (source && source !== 'library') {
      sources.add(source)
      srcManifest[lower] = source // persist origin so re-resolves still attribute it
    }
    if (/\.fx$/i.test(name)) resolved.push({ file: name, source: source || 'library' })
    // Follow this file's #includes.
    for (const dep of parseIncludes(content.toString('utf8'))) if (!seen.has(dep.toLowerCase())) queue.push(dep)
  }

  await writeCache(cache)
  await writeFile(SRC_MANIFEST, JSON.stringify(srcManifest, null, 2)).catch(() => {})
  // Report sources across ALL resolved shaders (from the manifest), not just those fetched this
  // run — so a re-resolve served from the library still shows where each shader originated.
  const allSources = new Set<string>()
  for (const r of resolved) {
    const s = r.source !== 'library' ? r.source : srcManifest[r.file.toLowerCase()]
    if (s && s !== 'library') allSources.add(s)
  }
  return { required, resolved, missing, sources: [...allSources] }
}

// Copy the resolved shader library into a bundle's reshade-shaders dir. Returns file count.
export async function overlayShaderLibraryInto(win64Dir: string): Promise<number> {
  if (!existsSync(SHADERS_FX)) return 0
  const destShaders = join(win64Dir, 'reshade-shaders', 'Shaders')
  const destTex = join(win64Dir, 'reshade-shaders', 'Textures')
  await mkdir(destShaders, { recursive: true })
  await mkdir(destTex, { recursive: true })
  let n = 0
  for (const f of await readdir(SHADERS_FX).catch(() => [])) {
    await writeFile(join(destShaders, f), await readFile(join(SHADERS_FX, f)))
    n++
  }
  for (const f of await readdir(SHADERS_TEX).catch(() => [])) {
    await writeFile(join(destTex, f), await readFile(join(SHADERS_TEX, f)))
    n++
  }
  return n
}

// Manually add gap shader(s) the operator supplies (raw .fx/.fxh or an archive of them).
export async function addShaderFiles(buffer: Buffer, filename: string): Promise<{ added: string[] }> {
  await mkdir(SHADERS_FX, { recursive: true })
  await mkdir(SHADERS_TEX, { recursive: true })
  const added: string[] = []
  if (/\.(fx|fxh)$/i.test(filename)) {
    await writeFile(join(SHADERS_FX, filename.split(/[\\/]/).pop()!), buffer)
    added.push(filename)
    return { added }
  }
  try {
    for (const e of new AdmZip(buffer).getEntries()) {
      if (e.isDirectory) continue
      const base = e.entryName.split(/[\\/]/).pop()!
      if (/\.(fx|fxh)$/i.test(base)) {
        await writeFile(join(SHADERS_FX, base), e.getData())
        added.push(base)
      } else if (/\.(png|jpg|jpeg|bmp|dds)$/i.test(base)) {
        await writeFile(join(SHADERS_TEX, base), e.getData())
        added.push(base)
      }
    }
  } catch {
    throw new Error('Upload a .fx/.fxh file or a .zip of shader files.')
  }
  if (!added.length) throw new Error('No .fx/.fxh shader files found in that upload.')
  return { added }
}
