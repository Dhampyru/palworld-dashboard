#!/usr/bin/env bash
# =============================================================================
# palworld host-integration installer
# =============================================================================
# One-shot installer for the multi-server host integration: the control daemon
# (provisioning + non-default lifecycle) and the per-instance metrics publisher.
# After this, the dashboard's "New server" wizard and per-instance Start/Stop/
# Restart work — the web tier only ever writes flag files it owns; these root
# services act on them. The dashboard never gets Docker or sudo.
#
# Usage:  sudo ./install.sh            # install + enable + start
#         sudo ./install.sh --uninstall
#         ./install.sh --help
#
# Override defaults via env, e.g.:
#   sudo PALWORLD_DASH_UID=2001 PALWORLD_SRV_ROOT=/srv/palworld \
#        PALWORLD_INSTANCE_IMAGE=ghcr.io/dhampyru/palworld-game-server:latest \
#        ./install.sh
# =============================================================================
set -euo pipefail

DASH_UID="${PALWORLD_DASH_UID:-2001}"
DASH_GID="${PALWORLD_DASH_GID:-2001}"
SRV_ROOT="${PALWORLD_SRV_ROOT:-/srv/palworld}"
RUN_ROOT="${PALWORLD_RUN_DIR:-/run/palworld}"
INSTANCE_IMAGE="${PALWORLD_INSTANCE_IMAGE:-ghcr.io/dhampyru/palworld-game-server:latest}"
EXTRACTOR_IMAGE="${PALWORLD_EXTRACTOR_IMAGE:-ghcr.io/dhampyru/palworld-data-extractor:latest}"
BIN_DIR=/usr/local/bin
SHARE_DIR=/usr/local/share/palworld
ENV_FILE=/etc/palworld-control.env
TMPFILES=/etc/tmpfiles.d/palworld.conf
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\033[36;1m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[31;1m[install] error:\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

case "${1:-}" in -h|--help) usage ;; esac

[ "$(id -u)" = 0 ] || die "run as root (sudo)."

# ---- uninstall --------------------------------------------------------------
if [ "${1:-}" = "--uninstall" ]; then
  say "Disabling services…"
  systemctl disable --now palworld-control.service palworld-metrics.service 2>/dev/null || true
  rm -f /etc/systemd/system/palworld-control.service /etc/systemd/system/palworld-metrics.service
  systemctl daemon-reload
  rm -f "${BIN_DIR}/palworld-control" "${BIN_DIR}/palworld-metrics-publisher" "${TMPFILES}"
  say "Removed daemon, metrics publisher, units, and tmpfiles rule."
  say "KEPT (on purpose): ${SRV_ROOT} (registry + your instances/saves) and ${ENV_FILE}."
  exit 0
fi

# ---- prerequisites ----------------------------------------------------------
for c in systemctl docker jq install; do
  command -v "$c" >/dev/null 2>&1 || die "missing required command: $c"
done
[ -f "${HERE}/palworld-control" ] || die "run this from scripts/host/ (palworld-control not found next to it)."

# ---- binaries + instance template ------------------------------------------
say "Installing daemon + metrics publisher to ${BIN_DIR}…"
install -m0755 "${HERE}/palworld-control"           "${BIN_DIR}/palworld-control"
install -m0755 "${HERE}/palworld-metrics-publisher" "${BIN_DIR}/palworld-metrics-publisher"
install -d -m0755 "${SHARE_DIR}"
install -m0644 "${HERE}/instance-template.docker-compose.yml" "${SHARE_DIR}/instance-template.docker-compose.yml"

# ---- shared dir + registry (read by both the daemon and the dashboard) ------
say "Preparing ${SRV_ROOT} (registry + instances)…"
install -d -m0775 -o root -g "${DASH_GID}" "${SRV_ROOT}"
if [ ! -f "${SRV_ROOT}/registry.json" ]; then
  cat > "${SRV_ROOT}/registry.json" <<JSON
{
  "schemaVersion": 1,
  "note": "Palworld instance registry — managed by palworld-control + the dashboard. No secrets here.",
  "instances": []
}
JSON
  chown root:"${DASH_GID}" "${SRV_ROOT}/registry.json"
  chmod 0664 "${SRV_ROOT}/registry.json"
  say "Seeded an empty registry.json."
else
  say "registry.json already exists — leaving it."
fi

# Game-data extraction workspace: the dashboard uploads each instance's usmap to
# ${SRV_ROOT}/gamedata/<id>/mappings.usmap and reads the extracted data/icons back
# from there. setgid so subdirs the dashboard (gid ${DASH_GID}) creates keep the
# group; kept on --uninstall (it lives under ${SRV_ROOT}).
say "Preparing ${SRV_ROOT}/gamedata (usmap uploads + extracted datasets)…"
install -d -m2775 -o root -g "${DASH_GID}" "${SRV_ROOT}/gamedata"

# ---- /run/palworld (dashboard writes flag files here) -----------------------
say "Installing tmpfiles rule for ${RUN_ROOT} (owned by uid/gid ${DASH_UID}:${DASH_GID})…"
printf 'd %s 0755 %s %s -\n' "${RUN_ROOT}" "${DASH_UID}" "${DASH_GID}" > "${TMPFILES}"
systemd-tmpfiles --create "${TMPFILES}"

# ---- environment file (edit + restart to change) ---------------------------
if [ ! -f "${ENV_FILE}" ]; then
  say "Writing ${ENV_FILE}…"
  cat > "${ENV_FILE}" <<ENV
# palworld-control / metrics environment. Edit, then:
#   sudo systemctl restart palworld-control palworld-metrics
PALWORLD_REGISTRY=${SRV_ROOT}/registry.json
PALWORLD_SRV_ROOT=${SRV_ROOT}
PALWORLD_RUN_DIR=${RUN_ROOT}
PALWORLD_DASH_UID=${DASH_UID}
PALWORLD_DASH_GID=${DASH_GID}
PALWORLD_INSTANCE_TEMPLATE=${SHARE_DIR}/instance-template.docker-compose.yml
# Image the dashboard's "New server" wizard provisions instances from:
PALWORLD_INSTANCE_IMAGE=${INSTANCE_IMAGE}
# Game-data extraction: workspace root + the extractor image the daemon runs when
# a usmap is uploaded (usmap upload → picker names + Pal icons, no rebuild).
PALWORLD_GAMEDATA_ROOT=${SRV_ROOT}/gamedata
PALWORLD_EXTRACTOR_IMAGE=${EXTRACTOR_IMAGE}
# Optional: a pre-seeded Wine prefix dir copied into each new instance. Leave
# unset if your game-server image bakes its own prefix (this one does).
# PALWORLD_SEED_COMPATDATA=
ENV
  chmod 0644 "${ENV_FILE}"
else
  say "${ENV_FILE} already exists — leaving it (edit it to change settings)."
fi

# ---- systemd units ----------------------------------------------------------
say "Installing + enabling systemd services…"
cat > /etc/systemd/system/palworld-control.service <<UNIT
[Unit]
Description=Palworld multi-instance control daemon (provisioning + non-default lifecycle)
After=docker.service
Wants=docker.service

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${BIN_DIR}/palworld-control
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/palworld-metrics.service <<UNIT
[Unit]
Description=Palworld per-instance metrics publisher
After=docker.service
Wants=docker.service

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${BIN_DIR}/palworld-metrics-publisher
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now palworld-control.service palworld-metrics.service

say "Done. Status:"
systemctl --no-pager --lines=0 status palworld-control.service palworld-metrics.service 2>/dev/null | grep -E 'palworld-|Active:' || true
cat <<NEXT

Next:
  • Point the dashboard at ${SRV_ROOT} (bind-mount it at the SAME path, and
    /run/palworld too) — see the Host Integration + Multiple Servers docs.
  • Use the dashboard's "New server" wizard to provision instances; this daemon
    handles their lifecycle. Provisioned instances use PALWORLD_INSTANCE_IMAGE
    (edit ${ENV_FILE} to change).
  • Game-data (picker names + Pal icons): upload a mappings.usmap in the
    dashboard's Game Data card; this daemon runs PALWORLD_EXTRACTOR_IMAGE against
    that instance's pak and writes ${SRV_ROOT}/gamedata/<id>/{data,icons}.
  • Logs:   journalctl -u palworld-control -f
            journalctl -u palworld-metrics -f
  • Remove: sudo ./install.sh --uninstall   (keeps ${SRV_ROOT} + saves)
NEXT
