# Contributing

Thanks for your interest in improving the Palworld Server Dashboard! This is a
fork of [RNZ01/palworld-server-dashboard](https://github.com/RNZ01/palworld-server-dashboard)
(MIT), with expanded server operations. Contributions — bug reports, docs, and
code — are welcome.

## Development setup

```bash
git clone <your-fork>
cd palworld-dashboard
npm install
cp .env.example .env
```

You **don't need a real Palworld server** to work on most of the UI: run in
**demo mode**, which serves mock data and stubs every write/RCON/lifecycle
action.

```bash
DEMO_MODE=1 npm run dev      # http://localhost:3000, login with password: demo
```

Or run the full container build:

```bash
docker compose build && docker compose up -d
```

## Before you open a PR

- **Typecheck and build:**
  ```bash
  npm run typecheck        # route typegen + tsc
  npm run check            # typecheck + production build
  ```
  (No Node on your host? `docker run --rm -v "$PWD":/app -w /app node:20-alpine npx tsc --noEmit`.)
- **Match the surrounding code** — this codebase has many small, deliberate
  customizations. Prefer **surgical patches over rewrites**, and keep each PR
  focused on one change.
- **Docs** live under `content/` (Nextra). Update them when behavior changes.
- **Don't commit secrets or game-derived data.** `.env` is ignored; the
  `data/*.json` datasets ship empty on purpose (see
  [Item & Pal Datasets](content/configuration/item-pal-datasets.mdx)).

## How changes are integrated

Open an issue to discuss larger changes first, then a pull request. Maintainers
review and integrate accepted contributions, which then appear in a subsequent
tagged release. Please describe what the change does and how you tested it
(demo mode is fine for UI changes).

## Security

Please **do not** file security vulnerabilities as public issues — see
[SECURITY.md](SECURITY.md) for private reporting.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
