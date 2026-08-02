// SERVER-ONLY. Central instance resolver for multi-instance management
// (roadmap #7 — docs/specs/multi-instance-spec.md).
//
// Every server-side read of a per-server target (game REST URL, admin/RCON
// password, PalDefender endpoint, RCON host/port, game dir, game .env path,
// container name, lifecycle flag paths) routes through here, keyed by an
// instance id. The active instance is carried from the client in the
// `x-palworld-instance` header (see lib/palworld.ts); absent/`default` selects
// the live "Palkatraz" server.
//
// BACKWARD COMPATIBILITY: for the `default` instance this returns EXACTLY the
// values the code used before #7 (the same process.env reads + defaults), so
// nothing changes until a non-default instance is explicitly selected. The
// registry (/srv/palworld/registry.json) is only consulted for non-default
// instances, and only becomes readable inside the dashboard container once the
// Phase-2 mount lands — until then only `default` exists, which is correct.
//
// SECURITY: secrets are NEVER stored in the registry. Per-instance admin/RCON
// passwords live only in that instance's host-side .env (0660 root:2001) and are
// read on demand here.

import { readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'

export const DEFAULT_INSTANCE_ID = 'default'

const REGISTRY_PATH = process.env.PALWORLD_REGISTRY_PATH ?? '/srv/palworld/registry.json'

export interface InstancePorts {
  game: number
  query: number
  rcon: number
  rest: number
  paldefender: number
}

// One entry in registry.json (host-authored; the dashboard may rewrite it).
export interface InstanceRecord {
  id: string
  displayName: string
  seed?: boolean
  enabled?: boolean
  container: string
  composeDir: string
  gameDir: string
  envFilePath: string
  ports: InstancePorts
  rconHost?: string
  restUrl?: string
  paldefenderUrl?: string
  createdAt?: string
}

// The resolved, dashboard-facing view of an instance. For non-default instances
// these paths are the shared-mount paths that coincide host- and container-side;
// for `default` the filesystem paths are the container-view env values.
export interface ResolvedInstance {
  id: string
  displayName: string
  isDefault: boolean
  enabled: boolean
  restUrl: string
  paldefenderUrl: string
  rconHost: string
  rconPort: number
  gameDir: string
  envFilePath: string
  container: string
  composeDir: string
  ports: InstancePorts
}

export interface ResolvedSecrets {
  adminPassword: string
  paldefenderToken: string
}

export interface LifecyclePaths {
  runDir: string
  start: string
  shutdown: string
  restart: string
  shutdownCancel: string
  restartCancel: string
  metrics: string
}

// ─── env-derived defaults (today's behavior, verbatim) ──────────────────────

function envRestUrl(): string {
  return process.env.PALWORLD_REST_URL ?? 'http://127.0.0.1:8212'
}
function envPaldefenderUrl(): string {
  return process.env.PALDEFENDER_REST_URL ?? 'http://127.0.0.1:17993'
}
function envAdminPassword(): string {
  return process.env.PALWORLD_ADMIN_PASSWORD ?? process.env.PALWORLD_REAL_ADMIN_PASSWORD ?? ''
}
function envGameDir(): string {
  return process.env.PALWORLD_GAME_DIR ?? '/palworld'
}
function envServerEnvPath(): string {
  return process.env.PALWORLD_SERVER_ENV_PATH ?? '/palworld-server-env/.env'
}

function portFromUrl(url: string, fallback: number): number {
  try {
    const p = new URL(url).port
    return p ? Number(p) : fallback
  } catch {
    return fallback
  }
}

// Ports to DISPLAY for the default instance. The dashboard container does NOT
// carry the game's PORT/QUERY_PORT/REST_API_PORT env (its own PORT is 3000), so
// we must not read those. Prefer the registry's `default` entry (authored with
// the real ports); otherwise derive rest/paldefender from the pinned URLs, rcon
// from PALWORLD_RCON_PORT, and fall back to the stock game/query defaults.
function defaultPorts(): InstancePorts {
  const rec = readRegistry().find((r) => r.id === DEFAULT_INSTANCE_ID)
  if (rec?.ports) return rec.ports
  return {
    game: 8211,
    query: 27015,
    rcon: Number(process.env.PALWORLD_RCON_PORT ?? '25575'),
    rest: portFromUrl(envRestUrl(), 8212),
    paldefender: portFromUrl(envPaldefenderUrl(), 17993),
  }
}

function normalizeId(id?: string | null): string {
  const trimmed = (id ?? '').trim()
  return trimmed || DEFAULT_INSTANCE_ID
}

// The synthetic `default` record, built from env so it matches pre-#7 behavior
// regardless of what the registry says (the registry's default entry carries the
// HOST view used by the daemon; the dashboard uses the container view here).
function defaultResolved(): ResolvedInstance {
  return {
    id: DEFAULT_INSTANCE_ID,
    displayName: process.env.PALWORLD_SERVER_NAME ?? 'Palkatraz',
    isDefault: true,
    enabled: true,
    restUrl: envRestUrl(),
    paldefenderUrl: envPaldefenderUrl(),
    rconHost: process.env.PALWORLD_RCON_HOST ?? 'host.docker.internal',
    rconPort: Number(process.env.PALWORLD_RCON_PORT ?? '25575'),
    gameDir: envGameDir(),
    envFilePath: envServerEnvPath(),
    container: process.env.PALWORLD_DOCKER_CONTAINER ?? 'palworld-server',
    composeDir: process.env.PALWORLD_COMPOSE_DIR ?? '/root/palworld-server',
    ports: defaultPorts(),
  }
}

// ─── registry ───────────────────────────────────────────────────────────────

// Tolerant: a missing/unreadable/malformed registry yields no non-default
// instances (default still works entirely from env).
export function readRegistry(): InstanceRecord[] {
  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf8')
    const parsed = JSON.parse(raw) as { instances?: InstanceRecord[] }
    return Array.isArray(parsed.instances) ? parsed.instances : []
  } catch {
    return []
  }
}

