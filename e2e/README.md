# @gg/e2e — Playwright journey, axe gate, feed latency probe

Phase 1 acceptance coverage (docs/PLAN.md): the full user journey on
desktop + mobile viewports, axe-core critical-violation checks on key
routes, and a feed p95 probe.

## What runs where

The browser runs on the **laptop** (system Chromium at `/usr/bin/chromium`,
no Playwright browser download) against **gg_test-backed** instances so
staging data (gg_dev) stays clean:

| Service | Staging (do not touch) | E2E instances |
| ------- | ---------------------- | ------------- |
| API     | :4000 (gg_dev)         | :4100 (gg_test) |
| Web     | :3201 (gg_dev)         | :3202 (gg_test) |

## One-time setup (laptop)

```bash
cd /home/aman/gg-dev/app
# .env holds the gg_dev DATABASE_URL; derive the gg_test one from it.
TEST_URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2- | sed 's|/gg_dev|/gg_test|')

# Schema + seed fixtures in gg_test (idempotent).
DATABASE_URL=$TEST_URL pnpm --filter @gg/api db:migrate
DATABASE_URL=$TEST_URL pnpm --filter @gg/api db:seed

pnpm install   # picks up the @gg/e2e workspace package
```

## Start the E2E instances (laptop, two shells or nohup)

```bash
# API on :4100 against gg_test
DATABASE_URL=$TEST_URL API_PORT=4100 \
  CORS_ORIGINS=http://127.0.0.1:3202,http://localhost:3202 \
  pnpm --filter @gg/api start        # build first: pnpm --filter @gg/api... build

# Web on :3202, built into .next-e2e so staging's .next is never clobbered
NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4100 \
  pnpm --filter @gg/web build
NEXT_DIST_DIR=.next-e2e pnpm --filter @gg/web exec next start -p 3202
```

## Run

```bash
pnpm --filter @gg/e2e test            # journey + axe + media, desktop & mobile projects
pnpm --filter @gg/e2e test:journey    # journey only
pnpm --filter @gg/e2e test:axe        # axe only
```

Phase 2 media spec (`tests/media.spec.ts`, desktop): spawns the built
worker itself — export `DATABASE_URL` (gg_test) and a shared `MEDIA_DIR`
(the API instance on :4100 must run with the same `MEDIA_DIR`) so uploads
the browser makes become `ready` through the real pipeline. Worker dist
must be built first (`pnpm --filter @gg/worker build`).

Overrides: `E2E_BASE_URL` (web origin), `E2E_API_URL` (API origin),
`E2E_CHROME_PATH` (browser binary).

## Feed p95 probe (PLAN budget: p95 < 400 ms)

Read-only; safe against the staging API on gg_dev:

```bash
pnpm --filter @gg/e2e p95 -- --url http://127.0.0.1:4000 --n 200
```
