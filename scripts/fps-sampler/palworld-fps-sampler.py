#!/usr/bin/env python3
"""Server-side FPS history sampler for the Palworld Server Dashboard.

The dashboard's FPS histogram reads a rolling ring of samples maintained by
this script — NOT collected in the browser. That means the history is always
populated for the full window (default: the last hour) even when nobody has
the panel open, hidden browser tabs can't thin the data out, and server
downtime shows up as an honest gap instead of an interpolated line.

Run it as a sidecar container (see docker-compose.yml) or as a systemd
service on the game host (see palworld-fps-sampler.service.example).

MULTI-INSTANCE (#7): if a registry (PALWORLD_REGISTRY) is present, this samples
EVERY registered instance and writes a per-instance ring. The `default` (Primary)
server always samples via the env config below and writes FPS_HISTORY_FILE —
byte-identical to the single-server behavior. Every other instance samples
http://<host>:<its rest port> using the admin password from its own .env, and
writes a sibling `fps-history.<id>.json` in the same dir. With no registry it
falls back to the single env target (unchanged upstream behavior).

Configuration (environment variables):
  PALWORLD_REST_URL        Base URL of the DEFAULT server's REST API
                           (default: http://127.0.0.1:8212)
  PALWORLD_ADMIN_PASSWORD  The DEFAULT server's REST AdminPassword (required;
                           PALWORLD_REAL_ADMIN_PASSWORD is an accepted alias)
  FPS_HISTORY_FILE         DEFAULT ring file path, shared with the dashboard's
                           PALWORLD_FPS_HISTORY_FILE
                           (default: /run/palworld-metrics/fps-history.json)
  PALWORLD_REGISTRY        Instance registry JSON (default /srv/palworld/registry.json)
  FPS_SAMPLE_SECONDS       Poll cadence in seconds (default 5, clamped 1-60)
  FPS_WINDOW_MINUTES       History window in minutes (default 60, clamped 5-1440)
  FPS_SANE_MAX             Discard samples above this fps as invalid (default 65).

Behavior notes:
  - Writes are atomic (tmp file + rename): the dashboard never reads a torn file.
  - The ring is pruned to the window on every write and capped in sample count.
  - REST unreachable (server stopped/restarting) => nothing is appended; the
    dashboard renders that span as a gap. Logs only on state transitions.
  - Existing ring data is reloaded on demand, so restarting does not wipe it.
  - The registry is re-read every tick, so newly provisioned instances are
    picked up without restarting the sampler.
"""
import base64
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request


def env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(os.environ.get(name, ""))))
    except ValueError:
        return default


DEFAULT_REST_URL = os.environ.get("PALWORLD_REST_URL", "http://127.0.0.1:8212").rstrip("/")
DEFAULT_PASSWORD = (
    os.environ.get("PALWORLD_ADMIN_PASSWORD")
    or os.environ.get("PALWORLD_REAL_ADMIN_PASSWORD")
    or ""
)
DEFAULT_OUT_FILE = os.environ.get("FPS_HISTORY_FILE", "/run/palworld-metrics/fps-history.json")
REGISTRY_FILE = os.environ.get("PALWORLD_REGISTRY", "/srv/palworld/registry.json")

CADENCE_S = env_int("FPS_SAMPLE_SECONDS", 5, 1, 60)
WINDOW_MS = env_int("FPS_WINDOW_MINUTES", 60, 5, 1440) * 60 * 1000
FPS_SANE_MAX = env_int("FPS_SANE_MAX", 65, 1, 100000)
MAX_SAMPLES = WINDOW_MS // (CADENCE_S * 1000) + 1
HTTP_TIMEOUT_S = 4

_running = True


def _stop(signum, frame):
    global _running
    _running = False


def log(msg: str) -> None:
    print(msg, flush=True)


def out_file_for(instance_id: str) -> str:
    if instance_id == "default":
        return DEFAULT_OUT_FILE
    slash = DEFAULT_OUT_FILE.rfind("/")
    d = DEFAULT_OUT_FILE[:slash] if slash >= 0 else "."
    return f"{d}/fps-history.{instance_id}.json"


