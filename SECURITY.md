# Security Policy

## Supported versions

This project is released from the `main` branch, and fixes land in the next
tagged release. Please test against the latest release or `main` before
reporting.

| Version | Supported |
| --- | --- |
| latest release / `main` | ✅ |
| older tags | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's **Security → "Report a vulnerability"** (Private
Vulnerability Reporting) on this repository. Include:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if possible),
- affected version/commit and your environment.

You'll get an acknowledgement, and a fix or mitigation will be coordinated
before any public disclosure. Please allow reasonable time to address the issue
before disclosing it elsewhere.

## Security model (context for reports)

This is an **admin tool** for Palworld dedicated servers. A few design points
worth knowing when assessing a report:

- The dashboard is intended to run **behind your own protection** (VPN,
  reverse-proxy auth, SSO, or IP allowlisting). It should not be exposed
  directly to the public internet.
- The browser authenticates with a **panel password**; the real Palworld REST
  admin password is kept **server-side** and injected only by the dashboard
  proxy. Per-server admin passwords for provisioned instances are generated and
  stored **host-side**, never sent to the browser or committed.
- The web container deliberately has **no Docker socket and no sudo**.
  Privileged actions (start/stop/restart, provisioning) go through a flag-file
  pattern consumed by a root-owned host process. See
  [Host Integration](content/deployment/host-integration.mdx).
- `DEMO_MODE=1` serves mock data and short-circuits every write, RCON, and
  lifecycle action — it never touches a real server.

## Out of scope

- **Palworld itself**, the dedicated-server binary, and Pocketpair's services.
- **Third-party mods** (UE4SS, PalDefender, PalSchema mods) — report those to
  their respective projects.
- Findings that require an already-compromised host or misconfiguration
  explicitly warned against in the docs (e.g. exposing the panel unauthenticated
  to the internet).
