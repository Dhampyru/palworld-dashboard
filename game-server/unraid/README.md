# Unraid template

`palworld-game-server.xml` — Unraid Community-Apps template for the published Wine
image `ghcr.io/dhampyru/palworld-game-server`. Icon: `palworld-game-server.png`
(clean-room, no game assets).

## Manual install (no Community Applications needed)

```bash
curl -sL https://raw.githubusercontent.com/Dhampyru/palworld-dashboard/main/game-server/unraid/palworld-game-server.xml \
  -o /boot/config/plugins/dockerMan/templates-user/palworld-game-server.xml
```

Then **Docker → Add Container → Template: palworld-game-server**, set `ADMIN_PASSWORD`, Apply.
The template presets the required `--security-opt seccomp=unconfined --cap-add SYS_PTRACE`
(Extra Parameters) and `WINEDLLOVERRIDES` for mod injection; Xvfb is baked into the image.

## Submitting to Community Applications (maintainer)

CA reads templates from a public repo via its submission portal. Requirements met here:
`Name`, `Repository` (a valid image), `Overview`, `Category` (`GameServers:`), and a
`TemplateURL` pointing at the raw XML on `main`; plus an `Icon`, `Support`, and `Project`.

1. Recommended: create an Unraid **forum support thread** and set its URL in `<Support>`
   (CA expects an active support thread per app).
2. Go to **https://ca.unraid.net/submit/new**, sign in, and enter this repo /
   the raw `TemplateURL`. Run **Validate** then **Scan**.
3. Submit for **moderator review**. After approval the app appears in Community Applications.

Keep the image current by re-running the `publish-gameserver.yml` workflow whenever
`game-server/` changes.
