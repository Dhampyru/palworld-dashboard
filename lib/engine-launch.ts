// PATCH (not upstream): read-only view of the game server's performance LAUNCH
// FLAGS (roadmap #5 / engine-tuning-spec §1). Unlike Engine.ini, these are
// command-line args the GAME container's entrypoint.sh builds at process start,
// gated by two environment variables:
//
//   MULTITHREADING (default true)  -> -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS
//   COMMUNITY      (default false) -> EpicApp=PalServer
//
// The dashboard mounts the game server's own .env read-write (for the ServerName
// sync path), so we can report the CONFIGURED value here. We deliberately do NOT
// offer to change it: flipping these means editing the game server's env and
// recreating its container, which is server-config territory and outside this
// panel's security model. Display only.
//
// NOTE: NumberOfWorkerThreadsServer is often lumped in with these, but on this
// stack it is a PalWorldSettings.ini OptionSetting (a World setting), not a
// launch flag -- so it lives on the World tab, not here.

export type LaunchFlagState = {
  flag: string
  enabled: boolean
  description: string
}

export type LaunchInfo = {
  // MULTITHREADING / COMMUNITY as resolved (env value, or the entrypoint default
  // when the key is absent).
  multithreading: boolean
  communityMode: boolean
  flags: LaunchFlagState[]
  // false when the game .env could not be read (not mounted / demo): the values
  // above are then the entrypoint's own defaults, not a confirmed configuration.
  envReadable: boolean
}

export const LAUNCH_FLAGS_NOTE =
  'These are command-line flags the game server’s entrypoint passes at launch — set by the ' +
  'MULTITHREADING and COMMUNITY environment variables, not by Engine.ini. Post-1.0, Palworld ' +
  'changed its server threading and these UE flags are widely reported to make little difference ' +
  '(some operators see equal or better performance with them off). Changing them means editing ' +
  'the game server’s environment and recreating its container, so this panel only reports them. ' +
  'NumberOfWorkerThreadsServer is a World setting (PalWorldSettings.ini), not a launch flag.'

// Resolve a KEY from raw .env text. Tolerates surrounding whitespace, quotes,
// inline `#` comments, and duplicate keys (last occurrence wins, matching
// docker-compose's own env_file precedence). Returns undefined when absent so
// callers can apply the entrypoint's default.
export function parseEnvValue(envText: string, key: string): string | undefined {
  let found: string | undefined
  for (const line of envText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    if (trimmed.slice(0, eq).trim() !== key) continue
    let value = trimmed.slice(eq + 1).trim()
    // Strip a matching pair of surrounding quotes; only then drop an inline
    // comment (so a '#' inside a quoted value survives).
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
    if (quoted) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trim()
    }
    found = value
  }
  return found
}

// A .env boolean is "true"/"false" case-insensitively; anything else (or absent)
// falls back to the entrypoint default passed in.
function envBool(envText: string, key: string, fallback: boolean): boolean {
  const raw = parseEnvValue(envText, key)
  if (raw === undefined) return fallback
  return raw.toLowerCase() === 'true'
}

export function deriveLaunchInfo(envText: string, envReadable: boolean): LaunchInfo {
  // Defaults mirror scripts/entrypoint.sh: MULTITHREADING=true, COMMUNITY=false.
  const multithreading = envBool(envText, 'MULTITHREADING', true)
  const communityMode = envBool(envText, 'COMMUNITY', false)
  const flags: LaunchFlagState[] = [
    {
      flag: '-useperfthreads',
      enabled: multithreading,
      description: 'Dedicates extra worker threads to performance-critical tasks.',
    },
    {
      flag: '-NoAsyncLoadingThread',
      enabled: multithreading,
      description: 'Loads on the main thread instead of a separate async loading thread.',
    },
    {
      flag: '-UseMultithreadForDS',
      enabled: multithreading,
      description: 'Enables multithreading for the dedicated-server simulation.',
    },
    {
      flag: 'EpicApp=PalServer',
      enabled: communityMode,
      description: 'Lists the server in the in-game community server browser.',
    },
  ]
  return { multithreading, communityMode, flags, envReadable }
}
