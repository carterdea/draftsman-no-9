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
- [ ] Create dependency cache volumes (bun, npm, uv, pip) and add monthly prune cron.
- [ ] Implement per-repo setup profile schema and storage (Postgres repo_profiles table).
- [ ] Wire worker to read setup profile and mount correct cache volumes per job.
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
  draftsman_bun_cache:
  draftsman_npm_cache:
  draftsman_uv_cache:
  draftsman_pip_cache:
```

## Runner image strategy (layered)

One image. Shared cache volumes. No per-repo images.

- **Layer 1 — Base runner image:** git, bun, node, python, uv, common CLIs (curl, jq). Rebuilt weekly or on dependency bumps.
- **Layer 2 — Dependency cache volumes:** mounted at runtime, not baked in. Shared across jobs, accumulate naturally. See section below.
- **Layer 3 — Repo checkout:** ephemeral per job. `git clone` + checkout exact SHA into `/workspace`.

This avoids per-repo image builds while still getting fast installs from warm caches.

## Dependency cache volumes

Package manager caches are host-side Docker volumes, mounted read-write into every runner container.

| Dependency manager | Cache path in container | Volume name |
|---|---|---|
| bun | `/.bun/install/cache` | `draftsman_bun_cache` |
| npm/yarn | `/.npm` | `draftsman_npm_cache` |
| uv | `/.cache/uv` | `draftsman_uv_cache` |
| pip | `/.cache/pip` | `draftsman_pip_cache` |

The per-repo setup profile declares which dependency manager the repo uses. The worker mounts only the relevant cache volume(s).

Cache volumes are content-addressed by design (bun, uv, pip all deduplicate internally), so no per-repo isolation is needed. Add a monthly prune cron for hygiene:

```bash
# Prune cache volumes older than 30 days (safe — packages re-download on next miss)
docker volume ls -q -f name=draftsman_*_cache | xargs -I{} docker run --rm -v {}:/cache alpine find /cache -atime +30 -delete
```

## Per-repo setup profile contract

The README references "setup profiles" — this is the concrete contract. Each target repo has a profile that tells the runner how to set it up and validate it.

```json
{
  "repo": "owner/repo",
  "dependency_manager": "bun",
  "setup": "bun install",
  "validation": {
    "fast": ["bun run lint", "bun run typecheck"],
    "full": ["bun test"]
  }
}
```

Rules:
- `dependency_manager` selects which cache volumes to mount.
- `setup` runs once after checkout. Uses the same install command a human developer would run.
- `validation.fast` runs every Ralph Loop iteration. Should complete in seconds.
- `validation.full` runs only when fast checks pass, capped at 2–3 runs per job. Typically the test suite.
- All commands are the same ones humans use locally. No agent-specific wrappers.

Profiles are stored in Postgres (repo_profiles table) and editable via the admin dashboard.

## Ephemeral runner pattern (non-compose)

- Worker launches per-job container with `--rm`.
- Mount temp workspace + relevant dependency cache volume(s).
- Env: scoped GitHub token, job id, repo, commit SHA.
- No prod creds. No docker socket in runner.
- Kill on timeout. Upload logs/artifacts. Exit.
- Job flow in runner: clone repo → checkout exact SHA → restore dependency cache → run setup → run bounded Ralph loop (with tiered validation) → return structured result.

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
  -v draftsman_bun_cache:/.bun/install/cache \
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
