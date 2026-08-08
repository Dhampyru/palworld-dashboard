## =============================================================================
## Palworld Dedicated Server — Windows server binary under PLAIN WINE in Docker
## =============================================================================
## Runs the WINDOWS Palworld dedicated-server binary under WineHQ stable (NOT
## Proton, and NOT the native Linux binary) so it can load UE4SS mods, which are
## Windows-only. The game binary is NOT baked in -- SteamCMD installs it on first
## boot; UE4SS (MIT) is fetched on first boot; PalDefender (MIT) is optional. See
## README.md and the dashboard's "Full Self-Hosted Setup" guide.
## =============================================================================
FROM cm2network/steamcmd:root
## ---- Minimal packages required by Wine + UE4SS ------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        libfreetype6 \
        unzip \
        procps \
        gosu \
        python3 \
        wget \
        gnupg2 \
        ca-certificates \
        xvfb \
    && rm -rf /var/lib/apt/lists/*
## ---- RCON CLI (gorcon/rcon-cli) ---------------------------------------------
ARG RCON_VERSION=0.10.3
RUN curl -sL "https://github.com/gorcon/rcon-cli/releases/download/v${RCON_VERSION}/rcon-${RCON_VERSION}-amd64_linux.tar.gz" \
        | tar -xzf - -C /tmp/ \
    && mv "/tmp/rcon-${RCON_VERSION}-amd64_linux/rcon" /usr/local/bin/rcon-cli \
    && chmod +x /usr/local/bin/rcon-cli \
    && rm -rf /tmp/rcon-*
## ---- Supercronic (cron scheduler for containers) ----------------------------
ARG SUPERCRONIC_VERSION=0.2.46
RUN curl -sL "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
        -o /usr/local/bin/supercronic \
    && chmod +x /usr/local/bin/supercronic
## ---- Plain Wine (official WineHQ repo, NOT Debian's bundled package which
## is typically far too old to run modern games reliably) --------------------
RUN dpkg --add-architecture i386 \
    && mkdir -pm755 /etc/apt/keyrings \
    && wget -O /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key \
    && . /etc/os-release \
    && wget -NP /etc/apt/sources.list.d/ "https://dl.winehq.org/wine-builds/debian/dists/${VERSION_CODENAME}/winehq-${VERSION_CODENAME}.sources" \
    && apt-get update \
    && apt-get install -y --install-recommends winehq-stable \
    && rm -rf /var/lib/apt/lists/*
ARG APPID=2394010
ENV STEAM_HOME=/home/steam \
    STEAMCMD=/home/steam/steamcmd/steamcmd.sh \
    SERVER_DIR=/palworld \
    APPID=${APPID} \
    WINEPREFIX=/home/steam/.wine \
    WINEARCH=win64 \
    WINEDEBUG=-all \
    WINEDLLOVERRIDES="dwmapi=n,b;d3d9=n,b"
## Pre-create the Wine prefix at build time so first boot doesn't pay this cost
RUN gosu steam wineboot --init \
    && chown -R steam:steam /home/steam
## ---- Server data directory (mounted as volume at runtime) ------------------
RUN mkdir -p ${SERVER_DIR} && chown steam:steam ${SERVER_DIR}
## ---- Entrypoint + backup scripts --------------------------------------------
COPY --chmod=755 scripts/entrypoint.sh /entrypoint.sh
COPY --chmod=755 scripts/backup.sh /usr/local/bin/backup
VOLUME ["/palworld"]
## Game (UDP 8211) | Query (UDP 27015) | RCON (TCP 25575) | REST API (TCP 8212)
EXPOSE 8211/udp 27015/udp 25575/tcp 8212/tcp
## Healthcheck: detect if the Windows server process is running under Wine.
## Match BOTH the 1.0 exe (PalServer-Win64-Shipping-Cmd) and the older EA one
## (PalServer-Win64-Test) -- the earlier "-Test"-only check never matched 1.0.
HEALTHCHECK --start-period=5m --interval=30s --timeout=10s --retries=3 \
    CMD pgrep -f "PalServer-Win64" > /dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
