# Moolah Auto-post Worker

Scheduled, run-to-completion worker for recurring Moolah ledger entries.

The worker does not connect to PostgreSQL and cannot move money. It sends one
authenticated request to the Moolah API, which remains the only owner of
authorization, idempotency, recurrence advancement, and ledger writes.

## Runtime contract

Required environment variables:

- `MOOLAH_API_URL`: API origin, for example `https://api.example.com`
- `AUTO_POST_WORKER_SECRET`: at least 32 characters and exactly equal to the
  value configured on the API

Optional controls:

- `WORKER_TIMEOUT_MS`: request timeout; default `15000`, maximum `120000`
- `WORKER_MAX_ATTEMPTS`: total transient-failure attempts; default `3`,
  maximum `5`

Generate a distinct secret for each environment:

```bash
openssl rand -base64 32
```

Store it only in the API and worker hosts' secret stores. Never expose it to
the browser or commit it.

## Local development

```bash
cp .env.example .env
npm ci
set -a && source .env && set +a
npm run dev
```

The local API must be running, have the same `AUTO_POST_WORKER_SECRET`, and
have the recurring Auto-post migration applied.

## Verification

```bash
npm run lint
npm test
npm run build
docker build -t moolah-auto-post-worker .
```

Run the built image once:

```bash
docker run --rm \
  -e NODE_ENV=development \
  -e MOOLAH_API_URL=http://host.docker.internal:4000 \
  -e AUTO_POST_WORKER_SECRET="$AUTO_POST_WORKER_SECRET" \
  moolah-auto-post-worker
```

Success exits `0`. Invalid configuration, rejected authentication, malformed
responses, and exhausted retries exit nonzero. Logs are one-line JSON and
never include the bearer secret.

## Deployment

Deploy this repository as a scheduled container, not an always-on web service.
Use the image's default command and an hourly schedule:

```cron
0 * * * *
```

Roll out in this order:

1. Apply the API migration.
2. Configure `AUTO_POST_WORKER_SECRET` on the API and deploy it.
3. Configure `MOOLAH_API_URL` and the same secret on this worker.
4. Run the worker manually and confirm an `auto_post_completed` log.
5. Enable the hourly schedule.
6. Enable Auto-post on a test recurring item due today and verify one Activity
   entry.
7. Run the worker again and verify that no duplicate entry appears.

Configure alerts for repeated nonzero exits. Retry handles only network errors,
HTTP 429, and HTTP 5xx; authentication and contract failures stop immediately.

## Rollback

1. Disable the worker schedule.
2. Disable Auto-post on affected recurring items in Moolah.
3. Keep the additive database migration in place.
4. Rotate `AUTO_POST_WORKER_SECRET` if credentials may be exposed.

Previously created ledger entries remain visible and editable. Removing the
worker does not affect manual recurring posting.

## Resource posture

The process starts hourly and exits after one API request, so it can scale to
zero between invocations. It has no queue, framework, database client, or
runtime package dependencies. Actual energy and carbon impact is unknown until
the deployment host provides measured runtime data.
