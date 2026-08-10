# Scheduled broadcasts

Recurring in-game announcements that cycle through a message list on an interval — built into
the dashboard (like Nexus 2435), no mod required.

## Model
Mirrors the auto-backup / auto-restart schedulers: an in-process per-instance loop started
from `instrumentation.ts` on boot, settings persisted to `./data/broadcast-schedule.<id>.json`
(`default` keeps the base name). Ticks each minute and fires per instance when due (from
persisted `lastRunAt`, so it survives restarts).

- **Settings:** `enabled`, `intervalMinutes` (1–1440), `messages[]` (≤30, cycled SEQUENTIALLY),
  `prefix` (optional), `skipWhenEmpty` (don't announce to 0 players / a down server).
- **Send path:** RCON via the shared `lib/rcon-exec`. Uses **`pgbroadcast`** (PalDefender —
  supports spaces/multi-word) when PalDefender is enabled, else vanilla **`Broadcast`** (which
  truncates at the first space, so spaces → underscores). Non-ASCII stripped (it hangs RCON).
- **Rotation:** a persisted `nextIndex` cursor advances on each successful send; editing the
  message list resets it to the top.

## Pieces
- `lib/broadcast-schedule.ts` — schedule read/write, `runBroadcast`, `startBroadcastScheduler`.
- `app/api/broadcast-schedule/route.ts` — admin-only, instance-scoped GET/POST(save|test).
- `components/scheduled-broadcasts-card.tsx` — collapsible card on the Chat tab (admin-only):
  enable, interval, messages (one per line), prefix, skip-when-empty, Save + Test.
- `instrumentation.ts` — `startBroadcastScheduler()` at boot.

## Guards
Admin-tier only; interval/message count/length clamped; Test bypasses the interval + empty
gates (always sends the next message). Ships DISABLED.
