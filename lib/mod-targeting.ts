// Shared mod-targeting analysis (docs: unified mods uploader). Given a NORMALIZED zip
// buffer (caller runs normalizeArchiveToZip first), decide WHERE an uploaded mod should
// go — the live server, a friend's client loadout, or both — WITHOUT installing anything.
// This backs the "scan first, then confirm" upload flow: parse the archive contents, pick
// a default target, and explain why, so the admin can confirm/override before committing.
//
// Routing model (owner's choice: "both by default"):
//   - client-installable (Lua / pak / LogicMods)      -> BOTH  (runs on the server AND
//                                                         ships to clients — multiplayer
//                                                         mods generally must match)
//   - server-only (PalSchema data / UE4SS framework)  -> SERVER (nothing for a client to install)
//   - true client-only is NOT auto-detectable from a file list -> use the manual override.
import AdmZip from 'adm-zip'
import { detectModKind, archiveHasPalSchemaData, cleanModName, type DetectedKind } from '@/lib/game-mods'
import { classifyNames, zipUsesModConfig, type ClientModKind } from '@/lib/client-mods'

export type ModTarget = 'server' | 'client' | 'both'

export type ModSignals = {
  hasLua: boolean // /scripts/, /dlls/, .lua, main.dll → UE4SS Lua/DLL mod
  hasPalSchemaData: boolean // real .json(c) under PalSchema/mods/ → server-side data mod
  hasPak: boolean // .pak/.utoc/.ucas → content pak
  hasLogicMods: boolean // LogicMods/ → client-side blueprint/UI mod
  hasConfigMenu: boolean // ships an in-game Mod Config Menu (client-facing)
  isFomod: boolean // FOMOD variant installer → needs a manual choice
  hasEngineIni: boolean // only Engine.ini/text tweaks → not an installable mod
}

export type ModAnalysis = {
  kind: DetectedKind // 'ue4ss' | 'pak' | 'palschema' | null
  target: ModTarget // default routing (overridable in the UI)
  serverInstallable: boolean
  clientInstallable: boolean
  signals: ModSignals
  modName: string // best-guess display name
  reason: string // human explanation of the target choice
  warn: string | null // blocking-ish caveat (FOMOD, nothing installable) — still overridable
}

// Read entry names from a zip buffer (forward-slashed, files only). Empty on a bad archive.
function zipNames(buffer: Buffer): string[] {
  try {
    return new AdmZip(buffer)
      .getEntries()
      .filter((e) => !e.isDirectory)
      .map((e) => e.entryName.replace(/\\/g, '/'))
  } catch {
    return []
  }
}

const toClientKind = (k: DetectedKind): ClientModKind => (k === null ? 'unknown' : k)

// Analyze a normalized zip buffer. `nameHint` is a filename or Nexus/Workshop title used
// only to prettify the display name.
export function analyzeModArchive(buffer: Buffer, opts: { nameHint?: string } = {}): ModAnalysis {
  const names = zipNames(buffer)
  const kind = detectModKind(buffer)

  const lc = names.map((n) => n.toLowerCase())
  const signals: ModSignals = {
    hasLua: lc.some((l) => l.includes('/scripts/') || l.startsWith('scripts/') || l.includes('/dlls/') || l.startsWith('dlls/') || l.endsWith('.lua') || l.endsWith('/main.dll')),
    hasPalSchemaData: archiveHasPalSchemaData(buffer),
    hasPak: names.some((n) => /\.(pak|utoc|ucas)$/i.test(n)),
    hasLogicMods: lc.some((l) => l.includes('logicmods/')),
    hasConfigMenu: zipUsesModConfig(buffer),
    isFomod: names.some((n) => /(^|\/)fomod\/moduleconfig\.xml$/i.test(n)),
    hasEngineIni: names.length > 0 && names.every((n) => /engine\.ini|\.txt$/i.test(n)),
  }

  // Reuse the loadout's own placement rule: classifyNames returns null when the mod has
  // files a friend's client installs (Lua / pak / LogicMods), or a warning otherwise.
  const clientWarn = classifyNames(names, toClientKind(kind))
  const clientInstallable = clientWarn === null
  const serverInstallable = kind !== null

  let target: ModTarget
  let reason: string
  let warn: string | null = null

  if (signals.isFomod) {
    // FOMOD needs a manual variant pick; the server installer rejects it and it can't
    // auto-ship to a client loadout. Surface it and let the admin decide.
    target = clientInstallable ? 'both' : 'server'
    reason = 'FOMOD installer with multiple variants — pick a variant and stage it manually.'
    warn = clientWarn
  } else if (serverInstallable && clientInstallable) {
    target = 'both'
    reason = signals.hasPak && !signals.hasLua
      ? 'Content pak — must match on the server and every client, so it installs to both.'
      : signals.hasConfigMenu
        ? 'UE4SS Lua mod with an in-game config menu — runs on the server and ships to clients.'
        : 'UE4SS Lua mod — runs on the server and ships to clients (mods generally must match).'
  } else if (serverInstallable && !clientInstallable) {
    target = 'server'
    reason = signals.hasPalSchemaData
      ? 'PalSchema data mod — applied server-side; there are no files for a client to install.'
      : 'Server-side mod — nothing a client installs, so it stays on the server only.'
  } else if (!serverInstallable && clientInstallable) {
    // Rare: something a client installs but the server pipeline can't classify.
    target = 'client'
    reason = 'Client-installable files only — ships to clients.'
  } else {
    target = 'server'
    reason = 'No installable mod files detected.'
    warn = clientWarn ?? 'No installable mod files detected in this archive.'
  }

  const modName = cleanModName(opts.nameHint?.replace(/\.(zip|rar|7z|pak)$/i, '') || 'mod')

  return { kind, target, serverInstallable, clientInstallable, signals, modName, reason, warn }
}

