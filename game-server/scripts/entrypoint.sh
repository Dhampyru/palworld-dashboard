#!/bin/bash
set -euo pipefail

## =============================================================================
## Palworld Windows Dedicated Server — Wine entrypoint
## =============================================================================
## Flow: install/update via SteamCMD → install UE4SS → install PalDefender
##       (optional) → copy mods → start server
## The game binary is NOT baked into the image; SteamCMD installs it here on
## first boot. UE4SS (MIT) is fetched here too. PalDefender (MIT) installs only
## when PALDEFENDER_URL is set (see install_paldefender).
## =============================================================================

## Palworld 1.0 renamed the executable from -Test to -Shipping-Cmd
SERVER_EXE_10="${SERVER_DIR}/Pal/Binaries/Win64/PalServer-Win64-Shipping-Cmd.exe"
SERVER_EXE_EA="${SERVER_DIR}/Pal/Binaries/Win64/PalServer-Win64-Test.exe"
SERVER_EXE="${SERVER_EXE_10}"  ## default to 1.0, fall back to Early Access
if [ ! -f "${SERVER_EXE_10}" ] && [ -f "${SERVER_EXE_EA}" ]; then
    SERVER_EXE="${SERVER_EXE_EA}"
fi
WIN64_DIR="${SERVER_DIR}/Pal/Binaries/Win64"
SETTINGS_DIR="${SERVER_DIR}/Pal/Saved/Config/WindowsServer"
SETTINGS_FILE="${SETTINGS_DIR}/PalWorldSettings.ini"
UE4SS_URL="https://github.com/Okaetsu/RE-UE4SS/releases/download/experimental-palworld/UE4SS-Palworld.zip"

log() { echo -e "\033[32;1m>>> $1 <<<\033[0m"; }

## -----------------------------------------------------------------------------
## Install or update the Palworld Windows server via SteamCMD
## The +@sSteamCmdForcePlatformType windows flag is critical — it downloads
## the Windows binaries instead of Linux, which is required for UE4SS mods.
## -----------------------------------------------------------------------------
install_server() {
    log "Installing/Updating Palworld Windows Server (AppID ${APPID})"

    ## Fix permissions: Unraid uses FUSE-mounted volumes where chown may
    ## silently fail. Use chmod to ensure writeability regardless of filesystem.
    ## -R is needed because failed installs leave root-owned subdirectories.
    ## Also fix SteamCMD's own directory — it switches from root to steam internally.
    chmod -R 777 "${SERVER_DIR}" 2>/dev/null || true
    chown -R steam:steam /home/steam 2>/dev/null || true

    ## PATCH (not upstream): SteamCMD has a long-standing, well-documented bug
    ## (open since 2014, affects many games) where a failed/interrupted update
    ## writes StateFlags=6 / UpdateResult=6 into the appmanifest, and every
    ## subsequent run just reads that stale failure state and aborts instantly
    ## without even attempting a real download -- a self-reinforcing loop.
    ## Deleting the manifest before every attempt forces a genuine fresh check;
    ## it only affects SteamCMD's own tracking file, never the actual game
    ## files already on disk (Pal/, Saved/, mods, etc. are untouched).
    local stale_manifest="${SERVER_DIR}/steamapps/appmanifest_${APPID}.acf"
    if [ -f "${stale_manifest}" ]; then
        log "Removing appmanifest before update (works around a known SteamCMD stuck-state bug)"
        rm -f "${stale_manifest}"
    fi

    local manifest_arg=""
    if [ -n "${TARGET_MANIFEST_ID:-}" ]; then
        log "Pinning to manifest ${TARGET_MANIFEST_ID}"
        manifest_arg="-manifest ${TARGET_MANIFEST_ID}"
    fi

    ## Run SteamCMD as the steam user via gosu. This avoids the internal
    ## root→steam switch which can fail when the steam home dir isn't writable.
    ## PATCH (not upstream): SteamCMD has a known, documented transient failure
    ## mode on a fresh anonymous login ("Missing configuration" / "needs to be
    ## online") that typically self-resolves on an immediate retry within the
    ## same session -- confirmed tonight by testing manually. Without this loop,
    ## `set -e` kills the whole container on the very first hiccup, and a full
    ## container restart just starts a fresh login session that can hit the
    ## exact same transient issue again, looking like a persistent failure.
    local attempt
    for attempt in 1 2 3; do
        if gosu steam "${STEAMCMD}" \
            +@sSteamCmdForcePlatformType windows \
            +force_install_dir "${SERVER_DIR}" \
            +login anonymous \
            +app_update "${APPID}" ${manifest_arg} validate \
            +quit; then
            return 0
        fi
        log "SteamCMD failed (attempt ${attempt}/3) -- known transient issue, retrying in 5s"
        sleep 5
    done
    log "SteamCMD failed 3 times in a row -- giving up"
    return 1
}