function recordToResolved(rec: InstanceRecord): ResolvedInstance {
  const rconHost = rec.rconHost ?? 'host.docker.internal'
  return {
    id: rec.id,
    displayName: rec.displayName || rec.id,
    isDefault: rec.id === DEFAULT_INSTANCE_ID,
    enabled: rec.enabled !== false,
    restUrl: rec.restUrl ?? `http://${rconHost}:${rec.ports.rest}`,
    paldefenderUrl: rec.paldefenderUrl ?? `http://${rconHost}:${rec.ports.paldefender}`,
    rconHost,
    rconPort: rec.ports.rcon,
    gameDir: rec.gameDir,
    envFilePath: rec.envFilePath,
    container: rec.container,
    composeDir: rec.composeDir,
    ports: rec.ports,
  }
}

// The instance list for UI/monitoring: always includes `default` (env-derived,
// so it's correct even with no registry), plus every non-default registry entry.
export function listInstances(): ResolvedInstance[] {
  const out: ResolvedInstance[] = [defaultResolved()]
  for (const rec of readRegistry()) {
    if (rec.id === DEFAULT_INSTANCE_ID) continue
    out.push(recordToResolved(rec))
  }
  return out
}

export function getInstance(id?: string | null): ResolvedInstance | null {
  const wanted = normalizeId(id)
  if (wanted === DEFAULT_INSTANCE_ID) return defaultResolved()
  const rec = readRegistry().find((r) => r.id === wanted)
  return rec ? recordToResolved(rec) : null
}

// Primary resolver. Returns null only for a non-default id that isn't in the
// registry — callers treat that like a missing/unconfigured server.
export function resolveInstance(id?: string | null): ResolvedInstance | null {
  return getInstance(id)
}

// ─── secrets (read on demand; never from the registry) ──────────────────────

// Minimal KEY=VALUE .env parser (same shape the game .env uses); strips a
// surrounding pair of quotes. Not a full dotenv implementation on purpose.
function readEnvValue(filePath: string, key: string): string {
  try {
    const raw = readFileSync(filePath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() !== key) continue
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      return value
    }
  } catch {
    /* fall through */
  }
  return ''
}

export function resolveSecrets(id?: string | null): ResolvedSecrets {
  const wanted = normalizeId(id)
  if (wanted === DEFAULT_INSTANCE_ID) {
    return { adminPassword: envAdminPassword(), paldefenderToken: process.env.PALDEFENDER_REST_TOKEN ?? '' }
  }
  const inst = getInstance(wanted)
  if (!inst) return { adminPassword: '', paldefenderToken: '' }
  // Per-instance admin password lives in the instance's own .env. The
  // per-instance PalDefender token is resolved from its RESTAPI/Tokens later
  // (Phase 5); until then non-default PalDefender degrades to "absent", exactly
  // like a server without PalDefender.
  return {
    adminPassword: readEnvValue(inst.envFilePath, 'ADMIN_PASSWORD'),
    paldefenderToken: '',
  }
}

// ─── RCON (replaces the body of lib/rcon-exec.ts getRconConfig) ─────────────

export function resolveRcon(id?: string | null): { host: string; port: number; password: string } | null {
  const inst = resolveInstance(id)
  if (!inst) return null
  const { adminPassword } = resolveSecrets(id)
  if (!adminPassword) return null
  return { host: inst.rconHost, port: inst.rconPort, password: adminPassword }
}

// ─── lifecycle flag-file paths ──────────────────────────────────────────────
// `default` keeps today's FLAT paths (env-overridable) so the existing systemd
// units keep working until the Phase-3 cutover. Non-default instances use the
// per-instance /run/palworld/<id>/ subdir the control daemon watches.

const RUN_DIR = process.env.PALWORLD_RUN_DIR ?? '/run/palworld'

