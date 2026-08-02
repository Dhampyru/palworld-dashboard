#!/bin/bash
set -euo pipefail

## =============================================================================
## Palworld backup script
## =============================================================================
## Usage: docker exec palworld-server backup
## Or via supercronic: set BACKUP_CRON_EXPRESSION in crontab
##
## Flow: RCON save (if enabled) → tar SaveGames → optionally delete old backups
## =============================================================================

SERVER_DIR="${SERVER_DIR:-/palworld}"
SAVE_DIR="${SERVER_DIR}/Pal/Saved/SaveGames"
BACKUP_DIR="${SERVER_DIR}/backups"
RCON_PORT="${RCON_PORT:-25575}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
RCON_ENABLED="${RCON_ENABLED:-false}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
DELETE_OLD_BACKUPS="${DELETE_OLD_BACKUPS:-false}"
TZ="${TZ:-UTC}"

log() { echo -e "\033[36;1m[backup] $1\033[0m"; }

mkdir -p "${BACKUP_DIR}"

## Save the world via RCON before backing up (if RCON is enabled)
if [ "${RCON_ENABLED}" = "true" ] && [ -n "${ADMIN_PASSWORD}" ]; then
    log "Saving world via RCON before backup"
    rcon-cli -a 127.0.0.1:${RCON_PORT} -p "${ADMIN_PASSWORD}" "Save" 2>/dev/null || \
        log "WARNING: RCON save failed — backing up current state anyway"
    sleep 2  ## Give the server a moment to flush to disk
else
    log "RCON not enabled — backing up current state (may be slightly stale)"
fi

## Create timestamped backup
TIMESTAMP=$(TZ="${TZ}" date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/palworld-save-${TIMESTAMP}.tar.gz"

if [ -d "${SAVE_DIR}" ]; then
    log "Creating backup: ${BACKUP_FILE}"
    tar -czf "${BACKUP_FILE}" -C "${SERVER_DIR}/Pal/Saved" SaveGames 2>/dev/null
    log "Backup complete: $(du -sh "${BACKUP_FILE}" | cut -f1)"
else
    log "ERROR: Save directory not found at ${SAVE_DIR}"
    exit 1
fi

## Delete old backups if enabled
if [ "${DELETE_OLD_BACKUPS}" = "true" ] && [ "${BACKUP_RETENTION_DAYS}" -gt 0 ] 2>/dev/null; then
    log "Removing backups older than ${BACKUP_RETENTION_DAYS} days"
    find "${BACKUP_DIR}" -name "palworld-save-*.tar.gz" -mtime +${BACKUP_RETENTION_DAYS} -delete 2>/dev/null || true
    log "Old backups cleaned"
fi
