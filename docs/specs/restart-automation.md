# Spec: Server Restart Automation — full feature set, card placement

Extends item #6's built core (host memory publisher, monitor, ledger,
dry-run-verified trigger path). Design reference: palserver-gui's "Server
restart" tab (feature set only; no code, and we deliberately do NOT give
this a dedicated tab).

## Placement
0. **Rename the tab: "Saves & Backups" → "Maintenance".** Label/display
   text ONLY — keep the internal tab value (`saves` or whatever the
   union uses) unchanged so the type union, cast handlers, and any
   persisted localStorage tab value are untouched. If the label lives in
   more than one file (the live-map overlay duplicates the tab list),
   change every occurrence — display-string drift between the header
   and the overlay counts as a bug.
1. **Config card "Restart automation"** on the Maintenance tab,
   directly alongside the Auto-backup card (same visual pattern: master
   toggles, fields, Save settings / Reset). No new tab — do not touch the
   tab switcher at all.
2. **Overview status chip/card (read-only):** current game-container
   memory, auto-restarts used in the last hour (vs cap), next scheduled
   restart time if scheduling enabled. Click → Maintenance tab, restart card.
   Data comes from the existing metrics publisher + ledger; no new
   sources.

## Feature set (four groups in the one card)

**1. Scheduled restart** — master toggle, mode selector:
   - "Every N minutes" (interval field, min 30)
   - "Daily at fixed times" — one or MULTIPLE times of day (the
     reference sponsor-gates multiple times; we ship it ungated, one
     list input). Validate: dedupe, sort, 24h format.
   - Next-fire time computed and shown in the card + Overview chip.

**2. Memory threshold restart** — master toggle, threshold MB, and
   **consecutive breaches before restarting** (default 3, checked at the
   monitor's existing interval) — sustained-breach semantics so spikes
   don't trigger. If the built monitor lacks the consecutive-breach
   counter, add it; single-sample triggering is not acceptable.

**3. Crash auto-restart** — master toggle, max auto-restarts per hour
   (default 5). Existing semantics: manual stops (shutdown flag path)
   are NEVER counted as crashes or revived; cap hit → stop trying and
   surface it prominently (Overview chip goes warning-state). Include
   the start-then-fail guard: if the server exits during startup
   (PalDefender exitServerOnStartupFailure pattern), that consumes cap
   fast by design — the ledger must record cause per event so the
   history is diagnosable.

**4. Warning countdown** — seconds before any planned/scheduled/
   threshold restart (0 = none), reusing the handler's existing
   countdown broadcast. Crash restarts give no countdown (server is
   already gone) — note this in the field's help text. Broadcasts save
   the world first (existing handler behavior — verify, don't rebuild).

## Defaults
Scheduled restart: OFF. Memory threshold: OFF. Crash auto-restart: ON.
Countdown: 30s (inert until something is enabled). Rationale: surprise
restarts must be opt-in, especially for public release; the operator
flips on what they want. The monitor process may run always, but takes
no action while all toggles are off.

## Mechanics
- All settings persist like the auto-backup settings (./data), applied
  by the existing monitor without container rebuilds.
- Every trigger path goes through the existing restart.request flag →
  host handler. No new privileged paths.
- Ledger records every event: timestamp, cause (scheduled | memory |
  crash | manual), outcome. This is the future lifecycle-history card's
  data — keep the schema stable.
- K8s note for the spec record: the memory publisher and flag-file
  writes are the compose-driver pieces a future k8s runtime replaces;
  decision logic and this UI are runtime-agnostic.

## Acceptance
1. Tab reads "Maintenance" in the header AND the live-map overlay;
   internal tab value unchanged (no union/localStorage/cast-handler
   diffs). Card renders beside Auto-backup.
2. Fresh deploy: everything off; monitor idle; ledger untouched.
3. Scheduled: set "every 30 min" with countdown 10s on an empty server →
   fires with broadcast, ledger cause=scheduled, next-fire recomputed.
4. Memory: threshold below current + breaches=3 → no trigger until 3
   consecutive samples breach, then restart, cause=memory. One-sample
   spike (raise threshold after first breach) → no restart.
5. Manual stop while crash-restart armed → stays down, not counted,
   not revived (regression of the verified exclusion).
6. Cap: set cap=1, force two qualifying triggers → second is refused,
   Overview chip shows cap-hit warning state.
7. Overview chip numbers match ledger + metrics file.