// ── Description keyword mining ────────────────────────────────────────────────
// A mod page's own text is often the clearest signal of where it belongs ("client-side
// only", "must be installed on the server and all clients"). Parse a Nexus/Steam
// description for explicit placement statements and fold the result into the file-based
// analysis. Phrases are specific to avoid false positives on casual mentions.
export type DescriptionHint = {
  target: ModTarget | null // a clear placement statement, or null if ambiguous
  matched: string[] // the phrase(s) that matched, for the reason/UI
}

const BOTH_PHRASES = [
  'both server and client', 'both the server and', 'server and client', 'client and server',
  'install on both', 'on both the server', 'server and all clients', 'all clients and the server',
  'everyone must install', 'everyone needs to install', 'all players and the server',
]
const CLIENT_PHRASES = [
  'client-side only', 'client side only', 'client only', 'clients only', 'client-only',
  'each player must install', 'every player must install', 'all players must install',
  'players must install', 'players need to install', 'install on your client', 'install on the client',
  'not needed on the server', 'not required on the server', "doesn't need to be on the server",
  'does not need to be on the server', 'client-side mod', 'client side mod',
]
const SERVER_PHRASES = [
  'server-side only', 'server side only', 'server only', 'server-only',
  'only on the server', 'only needs to be on the server', 'only needs installing on the server',
  'dedicated server only', 'no client install', 'no client-side install', 'clients do not need',
  "clients don't need", 'not needed on the client', 'server-side mod', 'server side mod',
]

function firstMatch(text: string, phrases: string[]): string | null {
  for (const p of phrases) if (text.includes(p)) return p
  return null
}

export function analyzeDescription(text: string | null | undefined): DescriptionHint {
  if (!text) return { target: null, matched: [] }
  // Strip BBCode/HTML tags so phrases match across markup; collapse whitespace.
  const t = text.replace(/\[[^\]]*\]/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').toLowerCase()
  const both = firstMatch(t, BOTH_PHRASES)
  const client = firstMatch(t, CLIENT_PHRASES)
  const server = firstMatch(t, SERVER_PHRASES)
  if (both) return { target: 'both', matched: [both] }
  if (client && !server) return { target: 'client', matched: [client] }
  if (server && !client) return { target: 'server', matched: [server] }
  if (client && server) return { target: 'both', matched: [server, client] } // mentions both sides
  return { target: null, matched: [] }
}

// Fold a description hint into a file-based analysis. The author's explicit statement wins,
// but never past what's actually installable (can't ship to a client with no client files,
// can't run on the server with nothing server-installable).
export function applyDescriptionHint(analysis: ModAnalysis, hint: DescriptionHint): ModAnalysis {
  if (!hint.target || !hint.matched.length) return analysis
  let target = hint.target
  if (target === 'client' && !analysis.clientInstallable) target = analysis.serverInstallable ? 'server' : 'client'
  if (target === 'server' && !analysis.serverInstallable) target = analysis.clientInstallable ? 'client' : 'server'
  if (target === 'both' && !analysis.clientInstallable) target = 'server'
  if (target === 'both' && !analysis.serverInstallable) target = 'client'
  const note =
    target === hint.target
      ? `Mod page says “${hint.matched[hint.matched.length - 1]}” → ${target}.`
      : `Mod page says “${hint.matched[hint.matched.length - 1]}”, but the archive only supports ${target}.`
  return { ...analysis, target, reason: `${analysis.reason} ${note}` }
}
