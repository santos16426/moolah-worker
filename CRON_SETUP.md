# Moolah Auto-post cron setup

This worker records due recurring items in Moolah. It does not charge a bank,
card, or payment provider. The worker has no database credentials and calls
only the Moolah API.

Canonical repository:
<https://github.com/santos16426/moolah-worker>

## Required deployment order

1. Deploy the Moolah API migration and API code.
2. Configure the shared worker secret on the API.
3. Deploy this worker as a scheduled container.
4. Run it manually once.
5. Enable the hourly cron schedule.
6. Enable Auto-post on a test recurring item.

Do not enable Auto-post for users before the worker's manual run succeeds.

## 1. Generate the shared secret

Generate a different value for local, staging, and production:

```bash
openssl rand -base64 32
```

Copy the generated value directly into both services' secret stores:

```text
Moolah API
  AUTO_POST_WORKER_SECRET=<generated value>

Moolah worker
  AUTO_POST_WORKER_SECRET=<same generated value>
```

Do not put the generated value in `.env.example`, GitHub source files, issue
comments, build arguments, Docker images, or browser environment variables.
If a real value is ever committed, rotate it immediately.

## 2. Configure and deploy the API

The API environment requires its existing variables plus:

```dotenv
AUTO_POST_WORKER_SECRET=replace-with-generated-secret
```

Apply the database migration before the new API starts:

```bash
cd api
npm ci
npx prisma migrate deploy
npm run build
```

Deploy the API, then verify:

```bash
curl --fail --silent --show-error https://YOUR_API_HOST/ready
```

Expected result: HTTP `200`.

The protected worker endpoint is:

```text
POST /internal/jobs/recurring-auto-post
Authorization: Bearer <AUTO_POST_WORKER_SECRET>
```

Do not expose this endpoint through the browser application.

## 3. Configure the worker

Production worker environment:

```dotenv
NODE_ENV=production
MOOLAH_API_URL=https://YOUR_API_HOST
AUTO_POST_WORKER_SECRET=replace-with-the-same-generated-secret
WORKER_TIMEOUT_MS=15000
WORKER_MAX_ATTEMPTS=3
```

Rules:

- `MOOLAH_API_URL` is the API origin only, without the endpoint path.
- Production URLs must use HTTPS.
- `AUTO_POST_WORKER_SECRET` must match the API exactly.
- Timeout is limited to `120000` milliseconds.
- Attempts are limited to `5`.
- The worker requires no `DATABASE_URL`, Redis credentials, cookies, or web
  secrets.

## 4. Local verification

API `.env`:

```dotenv
AUTO_POST_WORKER_SECRET=local-development-secret-at-least-32-chars
```

Worker `.env`:

```dotenv
NODE_ENV=development
MOOLAH_API_URL=http://localhost:4000
AUTO_POST_WORKER_SECRET=local-development-secret-at-least-32-chars
WORKER_TIMEOUT_MS=15000
WORKER_MAX_ATTEMPTS=3
```

Start the API, then run:

```bash
npm ci
set -a
source .env
set +a
npm run dev
```

A successful invocation exits `0` and logs:

```json
{
  "level": "info",
  "event": "auto_post_completed",
  "examined": 0,
  "posted": 0,
  "disabled": 0,
  "skipped": 0,
  "capped": false
}
```

The actual log also contains a timestamp, request ID, attempt, and duration.

## 5. Container build and manual run

Build:

```bash
docker build -t moolah-auto-post-worker .
```

Run against a hosted HTTPS API:

```bash
docker run --rm \
  -e MOOLAH_API_URL=https://YOUR_API_HOST \
  -e AUTO_POST_WORKER_SECRET="$AUTO_POST_WORKER_SECRET" \
  -e WORKER_TIMEOUT_MS=15000 \
  -e WORKER_MAX_ATTEMPTS=3 \
  moolah-auto-post-worker
```

Run against a macOS-hosted local API:

```bash
docker run --rm \
  -e NODE_ENV=development \
  -e MOOLAH_API_URL=http://host.docker.internal:4000 \
  -e AUTO_POST_WORKER_SECRET="$AUTO_POST_WORKER_SECRET" \
  moolah-auto-post-worker
```

## 6. Create the cron job

Deploy <https://github.com/santos16426/moolah-worker> as a scheduled Docker
job using the repository's `Dockerfile`.

Use:

```cron
0 * * * *
```

This runs once at the start of every hour. Use the image's default command:

```text
node dist/index.js
```

### Railway

1. Create a new service from the GitHub repository.
2. Select Dockerfile deployment.
3. Add all production worker environment variables.
4. Configure the service as a Cron Job with `0 * * * *`.
5. Trigger one manual run and inspect its JSON logs.
6. Do not run a second always-on replica.

### Render

1. Create a **Cron Job** from the GitHub repository.
2. Select the Docker runtime.
3. Add all production worker environment variables.
4. Set schedule to `0 * * * *`.
5. Use the Docker image's default command.
6. Run the job manually before enabling the schedule.

For another host, use its run-to-completion or scheduled-container product.
Do not deploy this repository as an always-on HTTP service.

## 7. End-to-end acceptance test

1. Create a test account in Moolah.
2. Create a recurring item due today.
3. Select the test account and enable **Auto-post on schedule**.
4. Trigger the worker manually.
5. Confirm exactly one Activity transaction was created.
6. Confirm amount, account, category, direction, and due date.
7. Trigger the worker a second time.
8. Confirm no duplicate transaction was created.
9. Pause the recurring item and confirm the next run does not post it.

## Failure handling

The worker retries only:

- network failures;
- HTTP `429`;
- HTTP `500`–`599`.

It fails immediately for authentication errors, invalid configuration, and
invalid API responses. Configure an alert for repeated nonzero job exits.

Common failures:

- HTTP `401`: secrets do not match; update both secret stores.
- HTTP `503` with Auto-post not configured: API secret is missing.
- Timeout: verify API health and networking before increasing the timeout.
- HTTPS validation error: production `MOOLAH_API_URL` is using HTTP.

## Rotation

To rotate the secret without losing scheduled entries:

1. Pause the cron schedule.
2. Generate a new secret.
3. Update the API secret and deploy/restart the API.
4. Update the worker secret.
5. Run the worker manually.
6. Resume the schedule.

The API's idempotency constraint prevents duplicate posting when a run is
retried.

## Rollback

1. Disable the cron schedule.
2. Disable Auto-post on affected recurring items.
3. Keep the additive database migration applied.
4. Rotate the secret if compromise is suspected.

Manual recurring posting remains available. Existing Activity entries are not
deleted automatically.
