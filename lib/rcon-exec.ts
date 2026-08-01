// SERVER-ONLY. Shared RCON transport, extracted from app/api/rcon/route.ts so
// that route and the PalDefender export routes send commands the same way
// instead of each growing its own copy.
//
// Shells out to the gorcon/rcon-cli binary in the image rather than using a JS
// RCON library: Palworld assigns response packet IDs in a way that is not
// strictly Source-RCON-spec compliant, which makes the `rcon-client` npm
// package hang waiting for a response it never matches to its request. Do not
// "simplify" this back to a JS library.
//
// SECURITY: host, port and the real AdminPassword are pinned server-side from
// env and never accepted from a client, the same SSRF-prevention pattern the
// REST proxy uses.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveRcon } from '@/lib/instances'

const execFileAsync = promisify(execFile)

export type RconConfig = { host: string; port: number; password: string }

// Resolves host/port/password for the given instance (default when omitted).
// Delegates to the central resolver so multi-instance (#7) routes all share one
// source of truth; for `default` this returns exactly the previous env values.
export function getRconConfig(instanceId?: string | null): RconConfig | null {
  return resolveRcon(instanceId)
}

// Passed as a single argv element (execFile, no shell), so multi-word commands
// arrive at the binary intact.
export async function runRcon(config: RconConfig, command: string, timeoutMs = 8000): Promise<string> {
  const { stdout } = await execFileAsync(
    'rcon',
    ['-a', `${config.host}:${config.port}`, '-p', config.password, '-T', '5s', command],
    { timeout: timeoutMs },
  )
  return stdout.trim()
}

// child_process errors carry .stdout/.stderr beyond the standard Error shape
// when execFile rejects on a non-zero exit -- surface those rather than the
// generic "Command failed".
export function extractProcessOutput(error: unknown): string {
  if (error && typeof error === 'object') {
    const withOutput = error as { stderr?: unknown; stdout?: unknown }
    const stderr = typeof withOutput.stderr === 'string' ? withOutput.stderr.trim() : ''
    const stdout = typeof withOutput.stdout === 'string' ? withOutput.stdout.trim() : ''
    if (stderr) return stderr
    if (stdout) return stdout
  }
  return error instanceof Error ? error.message : 'unknown error'
}
