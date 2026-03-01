# Secrets Management Plan

How Draftsman No. 9 handles secrets for its own infrastructure and for target repos running in ephemeral containers.

## Problem

Two distinct secret domains exist:

1. **Infrastructure secrets** — what Draftsman itself needs to run (Trello API key, GitHub App credentials, Postgres password, etc.). These are standard `.env` concerns.

2. **Runner secrets** — what each target repo needs inside its ephemeral Docker container to install dependencies, run tests, and build. These `.env` files are gitignored in the target repos (correctly), so a fresh `git clone` into a container starts with zero secrets. The container is wiped after every job. There is no persistence inside the runner.

The infrastructure secrets are a solved problem (`.env` file). The runner secrets are the gap this plan fills.

## Decisions

- Infrastructure secrets: single `.env` file at repo root, loaded by `docker-compose` and Bun processes.
- Runner secrets: host-side `.env` files in a persistent directory, injected into runner containers via `--env-file`.
- No external secret manager dependency for v1. 1Password CLI is a documented upgrade path.
- Runner env files are never committed to any git repo.

## Infrastructure Secrets (Draftsman's Own)

### Location

```
draftsman-no-9/.env          # git-ignored, loaded by docker-compose and Bun
draftsman-no-9/.env.example  # committed, documents all required variables (no values)
```

### Required variables

```bash
# Postgres
POSTGRES_URL=postgres://draftsman:password@localhost:5432/draftsman
POSTGRES_DB=draftsman
POSTGRES_USER=draftsman
POSTGRES_PASSWORD=

# Redis
REDIS_URL=redis://localhost:6379

# GitHub App
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY=        # base64-encoded PEM
GITHUB_APP_WEBHOOK_SECRET=

# Trello
TRELLO_API_KEY=
TRELLO_API_TOKEN=
TRELLO_WEBHOOK_SECRET=

# Slack (future)
# SLACK_BOT_TOKEN=
# SLACK_SIGNING_SECRET=

# API auth
API_BEARER_TOKEN=              # for internal/MCP access

# Runner secrets directory (default: ~/.draftsman/envs)
RUNNER_ENVS_DIR=
```

### Loading

- `docker-compose.yml` already uses `env_file: .env` for `api` and `worker` services.
- Bun processes read from `process.env` (populated by docker-compose or shell).
- The `.env.example` file is committed and kept in sync with actual requirements. It contains keys and comments, never values.

## Runner Secrets (Per-Repo)

### Location

```
~/.draftsman/envs/
  acme--backend.env
  acme--frontend.env
  internal--billing-service.env
```

The directory path defaults to `~/.draftsman/envs/` and is configurable via the `RUNNER_ENVS_DIR` environment variable.

### Naming convention

File name is derived from the repo's `owner` and `name`:

```
{repo_owner}--{repo_name}.env
```

Double-dash (`--`) separates owner from name. This avoids conflicts with repos that have hyphens in their names (e.g., `acme--my-cool-app.env`).

### File format

Standard `.env` format (same as what the target repo would use locally):

```bash
# acme--backend.env
DATABASE_URL=postgres://test:test@host.docker.internal:5433/acme_test
NPM_TOKEN=npm_abc123
STRIPE_TEST_KEY=sk_test_xyz
REDIS_URL=redis://host.docker.internal:6380
```

### How secrets get into the container

The worker resolves the env file path before launching the runner container:

```
1. Look up repo_profiles for owner + name
2. Derive env file path: {RUNNER_ENVS_DIR}/{owner}--{name}.env
3. If file exists → pass --env-file to docker run
4. If file does not exist → run without --env-file (repo may not need secrets)
5. Log which path was checked and whether it was found (audit trail)
```

### Updated `docker run` shape

```bash
IMAGE_TAG="draftsman-runner:acme-backend:a1b2c3"
ENV_FILE="$HOME/.draftsman/envs/acme--backend.env"

docker run --rm \
  --name draftsman-job-$JOB_ID \
  --network draftsman_default \
  -e JOB_ID \
  -e GITHUB_TOKEN \
  -e REPO \
  -e COMMIT_SHA \
  --env-file "$ENV_FILE" \
  -v /tmp/draftsman/$JOB_ID:/workspace \
  -v draftsman_bun_cache:/.bun/install/cache \
  $IMAGE_TAG
```

When no env file exists, the `--env-file` flag is omitted entirely.

### What runner env files should contain

