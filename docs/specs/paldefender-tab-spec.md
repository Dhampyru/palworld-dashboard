# Spec: PalDefender (Anti-cheat) Tab + Player Quick Actions

Design reference: palserver-gui's "Anti-cheat plugin" page (text extracted
from operator's reference captures; design-only, no code from that
project). Two deliverables: (A) a new tab managing PalDefender's own
config, (B) per-player quick actions on the roster that deep-link into the
existing RCON console.

---

## A. PalDefender tab

### A0. Pre-flight (before code)
Locate PalDefender's actual config file inside the production container
(under `Pal/Binaries/Win64/ue4ss/Mods/PalDefender/…`), dump its current
JSON, and report which of the keys below exist in our installed version
(1.8.x) — the reference UI may include keys from other versions. Build the
panel schema from what's actually present; unknown keys in the file are
preserved untouched (same discipline as Engine.ini / world settings).

### A1. Panel sections and keys (from reference; verify each in A0)

**Status header** — PalDefender version (from RCON `version`), enabled
state. Version *management* (update/install-beta buttons in the
reference) is OUT OF SCOPE v1 — updating the mod is what the existing
Mods tab is for; link to it instead.

**Anti-cheat actions**
- `shouldWarnCheaters` — warn player on detection
- `shouldWarnCheatersReason` — include reason in warning
- `shouldKickCheaters` — auto-kick
- `shouldBanCheaters` — auto-ban
- `shouldIPBanCheaters` — auto IP-ban (warning note: IP bans can hit
  other players behind the same IP)

**Exploit protection**
- `steamidProtection` — prevent duplicate-UserId logins
- `blockTowerBossCapture` — forbid catching tower bosses
- `disableIllegalItemProtection` — DANGER framing: when on, modded/debug
  items are no longer blocked; generally not recommended
- `doActionUponIllegalPalStats` — auto-fix abnormal Pal stats
- `palStatsMaxRank` — enhancement cap (-1 = auto-detect)

**PvP / PvE limits**
- `pvpMaxToBuildingDamage` (0 = unlimited)
- `pvpMaxToPlayerDamage` (0 = unlimited; beta-flagged in reference)
- `pvpMaxToPalDamage` (0 = unlimited)
- `pveMaxToPalBanThreshold` (0 = off)
- `treeLimiter` — min seconds per felled tree, anti-lag (0 = off)

**Whitelist & admins** (added 2026-07-22 — reference bottom half, all present in 1.8.3)
- `useWhitelist` — WARNING: enabling with an empty whitelist locks everyone out
- `useAdminWhitelist`; `adminAutoLogin`; `preventAdminPasswordInChat`
- `allowAdminCheats` — DANGER: off disables the console cheat commands +
  roster quick-actions. The console/roster gating reads this flag LIVE
  (`/api/rcon` re-reads Config.json each call), so editing it here reflects on
  the next console/roster fetch. Takes effect in-game after Apply now.
- `allowGodmodeOnehit`

**Chat** — `chatBypassWait`, `chatMessageMaxLen`

**Announcement** — all `announce*` flags present, plus
`dontAnnounceAdminConnections` (belongs to this group though it lacks the
prefix): `announceConnections`, `announcePunishments`, `announcePlayerDeaths`,
`announceOpenOilrigBoxes`, `announceHelicopterKills`, `announcePlayerSummons`,
`announceAdminSummons`, `announceAdminSummonsKill`.

**Logs** — all `log*` flags present (15): networking, chat, RCON, player
UID/IP/deaths/logins/buildings/summons/captures, helicopter kills, craftings,
tech unlocks, oil-rig box opens, networking-to-console.

**Misc** — `exitServerOnStartupFailure` (note: keep on, else a broken config
can restart-loop the container), `disableButchering`, `disableRenaming`,
`disablePalRenaming`, `OilrigGoalBoxLocktime`, `RCONTimeout`,
`RCONUsePacketIdFix`.

**Array-valued keys stay RAW-EDITOR-ONLY in v1**: `adminIPs`, `bannedChatWords`,
`bannedNames`, `adminCheats`, `bannedTechnologies`. Also unmanaged (present but
not on the reference page / not requested): `RCONbase64`, `whitelistMessage`,
`preventUnsupportedWorkbenchRecipes`, `preventDoctorSurgiExploit`,
`doActionUponDoctorSurgiExploit`. All preserved byte-for-byte by the writer.

