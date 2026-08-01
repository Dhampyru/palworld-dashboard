# Spec: RCON Console Upgrade

Build brief for the dashboard's console feature (roadmap item: RCON console).
Design reference: palserver-gui's Console modal (screenshots reviewed
separately; that project is PolyForm Noncommercial — this spec describes
behavior and layout in original terms, and **no code may be copied or ported
from it**). All implementation must be original, built on our existing RCON
route and shadcn/Tailwind component patterns.

---

## 1. Goal

Replace the raw RCON input with a guided console: a searchable, categorized
command list on the left, a generated parameter form for the selected command
on the right, a live preview of the exact command string, and a Run button.
An admin should be able to give an item, teleport a player, or ban someone
without knowing any command syntax.

## 2. Entry points

> **Delivered as a MODAL, not a tab (2026-07-24, roadmap #3).** The console is
> `components/rcon-console-modal.tsx` (a wide right Sheet wrapping the unchanged
> `RconConsolePanel`), opened from a **Console** button in both the dashboard
> and live-map headers and from the roster quick-actions below. The former RCON
> tab was removed from all three tab files.

1. **Console button** — global console, no player preselected.
2. **Per-player launch** — an action on each row of the players roster
   ("Console") opens the console with that player's UserId prefilled in
   every player-parameter field. Title shows the context:
   `Console · <PlayerName>`.

## 3. Layout

Desktop: modal or full-width panel, two panes.
- **Left pane (~40%)**: sticky "Search commands…" input at top; below it a
  scrollable list grouped under category headers. Each entry: command name
  (monospace), one-line description, and badges. Selected entry highlighted.
- **Right pane (~60%)**: for the selected command — command name + source
  badge (`PalDefender` or `RCON`), description, parameter form, live command
  preview (monospace, updates on every keystroke), Run button, and a
  response/output log below.

Mobile (dashboard already has a mobile view): single column — search +
command list; selecting a command slides to the form view with a back
control. Preview + Run pinned at bottom.

Search filters by command name AND description substring, case-insensitive,
across all categories; category headers hide when empty.

## 4. Command registry (data-driven — this is the core of the design)

One typed registry array drives everything (list, search, forms, preview,
execution). No per-command React components. Shape per command:

```ts
{
  name: string;              // exact string sent over RCON
  category: Category;
  description: string;       // our own wording
  source: 'rcon' | 'paldefender';
  dangerous?: boolean;       // red badge + confirm dialog
  params: Param[];
}

type Param = {
  key: string;
  label: string;
  kind: 'player' | 'text' | 'number' | 'itemId' | 'palId' | 'eggId'
        | 'boolean' | 'select';
  optional?: boolean;
  placeholder?: string;
  default?: string | number;
  min?: number; max?: number;         // number kind
  options?: {value: string; label: string}[];  // select kind
}
```

Command string assembly: `name` + space-joined encoded params in registry
order; optional params omitted when empty. Params containing spaces are
quoted only if the underlying command supports it (see §7 quirks). No leading
`/` — see §5.

The §5 verification surfaced three needs the `kind` union above does not yet
cover; extend it when building the registry:

- **`coords`** (or three `number` params) — `spawnpal`, `killnearestbase`,
  `getnearestbase` and one `tp` form take X/Y/Z. Over RCON these are
  effectively mandatory even where minimum arity says otherwise.
- **`palTemplate`** — `givepal_j` / `giveegg_j` / `spawnpal_j` take a
  template *filename* from `PalDefender/Pals/Templates`, so this is a picker
  over that directory's contents, not free text and not JSON.
- **repeating `id:amount` pairs** — `giveitems` / `delitems` take a variable
  number of `<ItemId>[:<Amount>]` arguments, which the fixed-params model
  cannot express. v1 may expose these as a single freeform `args:text`.

Also note `settime` is a bounded number (0–23) and `give_relic` needs a
`select` over the 13 known relic types — both already captured in §5.

## 5. Command set

Availability gating: vanilla RCON commands always shown. PalDefender
commands shown only when PalDefender is detected (see §8). Header line under
the title mirrors the state: `N commands available · PalDefender commands
enabled` (or `PalDefender not detected — vanilla commands only`).

### Vanilla RCON (always available)
| Command | Params | Notes |
|---|---|---|
| Info | — | server info |
| Save | — | save world |
| ShowPlayers | — | list online players |
| Broadcast | message:text | **no spaces supported** — see §7 |
| KickPlayer | player | |
| BanPlayer | player | dangerous |
| UnBanPlayer | player | |
| Shutdown | seconds:number, message:text(optional) | dangerous |
| DoExit | — | dangerous; immediate kill |

### PalDefender (when detected) — categories and commands

**Verified 2026-07-19 against the installed build, PalDefender v1.8.3**
(the latest release, so the official wiki documents exactly this build).
Ground truth came from `getrconcmds`, which returns the live registry as
`name:minArgs;` pairs — **53 RCON-exposed PalDefender commands**. Signatures
below are corroborated by usage/error strings in `PalDefender.dll`. The
earlier version of this table encoded the reference GUI's surface and got six
signatures wrong; those are corrected here, and §5's former "must verify
before finalizing" instruction is discharged.

Two rules that govern the whole registry:

- **Send bare command names — no leading `/`.** The wiki's `/cmd` form is
  chat-only. Verified: `getrconcmds` works, `/getrconcmds` returns
  `Unknown command`. Prefixing every command would break all of them.
- **Minimum arity is not the same as valid input.** `getrconcmds` reports the
  parser's minimum argument count; several commands accept that count and then
  fail runtime validation. Build forms from the signatures below, not from
  arity alone. Known disagreements are flagged ⚠ in the table.

| Category | Command | Verified signature | minArgs | Notes |
|---|---|---|---|---|
| Servers | `version` | — | 0 | |
| Servers | `reloadcfg` | — | 0 | reloads whitelist + config |
| Servers | `pgbroadcast` | `<Message>` | 1 | spaces OK — prefer over vanilla `Broadcast` |
| Servers | `alert` | `<Message>` | 1 | |
| Players | `getpos` | `<UserId>` | 0 | ⚠ **corrected by execution 2026-07-19** — UserId is *required* over RCON despite minArgs=0. Bare `getpos` returns `You have to specify an UserId to perform this command`. Same trap as `spawnpal`/`exportpals` |
| Players | `renameplayer` | `<UserId> <NewName>` | 2 | |
| Players | `give_exp` | `<UserId> <Amount>` | 2 | |
| Players | `givestats` | `<UserId> [Count=1]` | 1 | **corrected** — no stat-name arg; grants *unused stat points*. Negative removes |
| Moderation | `setadmin` | `<UserId>` | 1 | **corrected** — no `on\|off` (that belongs to `godmode`, which is chat-only) |
| Moderation | `addadminip` | `<IP>` | 1 | |
| Moderation | `getip` | `<UserId>` | 1 | |
| Moderation | `kick` | `<UserId> [Reason="Kicked by Admin."]` | 1 | |
| Moderation | `ban` | `<UserId> [Reason="Banned by Admin."]` | 1 | dangerous |
| Moderation | `ipban` | `<UserId> [Reason]` | 1 | dangerous |
| Moderation | `unban` | `<UserId> [Reason="Unbanned by admin."]` | 1 | reason optional |
| Moderation | `banip` / `unbanip` | `<IP>` | 1 | `banip` dangerous |
| Moderation | `whitelist_add` / `whitelist_remove` | `<UserId>` | 1 | |
| Moderation | `whitelist_get` | — | 0 | long output — must scroll |
| World | `settime` | `<Hour>` | 1 | **corrected** — integer **0–23 only**; number param with min/max, not text |
| Items | `give` | `<UserId> <ItemId> [Amount=1]` | 2 | |
| Items | `delitem` | `<UserId> <ItemId> [Amount=1\|all]` | 2 | amount accepts literal `all` |
| Items | `give_relic` | `<UserId> <RelicType> [Amount]` | 1 | ⚠ **corrected** — RelicType required by the binary despite minArgs=1. `select` param: `CapturePower`, `HungerReduction`, `SwimSpeed`, `FoodDecayReduction`, `JumpPower`, `GliderSpeed`, `ClimbSpeed`, `StatusAilmentResist`, `StaminaReduction`, `SphereHoming`, `ExpBonus`, `RainbowPassiveRate`, `MoveSpeed` |
| Cleanup | `clearinv` | `<UserId> <Container>` | 2 | ⚠ wiki calls Container optional, but minArgs=2 — treat as required. Container enum unknown (default `items`) |
| Cleanup | `deletepals` | `<UserId> <PalFilter>` | 1 | **corrected** — UserId required first. dangerous |
| Cleanup | `killnearestbase` | `[X] [Y] [Z]` | 0 | ⚠ **corrected** — coordinates, **not a player**. Over RCON the binary requires them (`Atleast X and Y are required!`). dangerous |
| Pals | `givepal` | `<UserId> <PalId> [Level=1]` | 2 | |
| Pals | `spawnpal` | `<PalID> [X] [Y] [Z] [Level=1]` | 1 | ⚠ **corrected** — over RCON coords are mandatory: `RCON usage needs to provide coordinates for /spawnpal!` |
| Pals | `giveegg` | `<UserId> <EggId> <PalId> [Level]` | 3 | |
| Pals | `exportpals` | `<UserId>` | 0 | UserId required over RCON despite minArgs=0 |
| Pals | `getskinids` | — | 0 | long output |
| Tech | `learntech` / `unlearntech` | `<UserId> <Tech\|all>` | 2 | |
| Tech | `givetechpoints` / `givebosstechpoints` | `<UserId> [Amount=1]` | 1 | |
| Tech | `gettechids` | — | 0 | long output |
| Bases | `getnearestbase` | `[X] [Y] [Z]` | 0 | ⚠ **corrected** — coordinates, not a player |
| Bases | `setguildleader` | `<UserId>` | 1 | |
| Bases | `exportguilds` | — | 0 | writes `guildexport.json` |
| Advanced | `givepal_j` | `<UserId> <PalTemplate>` | 2 | **corrected** — PalTemplate is a **filename** under `PalDefender/Pals/Templates`, not inline JSON → template picker, not a textarea |
| Advanced | `giveegg_j` | `<UserId> <EggId> <PalTemplate> [Level]` | 3 | minArgs=3 confirms it takes a UserId; the wiki line omitting it is a typo |
| Advanced | `giveitems` | `<UserId> <ItemId>[:<Amount>] …` | 2 | repeating `id:count` pairs |
| Advanced | `tp` | `<UserId>` / `<UserId1> <UserId2>` / `<X> <Y> [Z]` / `home\|oilrig[:Lv##]` | 1 | more forms than the spec assumed |

The reference GUI paywalls the Advanced commands ("Sponsor-only"); we ship
them normally — no gating in our project.

### Present in the build but not previously specced

Consider for v1 or later: `send <Type> <UserId> <Message>` (3) — direct
player messaging, no vanilla equivalent and sidesteps `Broadcast`'s space
mangling; `summon <PalSummon>` (1); `spawnpal_j <PalTemplate> [x] [y] [z]`
(1); `delitems <UserId> <ItemId>[:<Amount>] …` (2); `iwantplayerlist` (0);
`getrconcmds` (0) — worth exposing, since it self-documents the live registry.

The `giveme*` self-targeting variants (`giveme_exp`, `givemeegg`,
`givemeegg_j`) are RCON-exposed but meaningless over RCON, where there is no
"me" — exclude them.

`spectate`, `godmode`, `resetoilrig`, and the vanilla wrappers PalDefender also
registers (`shutdown`, `save`, `showplayers`, …) do **not** appear in
`getrconcmds`. `resetoilrig` is listed in Config.json's `adminCheats` array,
which is what makes it look RCON-exposed; validating the registry against the
live build on 2026-07-19 showed it is not, so it is chat-only.
Vanilla commands are handled by the game itself and remain available; the
vanilla table above is unaffected.

## 6. Parameter form behavior

- **player kind** → combobox listing current online players from the
  existing server snapshot (label: name; value: UserId, e.g.
  `steam_7656…`), plus free-text entry for offline UserIds. Prefilled when
  launched from a roster row.
- **itemId / palId / eggId kinds** → typeahead picker: "Search item names
  or enter an ID…". Dropdown rows show `Display Name` with the internal ID
  as secondary text; selecting fills the ID. Free-typed IDs pass through
  unvalidated. Pal pickers additionally show a **"BOSS (Alpha) variant"
  checkbox** which prefixes the chosen Pal ID with `BOSS_`.
- **number kind** → numeric input with min/max/default; show `(optional)`
  suffix on optional labels.
- **Live preview**: always-visible monospace line showing the exact string
  that Run will send. Never let preview and payload be computed by two
  different code paths — one builder function, used by both.
- **Run**: disabled until required params valid. Dangerous commands get a
  confirm dialog naming the command and its target. Response appends to the
  output log (timestamped, scrollback, most recent visible); errors render
  distinctly. Keep a per-session history of executed commands.

## 7. Execution & quirks

- Reuse the existing dashboard RCON API route; PalDefender commands are
  ordinary RCON payloads. No new transport.
- **No leading `/` on any command** — see §5. Chat syntax is not RCON syntax.
- Vanilla `Broadcast` mangles spaces (known Palworld quirk). When
  PalDefender is present, the registry should prefer `pgbroadcast` and mark
  vanilla `Broadcast` accordingly ("no spaces — use pgbroadcast").
- **Admin-cheat gating — cleared on this deployment 2026-07-19, but still
  required behaviour.** PalDefender's `Config.json` has an `adminCheats`
  array (31 entries: `give`, `givepal`, `tp`, `spawnpal`, `give_exp`,
  `givestats`, `give_relic`, `givetechpoints`, …) gated behind
  `allowAdminCheats`. That flag was `false`, so those commands were refused
  with `Admin-cheats are disabled!`. It has since been set to `true` and
  applied live via `reloadcfg` (no restart). Verified by probing `give` with
  a nonexistent UserId: the response moved from `Admin-cheats are disabled!`
  to `Failed to find player by UserId '…'`, i.e. past the gate.

  **The UI must still handle both states** — the flag is per-deployment, and
  this repo ships to operators who will have it `false`. Do not present a
  gated command as though it will work: either read the flag and mark such
  commands disabled with an explanatory tooltip, or surface the refusal
  distinctly in the output log rather than as a generic error. Whether to
  flip it is a game-server config decision, outside this repo.

  Related, verified at the same time: `useAdminWhitelist: true` with
  `adminIPs: ["127.0.0.1"]` does **not** block the dashboard container, whose
  RCON connections originate from the docker bridge rather than localhost.
  That whitelist gates admin *login*, not RCON, so the console's real path
  works. Confirmed by running the same probe through `/api/rcon`.
- Other runtime gates seen in the binary, worth rendering distinctly:
  `This command is available only via RCON.`, `Chat only command.`,
  `Insufficient permission to execute the command.`
- RCON responses are plain text; render verbatim in the log. Long responses
  (`whitelist_get`, `gettechids`, `exportguilds`) must scroll, not blow up
  the layout.
- Auth: console is admin-tier only, consistent with the existing auth-tier
  feature. Demo mode: forms fully usable, Run stubbed.

## 8. PalDefender detection

Prefer **`getrconcmds`** — it returns the live registry as `name:minArgs;`
pairs and is itself PalDefender-only, so a successful response both detects
PalDefender and enumerates exactly what this build supports. That is
strictly better than probing `version`: it self-documents, and it lets the
registry be validated against ground truth at runtime instead of trusting a
hardcoded list to match the operator's version.

Suggested: call once per session, cache in server context, and use it to (a)
gate the extended registry and (b) warn when a specced command is absent from
the live registry (version drift). Fall back to hiding all PalDefender
commands if the call fails.

## 9. Datasets (items / pals / eggs)

`data/items.json`, `data/pals.json`, `data/eggs.json`: arrays of
`{ id, name }` (pals may add `boss: true` implicitly via the `BOSS_` prefix).

**Generate at build time from the operator's own game files. Vendor no
third-party dataset.** Add a `scripts/generate-datasets` step invoking
[PalworldDataExtractor](https://github.com/PalworldDataTools/PalworldDataExtractor)
(MIT) against the local pak, and **gitignore the generated `data/*.json`**.

Licensing review (2026-07-19) found no source that is both correctly
formatted and cleanly redistributable:

| Source | License | Verdict |
|---|---|---|
| `mlg404/palworld-paldex-api` (+ forks) | MIT | **Wrong data** — ships `pal_sphere` / paldeck `001`, not the internal `PalSphere` / `SheepBall` IDs that `give` accepts. Also embeds Fandom links/images the MIT grant may not cover |
| `KURAMAAA0/PalModding` `ItemIDs.txt` | **none** (all rights reserved) | Correct format, unusable |
| `paldb.cc` | none stated | Avoid |
| `palworld.wiki.gg` | CC BY-SA 4.0 | Copyleft — conflicts with clean MIT |
| Fandom | CC BY-SA 3.0 | Same |

Verified locally: the server's `Pal-WindowsServer.pak` (5.0 GB) is
unencrypted and contains internal IDs in plaintext (`SheepBall`, `PalSphere`,
`Kitsunebi` all grep as hits). Display names do **not** grep — `ITEM_NAME_`
returns zero — so a real UE asset parser is required for `{id, name}`; naive
`strings` is not enough.

Why generation over vendoring: it removes every third-party license question,
yields the only correctly-formatted IDs, has each operator derive data from a
game copy they already own, and auto-tracks game updates. The cost is real —
contributors get no typeahead until they run the generator, and it adds a
Python/UE-parser dependency. Acceptable because incomplete or absent datasets
degrade gracefully: free-text ID entry always works.

Header for generated files:

```
Generated from Palworld game files via PalworldDataExtractor (MIT).
Game content © Pocketpair, Inc. Not redistributed — generated locally.
Palworld <version> · generated <date>
```

**EULA reviewed 2026-07-19 — it does not address this.** The operator read it
and reported it silent on data extraction and redistribution. That is not a
grant: copyright is default-deny, so silence leaves the position unchanged
rather than permitting anything. It does mean the EULA is not the governing
instrument, and the search should move to Pocketpair's published guidelines.

Two exist, and neither has been fully read:

- [Guidelines for Derivative Works](https://www.pocketpair.jp/en/guidelines-derivativework-en/)
  — covers illustrations, doujinshi, manga and novels. **Silent on software
  and tools.** Prohibits "highly commercial or profit-oriented purposes,
  regardless of whether direct monetary compensation is received", which is
  the clause a sponsor-paywalled dashboard would run into.
- [Mod Usage Guidelines](https://guideline.palworldgame.com/palworld-mod-guideline)
  — **unread, and the most on-point document for a server tool.** Read this
  before revisiting vendoring or shipping any art. **JS-gated like the EULA
  URL: fetching it returns only the page title, no body.** It needs a human
  with a browser; do not waste another fetch on it.

The honest framing for vendoring remains "low practical risk, non-zero legal
risk" — comparable tools (palserver-gui) ship Pal art openly and monetise
without apparent consequence, which is real evidence about *enforcement* but
none about *rights*. Note the asymmetry that actually matters for this repo:
using an asset in an app and committing it under MIT are different acts. The
second tells everyone downstream they may redistribute and sell it — a grant
this project cannot make for content it does not own. That is why images stay
unpopulated regardless of how the rest resolves.

### Implemented 2026-07-19

The plumbing shipped; the data did not, deliberately.

- `data/{items,pals,eggs}.json` ship **empty**, with `data/README.md` carrying
  the schema and the reasoning. Entries are `{ id, name?, image? }` — only
  `id` required — so data *and* art can be filled in later without a code
  change.
- Empty is a normal state everywhere: every picker degrades to free-text ID
  entry, so the console works unchanged until data lands.
- **A fourth source, better than all of the above where it applies: live
  enumeration.** PalDefender's `gettechids` returns the running server's own
  technology list as a JSON array — 588 entries here. `learntech` /
  `unlearntech` use it today via the `techId` param kind. This has no
  redistribution question at all (the operator's server produced it) and is
  correct for their exact build rather than for whatever version a dataset was
  scraped from. `getskinids` has the same shape if skins ever get a picker.
  **Prefer this wherever the server can enumerate something.**

Sourcing preference order, revised: live enumeration → generated from the
operator's own install → a vetted third-party dataset.

One finding worth recording against hand-curation, which was considered and
rejected: the live tech list contains `Special_PalSphere_Grade_01`,
`Product_Axe_Grade_01` and `Battle_MeleeWeapon_Bat`. Hand-written IDs from
memory (`PalSphere`, `Axe`, `Bat`) would have been uniformly wrong, and a
wrong ID in a picker is worse than free text — it looks authoritative and
fails silently at the server. Nothing goes into these files unverified.

Egg IDs specifically: no dedicated egg table was found in the pak index. They
may be a subset of the item table or derived from Pal IDs — confirm against
`giveegg <UserId> <EggId> <PalId>` during implementation.

## 10. Non-goals for v1

- No JSON builder UIs for `givepal_j`/`giveegg_j`/`giveitems` (freeform arg
  only).
- No command scheduling/macros.
- No copying of any palserver-gui code, styling values, or asset files.

## 11. Acceptance criteria

**Build status 2026-07-19** — shipped in four commits: registry/data, UI,
execution wiring (the three §11.9 asks), plus dataset plumbing. Deployed and
typechecking clean.

Criteria 2, 3, 4, 5, 7, 8 and 9 are met by construction and verified through
the API. **Criteria 1 and 6 are unverified**: everything so far was tested via
`/api/rcon`, never in a browser, so layout, the mobile single-column flow, and
the ≤4-interaction give flow (which also needs a player online) remain open.
Do not consider this feature closed until someone loads the page.

1. From the roster, opening Console on an online player and giving them an
   item takes ≤4 interactions (pick command, pick item, amount, Run) with
   the UserId prefilled. Now testable end-to-end: `allowAdminCheats` was
   enabled on 2026-07-19 (§7), so `give` reaches execution. Requires a player
   online to verify delivery.
2. Search "ban" surfaces every ban-related command across categories.
3. Every dangerous command shows a confirm dialog before sending.
4. Preview string always equals the payload actually sent (single builder).
5. With PalDefender absent (simulated), only vanilla commands render and the
   header says so.
6. Mobile: full flow works single-column; preview+Run reachable without
   scrolling the form off-screen.
7. A gated command (e.g. `give` while `allowAdminCheats` is false) renders as
   unavailable or fails with a distinct, explanatory message — never a bare
   generic error (§7).
8. No command is sent with a leading `/` (§5).
9. Typecheck passes (see below); feature commits are split: registry/data,
   UI, execution wiring.

## 12. Typecheck

There is no node on the deployment host, so `npm run typecheck` cannot run
from a host shell. Typecheck in a throwaway container instead:

```sh
docker run --rm -v "$PWD:/app" -w /app node:20-alpine npx tsc --noEmit
```

This runs bare `tsc --noEmit` and skips the `typecheck` script's `next typegen`
step, which deletes `.next`. Route-type checking is correspondingly weaker; a
container `npm ci` first would close that gap.

## 13. Open questions (decide before building)

1. ~~`allowAdminCheats` gating~~ — **RESOLVED 2026-07-19.** Set to `true` and
   applied live via `reloadcfg`; verified past the gate (§7). The UI must
   still handle the `false` state for other operators.
2. ~~**Pocketpair EULA unread**~~ — **READ 2026-07-19, and it does not address
   datasets.** It is therefore not the governing instrument, and its silence
   grants nothing. The open question moved rather than closed: Pocketpair's
   **Mod Usage Guidelines are still unread** and are the most on-point
   document for a server tool. The Derivative Works guideline was read and
   covers only creative works (illustrations, doujinshi, manga, novels),
   silent on software, and bars profit-oriented use. See §9.

   Not blocking: the datasets ship empty, technology IDs come from live
   enumeration with no redistribution question, and every picker degrades to
   free text. This only needs resolving before vendoring data or shipping art.
3. **Mostly verified by inference, not execution.** The §5 signatures come
   from `getrconcmds` arity plus binary usage strings. Six PalDefender
   commands have now actually been run here — `getrconcmds`, `reloadcfg`,
   `whitelist_get`, `version`, `getpos` (all read-only) and `give` with a
   nonexistent UserId (the cheat-gate probe, non-mutating). Everything else is
   inferred. The ⚠ rows — `give_relic`, `clearinv`,
   `killnearestbase`/`getnearestbase`, `spawnpal` — are where arity and binary
   strings disagree, and are most likely to surprise. A read-only command is
   safe to trial; anything mutating should be trialled on a non-production
   instance.

   **`getpos` is the cautionary case.** It was specced as taking an optional
   UserId on the strength of `minArgs=0`, and executing it disproved that in
   one call. Every remaining "optional over RCON" claim in §5 rests on the
   same weak evidence, so treat the ⚠ rows as unverified until run.
4. **`clearinv` container values** are unenumerated (default `items`).
5. **`deletepals <PalFilter>` grammar** is unspecified beyond "too many
   sub-arguments" errors.

## 14. Backlog

Logged, not scheduled — do not build as part of this spec.

- **Presence adapter for PalDefender login/logout lines.** Palworld does not
  log chat to stdout, so the chat panel has no source on deployments without a
  chat-logging mod. PalDefender does log presence in its own format
  (`[HH:MM:SS][info] 'Name' (UserId=steam_…, IP=…) has logged in.` / `has
  logged out.`), which does not match the chat route's
  `[ts] [LOG] Name joined the server.` regex. A small adapter over
  PalDefender's log could restore join/leave events even while chat stays
  dark.