Only secrets the repo needs to install, test, and build. Typical contents:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Test database connection |
| `NPM_TOKEN` / `GITHUB_TOKEN` (scoped) | Private package registry auth |
| `STRIPE_TEST_KEY` | Third-party API test keys |
| `REDIS_URL` | Test Redis instance |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3/SQS in test mode |
| `LICENSE_KEY` | Commercial dependency license |

What runner env files should **not** contain:

- Production credentials
- Draftsman's own secrets (GitHub App key, Trello token, etc.)
- Docker socket paths or host system config

### Discovery: `.env.example` in target repos

Most repos already have a `.env.example` or `.env.sample` documenting required variables. When setting up a new repo in Draftsman:

1. Check the target repo for `.env.example`, `.env.sample`, or similar.
2. Use it as a template to create `~/.draftsman/envs/{owner}--{name}.env`.
3. Fill in test-safe values.

This is a manual step. Draftsman does not auto-discover or auto-provision secrets.

## Security Constraints

- Runner env files live on the host filesystem, outside any git repo.
- The `~/.draftsman/envs/` directory should be `chmod 700` (owner-only access).
- Individual env files should be `chmod 600`.
- Runner containers receive only their own repo's env file. No cross-repo secret leakage.
- Runner containers have no access to Draftsman's infrastructure `.env`.
- Runner containers have no Docker socket access (enforced in `DOCKER_EXECUTION_PLAN.md`).
- Secrets are passed as environment variables, not mounted files inside the container. They exist only in the container's process environment and are gone when the container exits.

### Permissions setup

```bash
mkdir -p ~/.draftsman/envs
chmod 700 ~/.draftsman/envs
# After creating each env file:
chmod 600 ~/.draftsman/envs/acme--backend.env
```

## Audit Trail

Every job logs:

| Event kind | Payload |
|---|---|
| `runner_env_resolved` | `{ path, found: true/false }` |

The **values** of secrets are never logged. Only the path and whether the file was found.

If a runner fails because of missing secrets (e.g., `npm install` fails on a private registry), the validation failure output is captured in the normal `command_executed` / `validation_ran` audit events. The operator can then check whether the env file exists and has the right keys.

## Upgrade Path: 1Password CLI

For operators who want centralized secret management, rotation, and audit:

### How it works

1. Store per-repo secrets as items in a 1Password vault (e.g., vault "Draftsman").
2. Use `op` CLI to populate the host-side env files, or inject directly.

### Option A: Populate env files from 1Password

```bash
# One-time or periodic sync
op item get "acme/backend" --vault Draftsman --format json \
  | jq -r '.fields[] | "\(.label)=\(.value)"' \
  > ~/.draftsman/envs/acme--backend.env
chmod 600 ~/.draftsman/envs/acme--backend.env
```

The rest of the system works exactly the same — it still reads the host-side env file.

### Option B: Direct injection (skip env files)

```bash
# Template file with 1Password references
# acme--backend.env.tpl
DATABASE_URL=op://Draftsman/acme-backend/DATABASE_URL
NPM_TOKEN=op://Draftsman/acme-backend/NPM_TOKEN

# At container launch
op run --env-file=acme--backend.env.tpl -- docker run --rm ...
```

This eliminates env files on disk entirely. Requires the `op` CLI to be available and authenticated at runtime.

### When to upgrade

- When managing more than ~10 repos (file management becomes tedious).
- When secret rotation needs to be centralized.
- When running Draftsman unattended on a server (use a 1Password Service Account token).

The v1 host-side env file approach does not need to change to support this. Option A is purely additive. Option B would require a small change to the runner launch logic in the worker.

## Implementation Tasks

- [ ] Create `~/.draftsman/envs/` directory with correct permissions on host.
- [ ] Create `.env.example` at repo root documenting all infrastructure variables.
- [ ] Add `RUNNER_ENVS_DIR` to infrastructure `.env` config.
- [ ] Update runner launch logic in worker to resolve and pass `--env-file` when present.
- [ ] Add `runner_env_resolved` audit event to job event kinds.
- [ ] Document per-repo env file setup in operator guide.

## Done Looks Like

- Draftsman's own services start with a single `.env` file via `docker-compose`.
- Each target repo's runner container receives its secrets via `--env-file` from the host directory.
- Missing env files are handled gracefully (no crash, just no `--env-file` flag).
- Secret presence/absence is logged in the audit trail without leaking values.
- Adding a new repo's secrets is: create a file, fill in values, `chmod 600`. Done.