## -----------------------------------------------------------------------------
## Install UE4SS (Palworld-specific build with MemberVariableLayout.ini fix)
## UE4SS only supports Windows, which is why we run the Windows server via Proton.
## Files installed: dwmapi.dll (loader) + ue4ss/ folder in Pal/Binaries/Win64/
## -----------------------------------------------------------------------------
install_ue4ss() {
    if [ "${ENABLE_UE4SS:-true}" != "true" ]; then
        log "UE4SS installation skipped (ENABLE_UE4SS != true)"
        return 0
    fi

    if [ -f "${WIN64_DIR}/dwmapi.dll" ]; then
        log "UE4SS already installed, skipping"
        return 0
    fi

    log "Installing UE4SS (Palworld experimental build)"
    curl -sL "${UE4SS_URL}" -o /tmp/ue4ss.zip
    unzip -q /tmp/ue4ss.zip -d "${WIN64_DIR}"
    rm -f /tmp/ue4ss.zip

    ## Configure UE4SS for headless dedicated server
    local ini="${WIN64_DIR}/UE4SS-settings.ini"
    if [ -f "${ini}" ]; then
        sed -i 's/GuiConsoleEnabled *= *1/GuiConsoleEnabled = 0/' "${ini}"
        sed -i 's/GuiConsoleVisible *= *1/GuiConsoleVisible = 0/' "${ini}"
        sed -i 's/bUseUObjectArrayCache *= *true/bUseUObjectArrayCache = false/' "${ini}"
        sed -i 's/GraphicsAPI *= *opengl/GraphicsAPI = dx11/' "${ini}"
        log "UE4SS configured for dedicated server (GUI off, UObjectArrayCache off, DX11)"
    fi
}

## -----------------------------------------------------------------------------
## Install PalDefender (optional; MIT). PalDefender is a standalone d3d9-injected
## mod, so it needs the d3d9=n,b Wine override (already set) -- not UE4SS.
## Enabled only when PALDEFENDER_URL points at a release zip (kept URL-driven so
## no third-party binary is baked into this image and the version is yours to
## pin). The zip is expected to unpack into Pal/Binaries/Win64 (d3d9.dll +
## PalDefender.dll + PalDefender/). Alternatively, drop the files into the game
## volume yourself and leave PALDEFENDER_URL unset.
## -----------------------------------------------------------------------------
install_paldefender() {
    if [ "${ENABLE_PALDEFENDER:-false}" != "true" ]; then
        return 0
    fi
    if [ -f "${WIN64_DIR}/PalDefender.dll" ]; then
        log "PalDefender already installed, skipping"
        return 0
    fi
    if [ -z "${PALDEFENDER_URL:-}" ]; then
        log "ENABLE_PALDEFENDER=true but PALDEFENDER_URL is unset -- skipping (set it to a PalDefender release zip, or place the files in the game volume yourself)"
        return 0
    fi
    log "Installing PalDefender from ${PALDEFENDER_URL}"
    curl -sL "${PALDEFENDER_URL}" -o /tmp/paldefender.zip
    unzip -oq /tmp/paldefender.zip -d "${WIN64_DIR}"
    rm -f /tmp/paldefender.zip
}

