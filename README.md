# Fireweave metric injector

Multi-vendor metric ingestion with a durable traffic simulator.

## Prerequisites

- Node.js 22.13 or newer (pnpm 11 uses `node:sqlite`)
- pnpm 11
- Docker, for Postgres and Redis

## Setup

```bash
cp .env.example .env
openssl rand -base64 32   # ENCRYPTION_KEY
openssl rand -base64 32   # JWT_ACCESS_SECRET
openssl rand -base64 32   # JWT_REFRESH_SECRET
```

Put those values in `.env`. `ENCRYPTION_KEY` is 32 bytes, base64-encoded.

```bash
pnpm install
pnpm start
```

`pnpm start` runs Postgres, Redis, the API, the worker, and the UI. Saving a file reloads the process that owns it. `pnpm stop` shuts all of that down. The command prints the UI and API addresses. `GET /health` checks Postgres. Auth routes are `/auth/signup`, `/auth/login`, `/auth/refresh`, and `/auth/logout`. Everything under `/api/v1` requires `Authorization: Bearer`. OpenAPI is generated from the route schemas and served at `http://127.0.0.1:3000/docs`.

`pnpm db:migrate` runs `prisma migrate deploy` against `DATABASE_URL`. The API container does the same in its entrypoint before it listens.

The UI is the address `pnpm start` prints, normally port 3002. The browser talks only to that origin: Next proxies `/auth` and `/api/v1` to `API_URL` (default `http://127.0.0.1:3000`). `docker compose up` also starts the web service on 3002 with `API_URL=http://api:3000`. Local development leaves `CORS_ORIGINS` empty. Set it when the API is reached from another origin in production.

`/api/v1/vendor-accounts` stores OpenObserve, Datadog, and Sentry credentials encrypted with AES-256-GCM. A create or credential replacement calls the vendor and returns 422 when that check fails. Responses include a short hint, never the secret. Sentry accounts need a DSN plus the organization slug, project slug, and an org auth token, because a DSN only carries the numeric project id. List endpoints take `limit` (default 50, max 100) and an opaque `cursor`.

`POST /api/v1/jobs` saves a job and its metric definitions. A future `startTime` is `scheduled` and waits for a delayed starter; a start time that has already passed is `active` and gets a repeatable tick. Pause, resume, and delete update that schedule. `POST /api/v1/jobs/:id/inject` queues one point and does not move the simulation cursor. Definitions on a job are one set: a PATCH that includes `definitions` replaces every metric. That replacement is rejected with 409 while the job is `active`. Dependent metrics use an arithmetic formula (`+ - * /`, parentheses, `random()`, `normal(mean, sd)`) and are stored in `evalOrder`, after the metrics they name. A cycle is rejected and nothing is written. Tag keys are identifiers; values cannot contain commas or control characters. The tick simulator in `@fireweave/core` is a pure function of the job, the definitions, and the clock. The worker `pnpm start` launches is the process that runs those ticks: it takes a Redis lock, writes the batch before sending, and does not replay a window after a crash or a pause. Authenticated `/api/v1` routes allow 100 requests per minute per user. Vendor sends use a Redis token bucket (Datadog 300 per minute, OpenObserve 60 per second, Sentry 20 per second). The worker serves Prometheus metrics and `/health` on `WORKER_METRICS_PORT` (default 3001). The API does not serve `/metrics`. Signup, login, account changes, job changes, and an automatic lag failure write an audit row whose metadata has no secrets.

`docker compose up` also builds the API container. Its entrypoint runs `prisma migrate deploy` before the server listens.

## Rate

A tick covers `Δ = tickIntervalMs / 1000` seconds. The mean rate for that window is

```
λ(t) = peakRatePerSecond * diurnal(h) * weekendBlend(t) * m(t)
```

`h` is the local hour in the job timezone. `diurnal(14)` is 1, and the curve is periodic across midnight. `weekendBlend` is 1 on weekdays and 0.45 on Saturday and Sunday, with a two-hour ramp at each end of the weekend. `m(t)` is an Ornstein–Uhlenbeck multiplier clamped to `[0.5, 2]`, seeded from the job id and start time. `virtualUserCount` only scales how much `m` moves. It does not multiply `λ`.

## No backfill

