# Auto-restart logic (roadmap #6)

*Status: IN PROGRESS (2026-07-26). Decision: option (a) — host publishes raw metrics,
the dashboard owns all decision logic.*

## Goal

Automatically restart the game server when it is **unhealthy** — a hang/crash-loop, or
memory over a threshold — while:

- **never** counting an operator's manual stop as a crash,
- enforcing an **hourly cap** so a broken server can't restart-loop forever,
- reusing the existing restart path (flag file → host systemd → `docker compose up -d
  --force-recreate`), adding no new privilege to the dashboard.

## Why the split (host publisher + dashboard brain)

The dashboard container has **no Docker socket, no sudo, and no access to the game
container's cgroup** (deliberate security model). The game's REST metrics expose FPS /
players / frametime but **not memory**. So memory/CPU must be *observed* on the host. To
keep all policy in one place (and UI-configurable), the host only **publishes raw numbers**;
the dashboard reads them and makes **every** decision.

```
 ┌────────────────────────┐        writes         ┌───────────────────────────┐
 │ host: metrics publisher │ ───────────────────▶ │ /run/palworld/metrics.json │
 │ (systemd, reads cgroup  │   every ~10s          └───────────────────────────┘
 │  + docker inspect)      │                                    │ reads (ro mount)
 └────────────────────────┘                                    ▼
                                          ┌─────────────────────────────────────┐
                                          │ dashboard: auto-restart monitor       │
                                          │  (in-process, instrumentation-started)│
                                          │  • REST health probe (hang/crash)     │
                                          │  • memory threshold (from metrics.json)│
                                          │  • hourly cap                          │
                                          │  • manual-stop exclusion               │
                                          └───────────────┬─────────────────────┘
                                                          │ writes when it decides
                                                          ▼
                                    /run/palworld/restart.request  → existing systemd unit
```

## Host publisher — data contract

`scripts/palworld-metrics-publisher.sh` (tracked in the config repo, installed to
`/usr/local/bin/`), run by `palworld-metrics.service` (Type=simple, Restart=always) as a
persistent loop. cgroup **v2**. It resolves the container's cgroup via
`/proc/<pid>/cgroup` (driver-agnostic — no path guessing), reads `memory.current` /
`memory.max` and a `cpu.stat` `usage_usec` delta, and `docker inspect` for status /
restartCount / startedAt. Writes atomically (temp + rename), `0644` so uid 2001 can read.

`/run/palworld/metrics.json`:

```json
{
  "schemaVersion": 1,
  "ts": "2026-07-26T01:00:00Z",
  "container": "palworld-server",
  "present": true,            // docker inspect succeeded
  "status": "running",        // docker State.Status (running|exited|absent|...)
  "startedAt": "2026-...Z",   // for restart/uptime detection
  "restartCount": 0,          // Docker restart-policy count (its OWN restarts)
  "memBytes": 1234567890,     // null if container not running
  "memLimitBytes": 8589934592,// null if unlimited (then percent is null)
  "memPercent": 14.4,         // memBytes/memLimit*100, null if no limit
  "cpuPercent": 22.1,         // delta since last tick; null on first sample
  "intervalSeconds": 10,
  "publisher": "palworld-metrics-publisher/1"
}
```

`null` numeric fields mean "unknown this tick" (e.g. container down) — the dashboard must
treat unknown memory as *not over threshold*, never as 0-or-over.

## Dashboard monitor — decision logic (owns everything)

In-process (`lib/auto-restart.ts`, started by `instrumentation.ts` alongside the
auto-backup scheduler). Ticks ~every 30s. On each tick, in order:

1. **Load settings.** If disabled, do nothing.
2. **Manual-stop exclusion.** If a `shutdown.request` (or a recent operator restart) is
   present in `/run/palworld/`, the server being down is intentional → never restart. A
   manual stop clears any pending crash streak.
3. **Hourly cap.** If restarts triggered in the last 60 min ≥ cap, do nothing but record
   "capped".
4. **Crash / hang.** Combine the dashboard's own authenticated REST probe with
   `metrics.status`: if the container is `running` but the REST has failed for N
   consecutive checks (hang), or `status=exited` with no manual-stop flag (crash Docker
   didn't recover), trigger.
5. **Memory threshold.** If `memPercent` (or an absolute `memBytes` ceiling) is over the
   configured limit for N consecutive checks, trigger.
6. **Trigger** = write `/run/palworld/restart.request` (same JSON the manual restart route
   writes), record the timestamp in the cap ledger + `lastAction`.

Settings (persisted to `./data/auto-restart.json`, like the backup schedule):
`enabled`, `memoryPercent` (or `memoryMb`), `sustainedChecks`, `hangChecks`,
`maxPerHour`, plus read-only `lastActionAt` / `lastReason` / recent-trigger ledger.

An API route (`app/api/auto-restart`, admin-only) exposes GET settings+status and POST
save|test (Test forces one restart-request, respecting nothing but auth, to prove the
wiring). A card in the UI mirrors the auto-backup card.

## What a future k8s driver replaces

The design is deliberately two swappable adapters around a fixed **decision core**:

| Concern | Bare-metal today | Kubernetes driver |
|---|---|---|
| **Metrics source** | host publisher → `/run/palworld/metrics.json` | a **metrics API** (metrics-server / pod `/metrics` / Prometheus query) the dashboard polls |
| **Restart actuator** | `restart.request` flag file → systemd → `docker compose up -d --force-recreate` | k8s API: delete the pod / roll the Deployment |
| **Decision core** | `lib/auto-restart.ts` (thresholds, cap, manual-stop exclusion) | **unchanged** |

So porting to k8s = replace the *publisher* with a metrics-API client and the *flag-file
writer* with a k8s-API call; the thresholds/cap/exclusion logic stays put. Keep the
metrics.json schema as the internal shape both sources normalize into.

## Build order

1. ~~Decision + spec~~ (this doc).
2. Host publisher script + `palworld-metrics.service`; install, verify `metrics.json`.
3. Dashboard monitor + settings + API route.
4. UI card (Auto-restart).
5. Verify end-to-end (hang + memory + cap + manual-stop exclusion), ship **disabled** by
   default like auto-backup.
