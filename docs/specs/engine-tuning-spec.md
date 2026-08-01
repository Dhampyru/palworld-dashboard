# Spec: Engine Tuning & Performance Presets (CORRECTION)

Supersedes any prior understanding of "performance presets." The presets do
NOT touch `PalWorldSettings.ini` or the world-settings pipeline. They manage
**`Pal/Saved/Config/WindowsServer/Engine.ini`** — Unreal engine/network
tuning — as a separate tab/panel ("Engine tuning"), mirroring the reference
GUI's behavior (design reference only; no code from palserver-gui).

First task: audit what the currently-built presets card actually writes. If
it writes PalWorldSettings values, that implementation is mis-targeted and
gets rebuilt against this spec.

---

## 1. Managed settings (the panel owns exactly these keys)

Section headers are VERIFIED from a real post-preset Engine.ini (operator
supplied) — use exactly these, no research needed:

- `[/Script/OnlineSubsystemUtils.IpNetDriver]` → NetServerMaxTickRate,
  MaxClientRate, MaxInternetClientRate, ConnectionTimeout,
  InitialConnectTimeout
- `[/Script/Engine.Engine]` → bUseFixedFrameRate, FixedFrameRate,
  bSmoothFrameRate
- `[/Script/Engine.GarbageCollectionSettings]` →
  gc.TimeBetweenPurgingPendingKillObjects

Value formatting (match the observed file exactly): timeouts and
FixedFrameRate are floats written as `60.000000`; booleans are `True` /
`False` (capitalized); tick rate, client rates, and gc interval are bare
integers. Note the reference writes FixedFrameRate even when
bUseFixedFrameRate=False (inert but present) — mirror that.

**Network**
- `NetServerMaxTickRate` — server tick rate (updates/sec)
- `MaxClientRate` — per-player bandwidth cap, bytes/s (show ≈ Mbps hint)
- `MaxInternetClientRate` — same for non-LAN players
- `ConnectionTimeout` (s)
- `InitialConnectTimeout` (s)

**Frame rate**
- `bUseFixedFrameRate` (bool)
- `FixedFrameRate` (only meaningful when the bool is on; usually = tick)
- `bSmoothFrameRate` (bool)

**Memory**
- `gc.TimeBetweenPurgingPendingKillObjects` (s)

**Launch flags (display-only, now sourced live)** — command-line args, not
ini keys. In our stack the game container's `entrypoint.sh` builds them from
two env vars: `MULTITHREADING` (default true → `-useperfthreads
-NoAsyncLoadingThread -UseMultithreadForDS`) and `COMMUNITY` (default false →
`EpicApp=PalServer`). The panel reads the game server's `.env` (already mounted
read-write for the ServerName sync) via the engine-tuning GET's `launch` field
(`lib/engine-launch.ts`) and shows each flag's real on/off, falling back to the
entrypoint defaults with a badge when the `.env` isn't readable. Still
**display-only**: changing these means editing the game env and recreating the
container, out of scope for this panel. Note `NumberOfWorkerThreadsServer` was
dropped — on this stack it's a PalWorldSettings.ini OptionSetting (a World
setting), not a launch flag, so listing it here was wrong. The post-1.0 note
(these UE flags often make little difference on 1.0+) stays.

## 2. Preset values (extracted from reference, verified per-preset)

| Key | Game defaults | Balanced | High performance |
|---|---|---|---|
| NetServerMaxTickRate | 30 | 60 | 90 |
| MaxClientRate | 15000 | 100000 | 150000 |
| MaxInternetClientRate | 10000 | 100000 | 150000 |
| ConnectionTimeout | 60 | 60 | 60 |
| InitialConnectTimeout | 60 | 60 | 60 |
| bUseFixedFrameRate | off | off | **on** |
| FixedFrameRate | 30 | 60 | 90 |
| bSmoothFrameRate | off | **on** | **on** |
| gc.TimeBetween… | 60 | 60 | 30 |

**Apply semantics — critical:** "Game defaults" does not write the column-1
values; it **removes every managed key from Engine.ini**, letting the
engine fall back to built-ins (the column shows what those built-ins are,
for display). Balanced/High performance write their values explicitly.
Non-managed keys and unrelated sections in Engine.ini must be preserved
byte-for-byte — same temp-file+rename discipline as the settings tokenizer.
The stock file ships with a large `[Core.System]` section (~70 `Paths=`
lines for engine/plugin content); this must survive every operation
untouched, including its repeated `Paths=` keys (duplicate keys are legal
INI here — the writer must not dedupe, reorder, or collapse them).

