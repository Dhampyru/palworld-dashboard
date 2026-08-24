// UE4SS ships these bundled by default with every install — they're framework
// plumbing (the Blueprint mod loader itself, the console enabler, etc.), not
// mods someone installed. The full Mods tab still lists them (it's the
// complete, accurate view) but labels them distinctly, since some of them
// (BPModLoaderMod especially) are load-bearing for other mods to function at
// all — disabling them isn't "cleaning up," it can silently break things.
export const UE4SS_FRAMEWORK_DEFAULTS: ReadonlyMap<string, string> = new Map([
  ['BPModLoaderMod', 'Loads Blueprint-based mods. Other installed mods may depend on this to function.'],
  ['BPML_GenericFunctions', 'Support library the Blueprint Mod Loader exposes to Blueprint mods.'],
  ['ConsoleEnablerMod', 'Enables the in-game developer console (normally stripped from shipping builds).'],
  ['ConsoleCommandsMod', 'Adds extra console commands on top of the base game\u2019s own set.'],
  ['CheatManagerEnablerMod', 'Enables cheat-manager commands (e.g. God, Fly) not normally available in a shipping build.'],
  ['Keybinds', 'Lets other mods register their own custom keybindings.'],
  ['LineTraceMod', 'Debug/utility mod for line-trace (raycast) inspection \u2014 mainly a development tool.'],
  ['SplitScreenMod', 'Relates to split-screen support \u2014 not relevant on a dedicated server.'],
  ['ActorDumperMod', 'Dumps actor/object data to file \u2014 a UE4SS development/diagnostic tool.'],
  ['jsbLuaProfilerMod', 'Lua performance profiler bundled with UE4SS \u2014 a development/diagnostic tool.'],
])

// PalDefender isn't a UE4SS default, but it's a protected BUILT-IN in the same
// sense: the Mods tab lists and toggles it, but it can't be "removed" here (it's
// the standalone d3d9 injection, managed/configured in the PalDefender tab).
const PALDEFENDER_BUILTIN_DESCRIPTION =
  "PalDefender's anti-cheat / admin protections (standalone d3d9 mod, not UE4SS). Toggle here; " +
  'configure it in the PalDefender tab. Disabling removes its protections after the next restart.'

export type ModKind = 'ue4ss' | 'pak' | 'paldefender' | 'palschema'

export function isFrameworkDefault(kind: ModKind, name: string): boolean {
  if (kind === 'paldefender') return true
  return kind === 'ue4ss' && UE4SS_FRAMEWORK_DEFAULTS.has(name)
}

export function frameworkDefaultDescription(kind: ModKind, name: string): string | null {
  if (kind === 'paldefender') return PALDEFENDER_BUILTIN_DESCRIPTION
  if (kind !== 'ue4ss') return null
  return UE4SS_FRAMEWORK_DEFAULTS.get(name) ?? null
}
