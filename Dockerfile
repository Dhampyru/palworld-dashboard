FROM node:24.18.0-bookworm-slim AS base

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps

COPY package.json package-lock.json ./
COPY scripts/patch-nextra-theme-docs.mjs ./scripts/patch-nextra-theme-docs.mjs
RUN npm ci

FROM base AS builder

# PATCH (not upstream): NEXT_PUBLIC_* vars are baked in at build time by
# `next build`, not read at container runtime -- has to arrive as a build ARG,
# passed through from docker-compose.yml's build.args (see that file).
ARG NEXT_PUBLIC_GAME_SERVER_IP
ENV NEXT_PUBLIC_GAME_SERVER_IP=$NEXT_PUBLIC_GAME_SERVER_IP

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# PATCH (not upstream): save decoder. Builds psp-core from
# oMaN-Rod/palworld-save-pal (MIT) via the pinned Dhampyru fork into a tiny
# `psp-decode` CLI the app shells out to for reading PlM1/Oodle saves. Pure-Rust
# Kraken (ooz-rs) -- no proprietary Oodle DLL. This stage is independent of the
# app source, so Docker keeps it cached across normal rebuilds. See savtools/NOTICE.
FROM rust:1-bookworm AS savtools
ARG PSP_FORK=https://github.com/Dhampyru/palworld-save-pal
ARG PSP_SHA=0d99b04acba369ec88550d122794b9917bbf820e
WORKDIR /build
RUN git clone "$PSP_FORK" psp && git -C psp checkout --quiet "$PSP_SHA"
COPY savtools/psp-decode.rs /build/psp/psp-core/examples/psp-decode.rs
COPY savtools/psp-inspect.rs /build/psp/psp-core/examples/psp-inspect.rs
COPY savtools/psp-delete-player.rs /build/psp/psp-core/examples/psp-delete-player.rs
COPY savtools/psp-player.rs /build/psp/psp-core/examples/psp-player.rs
COPY savtools/psp-edit-player.rs /build/psp/psp-core/examples/psp-edit-player.rs
RUN cargo build --release --manifest-path /build/psp/Cargo.toml -p psp-core \
      --example psp-decode --example psp-inspect --example psp-delete-player \
      --example psp-player --example psp-edit-player

# Clean-room toggle. Default (1) bundles Palworld game data (friendly Pal/item
# names) -- fine for a private deploy. Build with --build-arg BUNDLE_PSP_DATA=0
# for a PUBLIC image: it ships NO game data, and the save tools fall back to raw
# ids (see savtools/*.rs load_game_data_or_empty). Placed after the cargo build
# so toggling it never busts the compile cache.
ARG BUNDLE_PSP_DATA=1
RUN if [ "$BUNDLE_PSP_DATA" != "1" ]; then rm -rf /build/psp/data/json && mkdir -p /build/psp/data/json; fi

FROM node:24.18.0-bookworm-slim AS runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DEMO_MODE=0

WORKDIR /app

RUN groupadd --system --gid 2001 nodejs \
  && useradd --system --uid 2001 --gid nodejs nextjs

# PATCH (not upstream): gorcon/rcon-cli binary, used by /api/rcon instead of a
# JS RCON library -- Palworld's RCON server has a documented quirk in how it
# assigns response packet IDs that isn't strictly Source-RCON-spec compliant,
# which caused the rcon-client npm package to time out waiting for a response
# it never recognized as matching its request. gorcon's CLI is specifically
# documented to handle Palworld correctly (confirmed directly against this
# server before switching to it). The find-based move (rather than a hardcoded
# path) tolerates the release tarball's internal folder name changing between
# versions.
ARG RCON_CLI_VERSION=0.10.2
# `unar` (The Unarchiver, GPL) lets the mod installer open .rar/.7z uploads and
# Nexus downloads, not just .zip (lib/archive.ts normalizes them to zip). `zip`
# lets the client-loadout generator produce a Windows-friendly .zip via the CLI
# (streaming, low memory — the bundle can be ~1GB). Both are explicitly installed,
# so the curl purge/autoremove below leaves them in place.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates unar zip \
  && curl -fsSL -o /tmp/rcon.tar.gz \
    "https://github.com/gorcon/rcon-cli/releases/download/v${RCON_CLI_VERSION}/rcon-${RCON_CLI_VERSION}-amd64_linux.tar.gz" \
  && mkdir -p /tmp/rcon-extract \
  && tar -xzf /tmp/rcon.tar.gz -C /tmp/rcon-extract \
  && find /tmp/rcon-extract -type f -name rcon -exec mv {} /usr/local/bin/rcon \; \
  && chmod +x /usr/local/bin/rcon \
  && rm -rf /tmp/rcon.tar.gz /tmp/rcon-extract \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# PATCH (not upstream): SteamCMD for Steam Workshop mod downloads (docs/specs/
# steam-workshop-download.md). It runs as the non-root nextjs user at runtime —
# running SteamCMD as root breaks a real account's cloud-storage writes (verified),
# and non-root is also just correct. i386 libs are required (SteamCMD is 32-bit).
# The bootstrap self-update is baked at build so the first connect doesn't pay it;
# session/config live in the /app/data volume via HOME, so what persists is a
# cached session token, never a stored password.
RUN dpkg --add-architecture i386 \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl lib32gcc-s1 \
  && mkdir -p /opt/steamcmd \
  && curl -fsSL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" \
     | tar -xz -C /opt/steamcmd \
  && ( /opt/steamcmd/steamcmd.sh +quit || true ) \
  && chown -R nextjs:nodejs /opt/steamcmd \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Save decoder/inspector binaries + game data + attribution (savtools/NOTICE).
# The bundled data/json is Palworld game data (Pal names etc.) -- fine for a
# private deploy. For a PUBLIC/clean image build with BUNDLE_PSP_DATA=0 (above):
# this dir is then empty and the save tools degrade to raw ids. Do NOT publish an
# image built with BUNDLE_PSP_DATA=1 -- that redistributes Pocketpair game data.
COPY --from=savtools /build/psp/target/release/examples/psp-decode /usr/local/bin/psp-decode
COPY --from=savtools /build/psp/target/release/examples/psp-inspect /usr/local/bin/psp-inspect
COPY --from=savtools /build/psp/target/release/examples/psp-delete-player /usr/local/bin/psp-delete-player
COPY --from=savtools /build/psp/target/release/examples/psp-player /usr/local/bin/psp-player
COPY --from=savtools /build/psp/target/release/examples/psp-edit-player /usr/local/bin/psp-edit-player
COPY --from=savtools /build/psp/data/json /usr/local/share/psp-data/json
COPY savtools/NOTICE /app/savtools/NOTICE

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Picker datasets are read at RUNTIME (/api/datasets) since Phase C. They must
# NOT live in ./data — that path is a persistent volume mount at runtime and
# would shadow them. Bake them to a separate dir and point the default there.
# Empty stubs on a clean build; populated on an operator build; override
# PALWORLD_DATASETS_DIR at runtime to use extractor output.
COPY --from=builder --chown=nextjs:nodejs /app/data /app/game-datasets
ENV PALWORLD_DATASETS_DIR=/app/game-datasets

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000').then((res) => { if (!res.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "server.js"]

