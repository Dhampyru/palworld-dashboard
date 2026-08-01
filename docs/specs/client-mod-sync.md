# Spec: Client Mod-Sync & Onboarding

Status: **proposed, not started.** A standalone feature — related to the mod
management already built, but self-contained. Needs an explicit "start" before any
code (per the repo's working style). Sibling to the numbered roadmap; slot after #7
or whenever the owner chooses.

## 1. Goal
Help the people joining a modded server get their client into a matching state with
minimum friction: see what the server runs, check their own install against it, and
pull down the client-side files they're missing — plus give the admin a clean way
to invite and align friends.

## 2. Scope & the key simplifying truth
For a **dedicated server, clients almost only need the `.pak` files.** This is what
makes the feature tractable:
- **Pak mods** load via the game's own pak system → the client needs them.
- **PalSchema mods** run server-side (the JSON never touches the client). Only their
  **pak** parts (already pak mods) matter to the client.
- **Classic UE4SS Lua/BP mods**, **UE4SS itself**, and **PalSchema itself** run
  **server-side** → clients do NOT install these.
- **Game version** must match, but **Steam enforces that** — a version-mismatched
  client can't join at all. The tool can only *report* a mismatch and point the
  player at Steam; it cannot patch the game.

So the actual sync target is: *"make the client's `Pal/Content/Paks/~mods/` pak set
match the server's client-required paks."* UE4SS/PalSchema/game versions are shown
for **information/diagnosis**, not installed on the client.

## 3. Server-side manifest
The dashboard already reads everything needed (game REST `/v1/api/info`,
`readUe4ssStatus`, `readPalSchemaStatus`, `listPakMods` / `listUe4ssMods` /
`listPalSchemaSubmods`). Add a manifest the admin can share, e.g.:

```jsonc
{
  "serverName": "Palkatraz",
  "gameVersion": "v1.0.1.100619",
  "ue4ss":     { "source": "experimental-palworld", "sha": "c838a8ac" }, // info only
  "palschema": { "version": "0.6.1" },                                    // info only
  "clientMods": [                                                         // the sync set
    { "file": "William_MoreHairs_P.pak", "sizeBytes": 66059793, "sha256": "…", "source": "…" }
  ],
  "generatedAt": "…"
}
```
`clientMods` is the **admin-curated** list of client-required paks (default: all
`~mods` paks; admin can trim). `sha256` lets the client detect mismatches, not just
absence.

## 4. Redistribution stance (owner's call — dashboard is NOT a mod CDN)
The dashboard must not become a public host for third-party mod files (Nexus etc.
have their own terms). Instead:
- The dashboard **generates the manifest + a customizable sync-script template**;
  the admin **curates** the set and decides where the files are actually served from
  (their own share, a link, etc.).
- Any "serve the pak to the client" path is **opt-in and admin-owned** — the admin
  accepts responsibility for what they redistribute to their own community.
- Ship **guidance** for admins on making/curating their own script rather than a
  one-size CDN. This keeps the project clean for public release.

## 5. Client sync — approaches (a browser page can't write to the game folder by default)
1. **Standalone sync tool** (small script/app the player runs — PowerShell/Python/
   .NET). Reads the manifest, hashes local `~mods`, downloads mismatches, drops them
   in. Most robust; any OS/browser; could even install client-side UE4SS if a mod
   ever needed it. **Cost:** distributing + running an executable (trust / AV flags).
   Fits the "admin curates their own script" model best — the dashboard generates a
   filled-in template.
2. **Browser sync via the File System Access API** (`showDirectoryPicker()`). Player
   picks their `~mods` folder once, grants permission, the page writes the paks.
   **No separate app.** **Cost:** Chromium-only (Chrome/Edge), paks-only, requires a
   file source the page can fetch from (see §4).

### 5a. Comparison
| | Browser FSA | Standalone script |
|---|---|---|
| Friend installs anything? | No — just the browser | Yes — download + run a script/exe |
| Browser support | Chromium only (Chrome/Edge/Opera); **not** Firefox/Safari | Any (browser-irrelevant) |
| OS | Any (Chromium) | Any |
| Needs dashboard public over HTTPS | **Yes** (FSA needs a secure context; page fetches manifest+paks) | Only if it pulls from the dashboard; admin can host files elsewhere instead |
| Can write paks to `~mods` | Yes (user grants folder access) | Yes |
| Can install UE4SS / patch game | No (files-in-picked-folder only) | Could, if ever needed (not needed today) |
| Integrity check (SHA-256) | Yes | Yes |
| Friction | Pick folder + grant once | Trust/AV prompt on an executable |

### 5b. Recommendation — offer BOTH (they share one backend)
Both consume the **same** manifest + token-gated curated pak endpoints, so a second
delivery mechanism is only its own thin client glue — not a second backend. Ship:
- **FSA browser flow as the zero-install happy path** (Chrome/Edge).
- **Standalone script as the universal fallback** (Firefox/Safari/other, or anyone
  who'd rather not grant folder access, or when the admin doesn't want the dashboard
  public).

The FSA page **feature-detects** (`'showDirectoryPicker' in window`) and, when
unsupported, points the user straight at the script — progressive enhancement, no
dead-ends. Building both is mostly additive; there's no real downside to shipping
the pair.

## 6. "Invite & align your friends" onboarding area
A dashboard section that produces a **shareable setup packet** for the admin to send
friends:
- Server address + name + current game version (with "update via Steam if mismatched").
- The client-required mod list + where/how to get them.
- Plain-language install steps (drop paks into `…\Pal\Content\Paks\~mods\`).
- The generated sync-script (or a link to it) + how to run it.
- Copy-to-clipboard / shareable text so the admin can paste it into Discord.

Essentially: turn the manifest into human-friendly onboarding the admin hands out.

## 7. Phasing
- **Phase 1 — BUILT + browser-verified (2026-07-27):** `GET /api/manifest` (admin-only: server name +
  game version, UE4SS/PalSchema info, client paks with size + SHA-256) and a
  dedicated **Invite tab** (`components/invite-panel.tsx`) — server/versions,
  admin-entered connect address (saved locally; the server can't detect its public
  IP), client paks with per-file download (reuses `/api/game-mods/pak`), and a
  copy-paste invite packet. No client automation yet — players see exactly what
  they need. (Owner browser-verified the tab render, connect-address field, per-pak
  download, and copy-invite.)
- **Phase 2 (automation):** build the "check & install" flow driven by the manifest.
  Per §5b, ship BOTH the FSA browser flow (happy path) and the standalone script
  (fallback) over one shared backend. Prereqs: a curated non-admin manifest+pak
  path (§8), and — for the FSA path — the dashboard reachable over public HTTPS.

## 8. Security / access
- Players aren't admins, so the manifest + any client-file access need a **separate,
  curated, non-admin path** — only the admin-designated client paks, never the
  arbitrary-file admin download route.
- Prefer a token or share-link over fully open, and never expose anything but the
  curated `clientMods` set.

## 9. Open decisions (for the owner)
- Serve client paks from the dashboard (opt-in) vs. admin hosts them elsewhere.
- ~~Standalone script vs. browser FSA~~ — RESOLVED: ship **both** (§5b), FSA as the
  happy path + script as the universal fallback, one shared backend.
- Whether to expose the dashboard over public HTTPS (required for the FSA path;
  the script path can avoid it if the admin hosts files elsewhere).
- How curation is expressed (mark paks client-required in the Mods tab; default all).

## 10. Out of scope
- Installing/patching the game itself (Steam's job).
- Client-side UE4SS/PalSchema/Lua/JSON (server-side only unless a specific mod
  demands client UE4SS — an advanced edge case, deferred).
- Auto-updating from Nexus (auth-gated; same verdict as elsewhere).
