# Docker Execution Plan

Scope: Docker only. Control plane always-on. Job runner ephemeral.

## Decisions

- Control plane on always-on Mac now.
- Same compose shape later on Linux host.
- One queue system, not one queue per container.
- One ephemeral runner container per job.
- Worker orchestrates jobs; job logic runs inside runner container.
- Local-first backend is `docker run`; keep a runner interface so backend can swap later.
- Runner uses deterministic checkout (`git clone` + checkout exact SHA), not `git pull`.

## Tasks

- [ ] Create `docker-compose.yml` for `api`, `worker`, `redis`, `postgres`.
- [ ] Add healthchecks for every long-lived service.
- [ ] Set `restart: unless-stopped` on long-lived services.
- [ ] Add `.env.example` with non-secret defaults.
- [ ] Add `docker compose up -d` + recovery commands to `README.md`.
- [ ] Add runner contract doc (`image`, env vars, workspace mount, exit codes).
- [ ] Add runner interface in code (`start`, `status`, `cancel`, `logs`) with `DockerRunner` as v1.
- [ ] Add cleanup policy for dead containers/volumes/log growth.
- [ ] Add Mac host hardening notes (disable sleep, auto-restart Docker Desktop).
- [ ] Add explicit timeout + cancel behavior (`docker stop` then forced kill fallback).
- [ ] Ensure only control plane has Docker socket access in local dev; never mount socket in runner.
- [ ] Smoke test on Mac host (cold start, internet drop, reboot).

## `docker-compose.yml` spec (v1)

```yaml
services:
  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    command: bun run start
    env_file: .env
    ports:
      - "3000:3000"
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3000/health"]
      interval: 15s
      timeout: 3s
      retries: 5

  worker:
    build:
      context: .
      dockerfile: apps/worker/Dockerfile
    command: bun run start
    env_file: .env
    depends_on:
      redis:
        condition: service_healthy
      postgres:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "bun", "run", "healthcheck"]
      interval: 15s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    volumes:
      - redis_data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: draftsman
      POSTGRES_USER: draftsman
      POSTGRES_PASSWORD: draftsman
    volumes:
      - pg_data:/var/lib/postgresql/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U draftsman -d draftsman"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  redis_data:
  pg_data:
```

## Ephemeral runner pattern (non-compose)

- Worker launches per-job container with `--rm`.
- Mount temp workspace only.
- Env: scoped GitHub token, job id, repo, commit SHA.
- No prod creds. No docker socket in runner.
- Kill on timeout. Upload logs/artifacts. Exit.
- Job flow in runner: clone repo, checkout exact SHA, setup, run bounded Ralph loop, run validation, return structured result.

Example run shape:

```bash
docker run --rm \
  --name draftsman-job-$JOB_ID \
  --network draftsman_default \
  -e JOB_ID \
  -e GITHUB_TOKEN \
  -e REPO \
  -e COMMIT_SHA \
  -v /tmp/draftsman/$JOB_ID:/workspace \
  ghcr.io/your-org/draftsman-runner:latest
```

## Ops notes

- Mac host: prevent sleep, enable Docker Desktop auto-start.
- Daily cleanup cron: prune old images/volumes with safe age filter.
- Backups: Postgres volume snapshot schedule.
- Logs: keep size caps to avoid disk fill.

## Done looks like

- `docker compose up -d` survives reboot + transient internet loss.
- `api` + `worker` auto-recover without manual steps.
- Job container starts <10s, exits clean, leaves audit trail.