// Per-instance runtime metrics written by the host publisher (Phase 4). Used
// by the list endpoint / switcher to show live status. Null when unavailable.
export interface InstanceMetrics {
  present: boolean
  status: string
  startedAt?: string
  memBytes?: number | null
  memPercent?: number | null
  cpuPercent?: number | null
  ts?: string
}

export function readInstanceMetrics(id?: string | null): InstanceMetrics | null {
  try {
    const { metrics } = resolveLifecyclePaths(id)
    const raw = JSON.parse(readFileSync(metrics, 'utf8')) as Partial<InstanceMetrics>
    return {
      present: raw.present ?? false,
      status: typeof raw.status === 'string' ? raw.status : 'unknown',
      startedAt: raw.startedAt,
      memBytes: raw.memBytes ?? null,
      memPercent: raw.memPercent ?? null,
      cpuPercent: raw.cpuPercent ?? null,
      ts: raw.ts,
    }
  } catch {
    return null
  }
}

export function resolveLifecyclePaths(id?: string | null): LifecyclePaths {
  const wanted = normalizeId(id)
  if (wanted === DEFAULT_INSTANCE_ID) {
    return {
      runDir: RUN_DIR,
      start: process.env.PALWORLD_START_REQUEST_PATH ?? `${RUN_DIR}/start.request`,
      shutdown: process.env.PALWORLD_SHUTDOWN_REQUEST_PATH ?? `${RUN_DIR}/shutdown.request`,
      restart: process.env.PALWORLD_RESTART_REQUEST_PATH ?? `${RUN_DIR}/restart.request`,
      shutdownCancel: `${RUN_DIR}/shutdown.cancel`,
      restartCancel: `${RUN_DIR}/restart.cancel`,
      metrics: process.env.PALWORLD_METRICS_FILE ?? `${RUN_DIR}/metrics.json`,
    }
  }
  const dir = `${RUN_DIR}/${wanted}`
  return {
    runDir: dir,
    start: `${dir}/start.request`,
    shutdown: `${dir}/shutdown.request`,
    restart: `${dir}/restart.request`,
    shutdownCancel: `${dir}/shutdown.cancel`,
    restartCancel: `${dir}/restart.cancel`,
    metrics: `${dir}/metrics.json`,
  }
}

// ─── game-data extraction paths (usmap upload → datasets/icons) ──────────────
// The dashboard uploads a usmap and reads extracted datasets/icons under the
// shared /srv/palworld mount (same path host + container); the control daemon
// runs the extractor and writes the output there. Request/status ride the same
// per-instance runDir as lifecycle (flat for `default`).
const SRV_ROOT = process.env.PALWORLD_SRV_ROOT ?? '/srv/palworld'

export interface GameDataPaths {
  dir: string
  usmapPath: string
  dataDir: string
  iconsDir: string
  request: string
  status: string
  runDir: string
}

export function resolveGameDataPaths(id?: string | null): GameDataPaths {
  const wanted = normalizeId(id)
  const { runDir } = resolveLifecyclePaths(wanted)
  const dir = `${SRV_ROOT}/gamedata/${wanted}`
  return {
    dir,
    usmapPath: `${dir}/mappings.usmap`,
    dataDir: `${dir}/data`,
    iconsDir: `${dir}/icons`,
    request: `${runDir}/gamedata.request`,
    status: `${runDir}/gamedata.status`,
    runDir,
  }
}

// ─── request-scoped active instance (AsyncLocalStorage) ─────────────────────
// Filesystem-backed libs (saves, game-mods, palworld-settings, engine-tuning,
// paldefender-config, chat) resolve their game dir / env file / REST target from
// the instance active for THIS request, without threading an id through every
// function. An API route wraps its handler in runWithInstance(headerId, ...);
// the libs read currentGameDir()/currentEnvFilePath()/currentRestConfig(). With
// no store set (background tasks) or an absent header, everything resolves to
// `default` — exactly the pre-#7 behavior.
const instanceStore = new AsyncLocalStorage<string>()

export function runWithInstance<T>(id: string | null | undefined, fn: () => T): T {
  return instanceStore.run(normalizeId(id), fn)
}

export function currentInstanceId(): string {
  return instanceStore.getStore() ?? DEFAULT_INSTANCE_ID
}

export function currentGameDir(): string {
  return resolveInstance(currentInstanceId())?.gameDir ?? envGameDir()
}

export function currentEnvFilePath(): string {
  return resolveInstance(currentInstanceId())?.envFilePath ?? envServerEnvPath()
}

// REST base URL + admin password for the active instance (used by lib/saves
// getServerMetrics/isGameServerUp, which talk to the game REST directly).
export function currentRestConfig(): { restUrl: string; adminPassword: string } {
  const id = currentInstanceId()
  const inst = resolveInstance(id)
  return {
    restUrl: inst?.restUrl ?? envRestUrl(),
    adminPassword: resolveSecrets(id).adminPassword,
  }
}