**Pre-flight (before any code writes):** read the production container's
current `Engine.ini`, record whether it exists, is stock, or already
carries tuning values, and design for all three states: file present
(merge managed keys into existing sections, creating a section only if
absent), file missing (create it with managed sections only), file already
tuned (overwrite managed keys in place).

## 3. Preset button copy (user-facing)

- **Game defaults** — "Clears everything this panel manages so the server
  falls back to built-in engine defaults (30 tick). The safe baseline —
  and the undo button if tuning made things worse."
- **Balanced (recommended)** — "The community-standard tune: 60 tick,
  roomier bandwidth caps, smoothed frame pacing. Noticeably smoother for
  most servers at modest CPU cost."
- **High performance** — "90 tick with fixed + smoothed frame pacing and
  faster garbage collection. For strong single-core CPUs and few players.
  Watch server FPS after applying — a CPU that can't hold the tick makes
  this *worse* than Balanced, not better."

Panel header keeps the honest framing: settings write to Engine.ini; no
silver bullet; higher tick costs CPU; watch server FPS after changes.
Per-field warning notes from the reference worth keeping (reworded): tick
not recommended above 120 and below 50 hurts game feel; total upload ≈
per-player cap × online players, exceeding real upload capacity lags
everyone; fixed frame rate interacts with tick and can slow simulation on
weak hardware.

## 4. Staged apply — nothing writes to disk until Save

Presets and fields follow the same edit→review→save flow as the
world-settings panel:

1. Clicking a preset opens a confirm dialog: title `Apply "<Preset
   name>"?`, body = that preset's descriptor (§3 copy), plus the line
   "This overwrites the fields below — nothing is written to disk until
   you save." OK stages the values into the form; Cancel does nothing.
2. Any staged difference from disk state raises a sticky bottom bar that
   follows scroll: `Careful — N unsaved changes! (take effect after
   restart)` with two actions: **Reset** (discard staged edits, restore
   disk values) and **Save changes** (write Engine.ini via temp+rename).
   N counts changed fields, live.
3. Individual field edits stage the same way — preset click and manual
   edit are the same pipeline, differing only in how many fields they
   stage at once.
4. Only Save touches disk; only after Save does the restart notice apply.
   Preset-active/"Custom" detection (below) compares **disk** state, with
   staged-but-unsaved state reflected in the bar, not the preset
   highlight.

## 5. Individual field editing

Each managed key is editable individually (same slider+number pattern as
world settings). Applying a preset sets the fields; fields can then be
tweaked and saved. UI must show which preset matches current state, or
"Custom" when none does.

## 6. Raw file editor

Add an "Edit raw file" affordance (reference has it; we lack it): opens the
current Engine.ini text in a modal editor, save writes the file verbatim
via temp+rename after a confirm. Admin-tier only, demo-mode stubbed. This
doubles as the escape hatch for keys the panel doesn't manage.

## 7. Restart semantics

Engine.ini is read at server start. After any save (preset, field, or raw),
surface: "Saved — takes effect on next server restart," with a Restart
button wired to the existing host-integration restart route. Never
auto-restart.

## 7a. Snapshot before write (shared, 2026-07-22)

Every config save now goes through the shared `lib/config-write.ts`
(`writeConfigFileWithBackup`): it copies the current file to a timestamped
`<file>.<stamp>.bak` sibling (keeping the newest 10, pruning older) before the
atomic temp+rename. Applies here to Engine.ini, and equally to
PalWorldSettings.ini and PalDefender Config.json. NOT to `.env` or token files
— backups are plaintext siblings and must not sprawl a secret. `.bak` files are
git-ignored and blocked by the config-repo pre-commit hook.

## 8. Acceptance

1. Applying Balanced then diffing the in-container Engine.ini shows exactly
   the managed keys changed, everything else byte-identical.
2. Game defaults removes all managed keys (verify by grep absence), not
   writes of 30/15000/etc.
3. Panel state detection: after Balanced, panel shows Balanced active;
   after hand-editing one field, shows Custom.
4. Raw editor round-trips an untouched file byte-identically.
5. Restart notice appears after every save path.
6. Preset click stages values without any disk write (verify mtime
   unchanged until Save); the unsaved-changes bar shows a correct live
   count; Reset restores disk values exactly.
7. World-settings pipeline untouched by all of the above.
