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

## On-join welcome (the one thing BroadcastServerNotice had that we didn't)
Event-driven, independent of the interval rotation. When a new player joins, broadcast
`welcomeMessages[]` in order (supports a `{name}` placeholder → the joining player's name).
- **Join detection:** `runWelcome(id)` reads the game stdout log via `lib/chat-source`
  `readChatLog()` (same source the Chat tab uses) and parses join lines with two regexes
  (`JOIN_RES`): PalDefender's `[HH:MM:SS][info] 'Name' (UserId=…) has logged in.` (the line
  that carries the DISPLAY name here — the plain `steam_… connected to the server.` line has
  only the SteamID and is skipped) and the native `[ts] [LOG] Name … joined/connected the
  server.`.
- **Dedup by signature, not a timestamp cursor:** the read is a sliding 512KB tail
  (`PALWORLD_CHAT_LOG_MAX_BYTES`) and PalDefender timestamps are time-only (no date → not
  globally sortable across midnight). So the scheduler keeps a bounded set of `ts|name`
  signatures (`welcomeSeen`, capped at 300) of joins already handled; a join is welcomed once
  when its signature first appears.
- **No backlog spam:** the FIRST run seeds `welcomeSeen` from the current tail and sets
  `welcomeBaselined` WITHOUT sending, so already-connected / recently-joined players aren't
  welcomed. Toggling off/on preserves both, so it never replays the backlog.
- **Requires the file-based chat source** (`PALWORLD_CHAT_LOG_FILE`, set here to the game
  container's `console.log`); with no readable log, welcome silently no-ops.
- Runs every tick regardless of the interval (a join can arrive any minute); a per-id
  `welcoming` guard prevents overlap. Same RCON send path as the rotation (`sendViaRcon`).

## Pieces
- `lib/broadcast-schedule.ts` — schedule read/write, `runBroadcast`, `startBroadcastScheduler`.
- `app/api/broadcast-schedule/route.ts` — admin-only, instance-scoped GET/POST(save|test).
- `components/scheduled-broadcasts-card.tsx` — collapsible card on the Chat tab (admin-only):
  enable, interval, messages (one per line), prefix, skip-when-empty, Save + Test, plus the
  on-join welcome sub-section (toggle + messages textarea, `{name}` supported).
- `instrumentation.ts` — `startBroadcastScheduler()` at boot.

## Guards
Admin-tier only; interval/message count/length clamped; Test bypasses the interval + empty
gates (always sends the next message). Ships DISABLED.