**Settings search** — the panel now has 50+ settings, so a search box filters
the field groups by label AND raw key (MOTD/REST show when the query is empty
or matches their keywords).

**MOTD** — multiline editor, one message per line, empty = disabled.
Supports placeholders (`{PlayerName}`, `{ServerName}`, config-value
tokens) — pass through verbatim, no client-side validation of tokens.

**PalDefender REST API** (config keys as found in A0: enable flag, port —
reference default 17993, access token)
- Token treated as a secret: masked display with eye toggle + copy
  (reuse the clipboard util), regenerate action if PalDefender supports
  it via config.
- This API is the enabler for a FOLLOW-UP feature (not this spec):
  per-player Pals/inventory viewer — partial recovery of the roadmap's
  dead save-inspection item, no Level.sav parsing needed. Record that in
  CLAUDE.md's roadmap when this lands.

**Edit raw Config.json** — same modal raw-editor pattern as Engine.ini
(§6 of the engine-tuning spec): verbatim view/save via temp+rename,
confirm on save, admin-only, demo stubbed. JSON-validate before save and
refuse to write malformed JSON (unlike ini, a syntax error here can kill
the mod's config load).

### A2. Apply semantics
Staged apply identical to the engine-tuning spec §4: nothing writes until
Save; sticky unsaved-changes bar with Reset / Save. After save, offer TWO
apply paths reflecting PalDefender's actual behavior:
- **"Apply now (reloadcfg)"** — runs PalDefender's `reloadcfg` via the
  shared RCON transport; per the reference, config + MOTD take effect on
  reloadcfg without a restart.
- Note which settings (if any, per A0 findings/PalDefender docs) require
  a full restart; surface "takes effect after restart" only for those.

### A2a. Snapshot before write (shared, 2026-07-22)
Config.json saves go through the shared `lib/config-write.ts`
(`writeConfigFileWithBackup`): timestamped `Config.json.<stamp>.bak` sibling
before each write, newest 10 kept. Same helper backs Engine.ini and
PalWorldSettings.ini. The raw editor's JSON-validate-then-write also goes
through it, so a rejected malformed save never reaches the backup step.

### A3. Tab wiring — read CLAUDE.md's tab-hazard note
This adds a seventh tab. The tab list spans three files with FOUR edit
spots each (union, TabsTrigger, onValueChange, dashboard.tsx extras) and
the onValueChange handlers are now direct casts — do not reintroduce
ternary chains. The Guilds/Engine dead-tab bug came from exactly this.
Graceful degradation: if PalDefender isn't detected (reuse the console's
detection), the tab renders a "PalDefender not detected" state, not a
broken panel.

## B. Player quick actions (roster dropdown)

Extend the existing per-player roster action (currently "Console") into a
small dropdown menu. Each action opens the RCON console with the player
prefilled AND the named command preselected — same entry-point mechanism
the console already has, plus one parameter (initial command):
- Give Pal → `givepal`
- Give Pal Egg → `giveegg`
- Give Item → `give`
- Teleport → `tp` (or verified equivalent from the registry)
- Kick → `kick`
- Ban → `ban` (danger styling; the console's existing confirm still
  gates the actual send)
Menu shows only commands available in the current gating state (PalDefender
detected, admin cheats enabled). No new execution paths — everything still
flows through the console UI and its confirms.

## Acceptance
1. A0 report delivered before any UI code.
2. Toggling e.g. `shouldKickCheaters` and saving changes exactly that key
   in Config.json; unknown keys byte-preserved; malformed-JSON save is
   refused in the raw editor.
3. "Apply now" runs reloadcfg and the change is observable (e.g. MOTD
   text changes on next join) without a restart.
4. Token is masked by default, copyable while masked.
5. Roster "Give Pal" opens the console with the player prefilled and
   givepal selected; running it delivers in-game.
6. With PalDefender absent (simulated), tab shows the not-detected state
   and roster menu collapses to vanilla actions.
7. Tab click navigates (regression-check the other six while at it).