The first window is `[now, now + Δ)`, not `[startTime, now)`. If the cursor falls behind, the missed gap is discarded and the next window still starts at `now`. Pause stops new ticks. Resume continues from the current time and does not replay the paused interval. A crash after the batch is written does not send that window again: startup marks a stale `in_flight` batch `abandoned` and moves the cursor forward when it is behind.

## Sentry transport

Sentry ingest is one `trace_metric` envelope, metrics spec 2.x. The request is `POST {dsn}/api/{projectId}/envelope/` with `X-Sentry-Auth: Sentry sentry_version=7, sentry_key={publicKey}, sentry_client=fireweave-metric-injector/0.1`. The item header is `{ "type": "trace_metric", "item_count": N, "content_type": "application/vnd.sentry.items.trace-metric+json" }`, followed by `{ "version": 2, "items": [...] }`. Counters and gauges keep those types. Histograms are sent as `distribution`. Statsd envelopes and OTLP metrics are not sent. A Sentry account stores the DSN and an org auth token. The token is used for the project check. The envelope uses the DSN public key.

## Failure retention

`IngestionFailure` rows and `dead` deliveries older than 7 days are deleted. The worker runs that sweep on startup and once a day after that. Delivered rows stay. There is no DLQ replay endpoint.

## Environment

| Variable                 | Required   | Purpose                                                                   |
| ------------------------ | ---------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`           | yes        | Postgres for the API and the worker                                       |
| `REDIS_URL`              | yes        | BullMQ and the outbound token buckets                                     |
| `ENCRYPTION_KEY`         | yes        | 32 bytes, base64. AES-256-GCM for vendor credentials                      |
| `JWT_ACCESS_SECRET`      | yes        | HS256 access tokens. At least 32 characters                               |
| `JWT_REFRESH_SECRET`     | yes        | At least 32 characters                                                    |
| `NODE_ENV`               | no         | `development` by default. `production` requires `CORS_ORIGINS`            |
| `PORT`                   | no         | API port, default 3000                                                    |
| `CORS_ORIGINS`           | production | Comma-separated browser origins                                           |
| `AUTH_RATE_LIMIT_MAX`    | no         | Auth routes per IP per minute, default 5                                  |
| `API_RATE_LIMIT_MAX`     | no         | Authenticated routes per user per minute, default 100                     |
| `WORKER_METRICS_PORT`    | no         | Worker `/metrics` and `/health`, default 3001                             |
| `PASSWORD_DENYLIST_PATH` | no         | Override for `data/password-denylist.txt`                                 |
| `TEST_DATABASE_URL`      | tests      | Defaults to the Compose `fireweave_test` database                         |
| `API_URL`                | web        | Where Next proxies `/auth` and `/api/v1`. Default `http://127.0.0.1:3000` |

## Tests

`pnpm test` uses Compose Postgres and Redis. It does not start Testcontainers. `USE_TESTCONTAINERS` is unused; leave it unset and point `TEST_DATABASE_URL` and `REDIS_URL` at Compose.

```bash
pnpm test
```

`pnpm test:vendor-sandbox` sends one live point to whichever vendor credentials are present in the environment (`SANDBOX_DATADOG_*`, `SANDBOX_OPENOBSERVE_*`, or `SANDBOX_SENTRY_*`). It is manual, it exits without calling a vendor when those variables are absent, and it is not part of `pnpm test`.

`apps/api/test/openobserve.live.test.ts` runs only when `OPENOBSERVE_EMAIL`, `OPENOBSERVE_STAGING_ORG`, `OPENOBSERVE_STAGING_PASSWORD`, `OPENOBSERVE_PRODUCTION_ORG`, and `OPENOBSERVE_PRODUCTION_PASSWORD` are set. It checks both orgs, then creates an account, rejects a bad password, and injects a counter, gauge, and histogram through the worker. OpenObserve stores a dotted metric name with underscores.

## Password denylist

`data/password-denylist.txt` is the SecLists top 100,000 passwords, pinned at commit `aad07fff50ca37af2926de4d07ff670bf3416fbc`.

- Source: https://github.com/danielmiessler/SecLists/blob/aad07fff50ca37af2926de4d07ff670bf3416fbc/Passwords/10_million_password_list_top_100000.txt
- The older `Passwords/Common-Credentials/10-million-password-list-top-100000.txt` path no longer exists.
- Line count: 100,000 non-empty entries.
- License: MIT (SecLists).

Passwords must be 12–128 characters and must not appear on that list, compared case-insensitively. Auth routes are limited to 5 requests per minute per IP.