## -----------------------------------------------------------------------------
## Copy mods from mounted /mods volume into the server tree
##   /mods/Win64/  → UE4SS Lua/DLL mods  → Pal/Binaries/Win64/Mods/
##   /mods/pak/    → .pak file mods      → Pal/Content/Paks/
## -----------------------------------------------------------------------------
install_mods() {
    if [ -d "/mods/Win64" ]; then
        log "Installing UE4SS mods from /mods/Win64"
        mkdir -p "${WIN64_DIR}/Mods"
        cp -r /mods/Win64/* "${WIN64_DIR}/Mods/" 2>/dev/null || true
    fi

    if [ -d "/mods/pak" ]; then
        log "Installing pak mods from /mods/pak"
        mkdir -p "${SERVER_DIR}/Pal/Content/Paks"
        cp -r /mods/pak/* "${SERVER_DIR}/Pal/Content/Paks/" 2>/dev/null || true
    fi
}

## -----------------------------------------------------------------------------
## Ensure PalWorldSettings.ini exists (copy from DefaultPalWorldSettings.ini)
## Palworld 1.0: 119 total option keys (88 pre-1.0 + 31 new). The default
## template ships with all keys — we only override specific ones via env vars.
## -----------------------------------------------------------------------------
ensure_settings() {
    if [ ! -f "${SETTINGS_FILE}" ]; then
        log "Creating PalWorldSettings.ini from defaults"
        mkdir -p "${SETTINGS_DIR}"
        local default="${SERVER_DIR}/DefaultPalWorldSettings.ini"
        if [ -f "${default}" ]; then
            cp "${default}" "${SETTINGS_FILE}"
        else
            touch "${SETTINGS_FILE}"
        fi
    fi

    ## WorldOption.sav override: if the world was first created in-game,
    ## WorldOption.sav overrides PalWorldSettings.ini entirely. Warn the user.
    local save_dir="${SERVER_DIR}/Pal/Saved/SaveGames"
    if [ -d "${save_dir}" ]; then
        local world_opt
        world_opt=$(find "${save_dir}" -name "WorldOption.sav" 2>/dev/null | head -1)
        if [ -n "${world_opt}" ]; then
            log "WARNING: WorldOption.sav found at ${world_opt}"
            log "WorldOption.sav overrides PalWorldSettings.ini — env var settings may not apply"
            log "To fix: back up and delete WorldOption.sav, or set config before first world launch"
        fi
    fi
}

## -----------------------------------------------------------------------------
## Apply environment variables to PalWorldSettings.ini
## Palworld reads identity/network settings from this file, not CLI args.
## We use sed to update specific fields in the OptionSettings tuple.
## Note: Palworld 1.0 has 119 config keys — we only manage the high-value ones
## here. For gameplay rates (EXP, capture, etc.) edit the ini directly.
## -----------------------------------------------------------------------------
update_settings() {
    [ -f "${SETTINGS_FILE}" ] || return 0

    log "Applying server settings from environment variables"

    ## Disable exit-on-error: sed -i can fail on FUSE/network filesystems
    ## even when the underlying file is writable. We'd rather skip one
    ## broken setting than kill the entire container.
    set +e

    ## Helper: replace a FieldName="value" or FieldName=value in the ini
    set_field() {
        local field="$1" value="$2" quote="${3:-true}"
        if [ "${quote}" = "true" ]; then
            sed -i "s/${field}=\"[^\"]*\"/${field}=\"${value}\"/" "${SETTINGS_FILE}"
        else
            sed -i "s/${field}=[0-9]*/${field}=${value}/" "${SETTINGS_FILE}"
        fi
    }

    ## Helper: replace boolean fields (True/False)
    set_bool() {
        local field="$1" value="$2"
        sed -i "s/${field}=\(True\|False\)/${field}=${value}/" "${SETTINGS_FILE}"
    }

    ## Helper: replace tuple fields like CrossplayPlatforms=(Steam,Xbox,PS5,Mac)
    set_tuple() {
        local field="$1" value="$2"
        sed -i "s/${field}=([^)]*)/${field}=(${value})/" "${SETTINGS_FILE}"
    }

    ## Server identity
    [ -n "${SERVER_NAME:-}" ] && set_field ServerName "${SERVER_NAME}"
    [ -n "${SERVER_DESCRIPTION:-}" ] && set_field ServerDescription "${SERVER_DESCRIPTION}"
    [ -n "${ADMIN_PASSWORD:-}" ] && set_field AdminPassword "${ADMIN_PASSWORD}"
    [ -n "${SERVER_PASSWORD:-}" ] && set_field ServerPassword "${SERVER_PASSWORD}"
    [ -n "${MAX_PLAYERS:-}" ] && set_field ServerPlayerMaxNum "${MAX_PLAYERS}" false

    ## Network (1.0: RCON and REST API are also configurable in the ini)
    [ -n "${RCON_ENABLED:-}" ] && set_bool RCONEnabled "$(to_bool "${RCON_ENABLED}")"
    [ -n "${RCON_PORT:-}" ] && set_field RCONPort "${RCON_PORT}" false
    [ -n "${REST_API_ENABLED:-}" ] && set_bool RESTAPIEnabled "$(to_bool "${REST_API_ENABLED}")"
    [ -n "${REST_API_PORT:-}" ] && set_field RESTAPIPort "${REST_API_PORT}" false

    ## Public IP/port (for NAT/multi-homed setups — only advertises, doesn't change listen port)
    [ -n "${PUBLIC_IP:-}" ] && set_field PublicIP "${PUBLIC_IP}"
    [ -n "${PUBLIC_PORT:-}" ] && set_field PublicPort "${PUBLIC_PORT}" false

    ## Crossplay (1.0: CrossplayPlatforms tuple in PalWorldSettings.ini)
    [ -n "${CROSSPLAY_PLATFORMS:-}" ] && set_tuple CrossplayPlatforms "${CROSSPLAY_PLATFORMS}"

    ## PvP (1.0: requires all three toggles on together)
    if [ "${ENABLE_PVP:-false}" = "true" ]; then
        set_bool bIsPvP True
        set_bool bEnablePlayerToPlayerDamage True
        set_bool bEnableDefenseOtherGuildPlayer True
        log "PvP enabled (bIsPvP + bEnablePlayerToPlayerDamage + bEnableDefenseOtherGuildPlayer)"
    fi

    ## Gameplay multipliers (only set if non-empty — otherwise ini defaults apply)
    [ -n "${DIFFICULTY:-}" ] && set_field Difficulty "${DIFFICULTY}"
    [ -n "${EXP_RATE:-}" ] && set_field ExpRate "${EXP_RATE}" false
    [ -n "${PAL_CAPTURE_RATE:-}" ] && set_field PalCaptureRate "${PAL_CAPTURE_RATE}" false
    [ -n "${PAL_SPAWN_NUM_RATE:-}" ] && set_field PalSpawnNumRate "${PAL_SPAWN_NUM_RATE}" false
    [ -n "${PAL_EGG_HATCHING_TIME:-}" ] && set_field PalEggDefaultHatchingTime "${PAL_EGG_HATCHING_TIME}" false
    [ -n "${WORK_SPEED_RATE:-}" ] && set_field WorkSpeedRate "${WORK_SPEED_RATE}" false
    [ -n "${DAYTIME_SPEED_RATE:-}" ] && set_field DayTimeSpeedRate "${DAYTIME_SPEED_RATE}" false
    [ -n "${NIGHTTIME_SPEED_RATE:-}" ] && set_field NightTimeSpeedRate "${NIGHTTIME_SPEED_RATE}" false
    [ -n "${COLLECTION_DROP_RATE:-}" ] && set_field CollectionDropRate "${COLLECTION_DROP_RATE}" false
    [ -n "${ENEMY_DROP_ITEM_RATE:-}" ] && set_field EnemyDropItemRate "${ENEMY_DROP_ITEM_RATE}" false
    [ -n "${DEATH_PENALTY:-}" ] && set_field DeathPenalty "${DEATH_PENALTY}"

    ## Pal/player stat rates
    [ -n "${PAL_STOMACH_DECREACE_RATE:-}" ] && set_field PalStomachDecreaceRate "${PAL_STOMACH_DECREACE_RATE}" false
    [ -n "${PAL_STAMINA_DECREACE_RATE:-}" ] && set_field PalStaminaDecreaceRate "${PAL_STAMINA_DECREACE_RATE}" false
    [ -n "${PLAYER_STOMACH_DECREACE_RATE:-}" ] && set_field PlayerStomachDecreaceRate "${PLAYER_STOMACH_DECREACE_RATE}" false
    [ -n "${PLAYER_STAMINA_DECREACE_RATE:-}" ] && set_field PlayerStaminaDecreaceRate "${PLAYER_STAMINA_DECREACE_RATE}" false
    [ -n "${PAL_DAMAGE_RATE_ATTACK:-}" ] && set_field PalDamageRateAttack "${PAL_DAMAGE_RATE_ATTACK}" false
    [ -n "${PAL_DAMAGE_RATE_DEFENSE:-}" ] && set_field PalDamageRateDefense "${PAL_DAMAGE_RATE_DEFENSE}" false
    [ -n "${PLAYER_DAMAGE_RATE_ATTACK:-}" ] && set_field PlayerDamageRateAttack "${PLAYER_DAMAGE_RATE_ATTACK}" false
    [ -n "${PLAYER_DAMAGE_RATE_DEFENSE:-}" ] && set_field PlayerDamageRateDefense "${PLAYER_DAMAGE_RATE_DEFENSE}" false

    ## Base/guild limits
    [ -n "${BASE_CAMP_MAX_NUM:-}" ] && set_field BaseCampMaxNum "${BASE_CAMP_MAX_NUM}" false
    [ -n "${BASE_CAMP_WORKER_MAX_NUM:-}" ] && set_field BaseCampWorkerMaxNum "${BASE_CAMP_WORKER_MAX_NUM}" false
    [ -n "${GUILD_PLAYER_MAX_NUM:-}" ] && set_field GuildPlayerMaxNum "${GUILD_PLAYER_MAX_NUM}" false
    [ -n "${DROP_ITEM_MAX_NUM:-}" ] && set_field DropItemMaxNum "${DROP_ITEM_MAX_NUM}" false

    ## Invader enemy (disabling halves RAM — useful for constrained servers)
    [ -n "${ENABLE_INVADER_ENEMY:-}" ] && set_bool bEnableInvaderEnemy "$(to_bool "${ENABLE_INVADER_ENEMY}")"

    ## Restore strict error handling for the rest of the script
    set -e
}