def read_env_value(path: str, key: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == key:
                    v = v.strip()
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                        v = v[1:-1]
                    return v
    except OSError:
        pass
    return ""


def targets() -> list:
    """[(id, metrics_url, password, out_file)] for every instance to sample.

    default always uses the env config (byte-identical to single-server). Others
    come from the registry (rest port + their own .env password). No registry ->
    just the default env target."""
    out = [(
        "default",
        f"{DEFAULT_REST_URL}/v1/api/metrics",
        DEFAULT_PASSWORD,
        DEFAULT_OUT_FILE,
    )]
    try:
        with open(REGISTRY_FILE, "r", encoding="utf-8") as f:
            reg = json.load(f)
        for inst in reg.get("instances", []):
            iid = inst.get("id")
            if not iid or iid == "default":
                continue
            if inst.get("enabled") is False:
                continue
            host = inst.get("rconHost", "host.docker.internal")
            port = (inst.get("ports") or {}).get("rest")
            if not port:
                continue
            pw = read_env_value(inst.get("envFilePath", ""), "ADMIN_PASSWORD")
            out.append((
                iid,
                f"http://{host}:{port}/v1/api/metrics",
                pw,
                out_file_for(iid),
            ))
    except (OSError, ValueError):
        pass
    return out


def build_request(url: str, password: str) -> urllib.request.Request:
    token = base64.b64encode(f"admin:{password}".encode()).decode()
    return urllib.request.Request(
        url,
        headers={"Accept": "application/json", "Authorization": f"Basic {token}"},
    )


def load_existing(out_file: str) -> list:
    try:
        with open(out_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        samples = data.get("samples", [])
        if isinstance(samples, list):
            return [
                s for s in samples
                if isinstance(s, dict)
                and isinstance(s.get("timestamp"), (int, float))
                and isinstance(s.get("fps"), (int, float))
            ]
    except (OSError, ValueError):
        pass
    return []


def prune(samples: list, now_ms: int) -> list:
    return [s for s in samples if now_ms - s["timestamp"] <= WINDOW_MS][-MAX_SAMPLES:]


def write_ring(out_file: str, samples: list, now_ms: int) -> None:
    tmp_file = os.path.join(os.path.dirname(out_file) or ".", f".{os.path.basename(out_file)}.tmp")
    payload = {
        "updatedAt": now_ms,
        "windowMs": WINDOW_MS,
        "cadenceMs": CADENCE_S * 1000,
        "samples": samples,
    }
    os.makedirs(os.path.dirname(out_file) or ".", exist_ok=True)
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.chmod(tmp_file, 0o644)
    os.replace(tmp_file, out_file)


def main() -> int:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    if not DEFAULT_PASSWORD:
        log("ERROR: PALWORLD_ADMIN_PASSWORD (or PALWORLD_REAL_ADMIN_PASSWORD) is not set")
        return 1

    rings: dict = {}   # id -> samples list (loaded lazily)
    states: dict = {}  # id -> "init"|"ok"|"down"|"unauthorized"
    log(
        f"palworld-fps-sampler: started (registry {REGISTRY_FILE}, cadence {CADENCE_S}s, "
        f"window {WINDOW_MS // 60000}min)"
    )

    start = time.monotonic()
    tick = 0

    while _running:
        now_ms = int(time.time() * 1000)
        for iid, url, password, out_file in targets():
            if not password:
                continue
            if iid not in rings:
                rings[iid] = load_existing(out_file)
                states[iid] = "init"
            new_state = states[iid]
            try:
                with urllib.request.urlopen(build_request(url, password), timeout=HTTP_TIMEOUT_S) as resp:
                    metrics = json.load(resp)
                fps = metrics.get("serverfps")
                if isinstance(fps, (int, float)) and fps > FPS_SANE_MAX:
                    log(f"[{iid}] DROP: serverfps={fps} > FPS_SANE_MAX={FPS_SANE_MAX} "
                        "(boot-window artifact) — sample discarded")
                    new_state = "ok"
                elif isinstance(fps, (int, float)):
                    rings[iid].append({"timestamp": now_ms, "fps": fps})
                    rings[iid] = prune(rings[iid], now_ms)
                    write_ring(out_file, rings[iid], now_ms)
                    new_state = "ok"
                else:
                    log(f"[{iid}] WARN: /metrics missing serverfps: {str(metrics)[:160]}")
            except urllib.error.HTTPError as e:
                new_state = "unauthorized" if e.code == 401 else "down"
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, ValueError):
                new_state = "down"  # server stopped / REST unreachable — honest gap

            if new_state != states.get(iid):
                if new_state == "ok":
                    log(f"[{iid}] REST reachable — sampling")
                elif new_state == "down":
                    log(f"[{iid}] REST unreachable (server down?) — gap will show")
                elif new_state == "unauthorized":
                    log(f"[{iid}] REST 401 — check admin password; retrying")
                states[iid] = new_state

        # Monotonic alignment: no drift accumulation across ticks.
        tick += 1
        next_at = start + tick * CADENCE_S
        delay = next_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            tick = int((time.monotonic() - start) / CADENCE_S)

    log("palworld-fps-sampler: stopping (signal)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