## Convert "true"/"false" strings to "True"/"False" for UE ini format
to_bool() {
    case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in
        true|1|yes) echo "True" ;;
        *) echo "False" ;;
    esac
}

## -----------------------------------------------------------------------------
## Start scheduled backups via supercronic (if enabled)
## -----------------------------------------------------------------------------
setup_backup_cron() {
    local crontab_lines=""
    if [ "${BACKUP_ENABLED:-false}" = "true" ]; then
        local cron_expr="${BACKUP_CRON_EXPRESSION:-0 0 * * *}"
        log "Starting scheduled backups (cron: ${cron_expr})"
        crontab_lines="${cron_expr} /usr/local/bin/backup"$'\n'
    fi
    ## PATCH (not upstream): the dashboard's chat feature (app/api/chat) tails
    ## console.log for [CHAT]/join/leave lines from the game's own stdout.
    ## Since the server runs continuously, trim it periodically so it doesn't
    ## grow unbounded -- keep the last 5000 lines every 15 minutes.
    ## NOTE: rewrite into the SAME file via `cat > console.log` (not `mv`),
    ## since `mv` would swap in a new inode -- the tee process holding the
    ## original file open for append would then keep writing into a detached,
    ## unreadable file forever, invisible at this path. Truncate-and-rewrite
    ## in place keeps tee's existing file handle valid.
    crontab_lines="${crontab_lines}*/15 * * * * tail -n 5000 /palworld/console.log > /palworld/console.log.tmp 2>/dev/null && cat /palworld/console.log.tmp > /palworld/console.log && rm -f /palworld/console.log.tmp"
    printf '%s\n' "${crontab_lines}" > /tmp/crontab
    supercronic /tmp/crontab &
}

## -----------------------------------------------------------------------------
## Start the Palworld Windows server via Proton
## -----------------------------------------------------------------------------
start_server() {
    log "Starting Palworld Server via plain Wine"

    local args=""

    ## Community server mode (shows up in community server browser)
    if [ "${COMMUNITY:-false}" = "true" ]; then
        args="${args} EpicApp=PalServer"
    fi

    ## Multithreading flags (improve performance on multi-core CPUs)
    if [ "${MULTITHREADING:-true}" = "true" ]; then
        args="${args} -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS"
    fi

    ## Port overrides
    args="${args} -port=${PORT:-8211}"
    args="${args} -queryport=${QUERY_PORT:-27015}"
    ## PATCH (not upstream): -publicport was missing from the actual launch
    ## command entirely -- PublicPort in PalWorldSettings.ini only affects
    ## community-server-list visibility, NOT the real connection handshake.
    ## A known, real-world Proton+Docker Palworld reference (Pterodactyl's
    ## "Palworld Proton" egg) explicitly passes this as a launch flag; ours
    ## never did. Defaults to the same value as PORT unless PUBLIC_PORT is
    ## set separately (e.g. NAT mapping a different external port).
    args="${args} -publicport=${PUBLIC_PORT:-${PORT:-8211}}"

    ## RCON
    if [ "${RCON_ENABLED:-false}" = "true" ]; then
        args="${args} -rcon -rconport=${RCON_PORT:-25575}"
    fi

    ## REST API
    if [ "${REST_API_ENABLED:-false}" = "true" ]; then
        args="${args} -restapi -restapiport=${REST_API_PORT:-8212}"
    fi

    ## Fix ownership then drop to steam user.
    ## chmod -R 777 is already done by install_server for Unraid FUSE compat.
    ## chown is skipped — can fail silently on FUSE volumes.
    chown -R steam:steam "${SERVER_DIR}" 2>/dev/null || true

    ## cd into the Win64 directory — Proton can get confused by unix pathing
    ## if the working directory doesn't match the exe location
    ## PATCH (not upstream): plain Wine (unlike Proton's own wrapper script)
    ## doesn't set up XDG_RUNTIME_DIR itself, and Wine needs a valid, writable
    ## one to exist. Create a dedicated one with the permissions the XDG spec
    ## requires (0700), owned by the steam user Wine actually runs as.
    export XDG_RUNTIME_DIR=/tmp/runtime-steam
    mkdir -p "${XDG_RUNTIME_DIR}"
    chmod 0700 "${XDG_RUNTIME_DIR}"
    chown steam:steam "${XDG_RUNTIME_DIR}"
    ## PATCH (not upstream, 2026-08-08): recent Palworld builds require a display
    ## for graphics/RHI init even as a dedicated server under Wine (headless boot
    ## fails with wine "nodrv_CreateWindow: no driver could be loaded" +
    ## "Failed to get a GL context" -> access violation). Provide a headless
    ## virtual X display. -ac disables access control so the `steam` user can use
    ## the root-started display.
    export DISPLAY=:99
    rm -f /tmp/.X99-lock 2>/dev/null || true
    Xvfb :99 -screen 0 1024x768x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
    for _i in 1 2 3 4 5 6 7 8 9 10; do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.5; done
    echo "Launch command: wine ${SERVER_EXE}${args}"
    cd "${WIN64_DIR}"
    ## PATCH (not upstream): tee combined stdout+stderr to a file on the
    ## shared volume so the dashboard's chat feature can read it as a plain
    ## file, without needing Docker socket access. Process substitution
    ## (not a plain pipe) keeps wine itself as PID 1 under exec. Confirmed
    ## via a controlled before/after test that this does NOT affect shutdown
    ## timing -- the ~30s stop is pre-existing Wine/game behavior, unrelated.
    exec gosu steam wine "${SERVER_EXE}" ${args} > >(tee -a /palworld/console.log) 2>&1
}

## =============================================================================
## Main
## =============================================================================

## Install or update server
if [ ! -f "${SERVER_EXE}" ]; then
    log "Server not found, performing fresh install"
    install_server
elif [ "${ALWAYS_UPDATE_ON_START:-false}" = "true" ]; then
    install_server
fi

## Install UE4SS, PalDefender (optional), and mods
install_ue4ss
install_paldefender
install_mods

## Ensure settings file exists
ensure_settings
log "DEBUG: after ensure_settings"
update_settings
log "DEBUG: after update_settings"

## Start scheduled backups (if enabled)
setup_backup_cron
log "DEBUG: after setup_backup_cron"

## Start the server
start_server
