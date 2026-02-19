# Draftsman No. 9

Draftsman No. 9 is an internal system that turns tickets into safe, auditable pull requests.

It can be invoked from Trello (and later Slack or MCP) to investigate issues, fix bugs, run validation, and open PRs — with strong guardrails, deep audits, and explicit human checkpoints when needed.

Draftsman No. 9 is **not** autonomous.  
It is procedural, bounded, validation-gated, and opinionated.

---

## What Draftsman No. 9 Does

When explicitly invoked, Draftsman No. 9 will:

1. Resolve the correct repository for a ticket (usually via Trello label → repo mapping).
2. Create an isolated, ephemeral execution environment.
3. Optionally reproduce the issue (Playwright CLI).
4. Apply a bounded “Ralph loop” to:
   - analyze
   - edit code
   - run validation
   - iterate (with hard limits)
5. Open a pull request if — and only if — validation passes and guardrails are respected.
6. Post results back to Trello / Slack.
7. Record a complete audit trail of everything it did and why.

It can also stop mid-execution and ask a human for clarification before proceeding.

---

## Goals

- Deterministic “ticket → PR” workflow.
- Safe-by-default execution.
- Deep, reconstructable audits.
- Validation-gated pull requests.
- Easy swapping of AI agents (Codex CLI / Claude Code).
- Clear human-in-the-loop escalation.
- Reusable backend that can later be exposed via MCP.

---

## Non-Goals

- Fully autonomous background fixing.
- Auto-merging.
- Multi-repo refactors.
- Long-lived stateful workers.
- Running with production credentials.
- “Bot personality.”

---

## Stack (Opinionated)

- **Runtime:** Bun
- **Testing:** Bun built-in test runner (`bun:test` via `bun test`)
- **API Framework:** Plain Bun HTTP server
- **Database:** Postgres
- **Queue:** BullMQ + Redis
- **Execution:** Ephemeral runners (GitHub Actions recommended)
- **Browser Repro:** Playwright CLI
- **Agents:** Codex CLI and Claude Code (swappable)
- **Future Interface:** MCP (for orchestrator tools like poke.com)

Fastify is optional and not required for this system.  
Default is plain Bun unless proven otherwise by operational complexity.

---

## High-Level Architecture

### Control Plane (Always-On)

- Webhook Receiver (Trello now, Slack later)
- Repo Resolver (label → repo mapping + overrides)
- Policy Engine (guardrails, limits, modes)
- Job Queue (BullMQ)
- Audit Store (Postgres)
- Admin Dashboard (audit visibility)

### Execution Plane (Ephemeral per Job)

- Fresh workspace checkout
- Agent execution (Codex / Claude)
- Ralph Loop Controller
- Optional Playwright repro
- Validation runner
- PR creation
- Result notification

### Runner Strategy (High-Level)

- BullMQ is used for durable queueing and retries.
- The worker is an orchestrator, not the execution environment.
- Each queued job runs in its own ephemeral container (`docker run --rm` locally).
- BullMQ does not create containers directly; the worker dispatches the runner backend.
- Bun workers are optional for intra-job parallelism, not queue durability.

---

## Invocation Modes

### \`@draftsman investigate\`

- No PR is created.
- Draftsman No. 9 analyzes the repo and ticket.
- Posts findings, suspected root cause, and recommended fix.
- Used when context is incomplete or risk is unclear.

### \`@draftsman fix\`

- PR creation is allowed **only if** validation passes.
- Uses a bounded Ralph loop.
- Respects all guardrails.
- Stops and asks questions if required.

---

## Repo Resolution

Default behavior:
- Trello label → repo mapping (stored in Postgres).

Overrides:
- Ticket contains \`Repo: owner/name\`
- Custom “Repo” field (if configured)

If repo resolution is ambiguous:
- Draftsman No. 9 stops.
- Posts a comment requesting clarification.
- No code is touched.

---

## Ralph Loop (Bounded Iteration)

The Ralph loop is only used in \`fix\` mode.

Loop shape:

1. Plan changes
2. Apply edits
3. Run fast validation (lint + typecheck)
4. If fast checks fail → observe results, iterate immediately
5. If fast checks pass → run full validation (test suite)
6. Observe results
7. Iterate (up to hard limits)

### Tiered Validation

Validation is split into two tiers, declared per-repo via setup profiles (see \`DOCKER_EXECUTION_PLAN.md\`).

- **Fast tier** (every iteration): lint, typecheck — whatever the repo's \`validation.fast\` declares. Runs in seconds. Gives the agent quick feedback without burning test suite runs.
- **Full tier** (gated, capped): test suite, build — whatever the repo's \`validation.full\` declares. Only runs when fast checks pass. Capped at 2–3 runs per job to limit compute.

If the full tier fails, results are fed back to the agent as context for the next iteration. This is the CI feedback loop — the agent sees exactly what a human developer would see from a failed test run.

### Hard Limits

Enforced by the controller (not prompts):

- Max iterations: 3–5
- Max runtime: ~15 minutes
- Max full validation runs: 2–3
- Max files changed
- Max LOC delta
- Stop on repeated identical failures
- Stop if diff grows without convergence

If limits are exceeded:
- Execution stops
- Draftsman No. 9 reports findings
- Human input is required to continue

---

## Validation Gates

A PR may only be opened if at least one validation signal passes:

- Tests
- Typecheck
- Lint
- Build

Validation commands are defined per-repo via setup profiles.

If a repo has no validation:
- \`investigate\` is required, or
- An explicit override flag must be used (discouraged).

### Initial Test Scope (MVP)

- `packages/core`: unit tests for invocation parsing and shared pure logic.
- `apps/api`: route-level tests for health and webhook request handling.
- `apps/worker`: unit tests for worker config resolution and deterministic status output.
- Runner command: `bun test`.

---

## Playwright CLI Integration

Playwright is optional and deterministic.

Used when:
- Ticket includes a URL + repro steps
- Repo profile requires browser repro
- Explicit \`--repro\` flag is provided

Artifacts collected:
- Trace
- Screenshots / video
- Console logs

Artifacts are linked in:
- Audit logs
- Trello / Slack responses

---

## Guardrails (Non-Negotiable)

### Job Creation
- Explicit invocation only
- Repo must resolve deterministically
- Invoker must be allow-listed
- Per-repo and global concurrency limits

### Execution
- Ephemeral workspace per job
- Non-root execution
- No Docker socket access
- No production credentials
- Scoped GitHub App credentials only
- Optional network egress restrictions

### Ralph Loop
- Iteration caps
- Diff size limits
- Path allow-listing
- No dependency upgrades unless explicitly allowed
- No infra / auth / payments changes by default

### PR Creation
- Validation-gated
- Small, reviewable diffs only
- No auto-merge
- Clear PR summary required

---

## Human-in-the-Loop: Asking Questions

Draftsman No. 9 can enter a \`WAITING_FOR_INPUT\` state.

Triggers include:
- Ambiguous fixes
- Risky changes
- Missing acceptance criteria
- Validation cannot run
- Multiple reasonable approaches exist

Questions are:
- Explicit
- Structured
- Often multiple-choice

Execution pauses without losing state.  
Answers resume the job exactly where it stopped.

---

## Audits (First-Class Feature)

Every job produces an immutable audit trail:

- Invocation source + user
- Ticket snapshot at invocation time
- Repo resolution decision
- Agent used + version
- Ralph loop iterations
- Commands executed
- Validation outputs
- Diff summary
- Playwright artifacts
- Final outcome (PR URL / blocked / needs-info / failed)

Audits enable:
- Trust
- Debugging
- Cost analysis
- Postmortems
- Re-runs

---

## Audit Dashboard

A simple internal dashboard served from the Bun API.

Views:
- Job list (status, repo, invoker, duration)
- Job detail (timeline, logs, diffs, artifacts)
- Repo mappings + setup profiles

Implementation:
- Server-rendered HTML initially
- Protected behind internal auth / VPN

This is intentionally boring and usable.

---

## Agent Abstraction

Agents are adapters behind a stable interface.

Supported:
- Codex CLI
- Claude Code

Each agent receives:
- Workspace path
- Structured work order
- Guardrails
- Validation feedback on retries
- Optional MCP servers (declared per-repo in setup profile)

Agents never control:
- Execution limits
- Validation gating
- PR creation rules

### MCP Servers in Runner

Runners can optionally expose MCP servers to agents during execution. These are declared per-repo in the setup profile, not globally.

Currently planned:
- **Context7** — library/framework documentation lookup. Useful when the agent needs API reference for unfamiliar dependencies.

Not planned:
- GitHub MCP (agent uses scoped GitHub tokens directly)
- Sourcegraph code search MCP (agent works in a local checkout)

This allows easy swapping without rewriting orchestration.

---

## Instruction System (Per-Repo Skills + Prompt Profiles)

Draftsman No. 9 should support layered instructions so behavior can change by repo without changing core code.

Recommended instruction order (highest priority last):

1. Global non-negotiable system rules (safety, guardrails, audit requirements)
2. Invocation mode rules (`investigate` vs `fix`)
3. Repo profile rules (validation, path constraints, risky-area restrictions)
4. Ticket-scoped instructions (explicit acceptance criteria, constraints)
5. Skill instructions (loaded only when selected)

Later layers can specialize behavior, but cannot override non-negotiable guardrails enforced in code.

### Skill Format

Use a skill format compatible with Codex/Claude skill patterns:

- `SKILL.md` with clear trigger conditions and workflow instructions
- Optional `references/` docs loaded only when needed
- Optional `scripts/` for deterministic repeated tasks

Skill examples:
- `rails-safe-migration`
- `shopify-liquid-patterns`
- `playwright-repro-triage`
- `payments-change-hardening`

### Skill Selection

Skills can be attached by:
- repo default profile
- repo + label mapping
- explicit ticket directive (for example: `Skills: rails-safe-migration,playwright-repro-triage`)

Selection should be deterministic and logged in the audit trail:
- which skills were considered
- which were loaded
- why each was selected or skipped

### Skill Storage (Public Parent Repo, Private Skills Repo)

Do not use a submodule for skills if the parent repo is public.

Recommended pattern:
- Keep skills in a nested directory (for example `./.draftsman-skills/`)
- Initialize that directory as its own independent git repo
- Ignore it in the parent repo via `.gitignore`

Example setup:

```bash
mkdir -p .draftsman-skills
cd .draftsman-skills
git init
```

Parent `.gitignore` entry:

```gitignore
/.draftsman-skills/
```

If the parent repo already tracked files there, untrack once:

```bash
git rm -r --cached .draftsman-skills
```

Operationally:
- Parent repo tracks only metadata (`skill_id`, `version`, `hash`)
- Runtime loads skill content from `SKILLS_DIR` (default `./.draftsman-skills`)
- Audits record `skill_id + version + hash`, not private skill contents

### MVP Alternative (Prompt Profile Switch)

If full skill loading is too heavy for v1, start with a simple per-repo prompt profile switch:

- `profile = rails_api | shopify_theme | python_service | unknown`
- `switch(profile)` applies a short, curated instruction block

Then evolve to skill composition once workflows stabilize.

### Suggested Rollout

1. Implement repo prompt profiles first (fastest, least moving parts)
2. Add explicit ticket-level skill overrides
3. Add reusable skill registry with deterministic selection rules
4. Add audit UI showing instruction stack per job

This keeps v1 simple while preserving a clean path to richer skill-based behavior.

---

## MCP (Future)

Draftsman No. 9 is designed so Trello, Slack, and MCP are just front-ends.

Planned MCP endpoints:
- \`create_job\`
- \`get_job\`
- \`list_jobs\`
- \`resume_job\` (for human answers)

MCP jobs are audited identically to webhook jobs.

---

## Repo Layout (Proposed)

\```text
apps/
  api/          # Bun API server
  worker/       # BullMQ consumer + job orchestration

packages/
  core/         # policies, ralph loop, repo resolver
  agents/       # codex + claude adapters
  playwright/   # CLI wrappers + artifact handling
  db/           # migrations + queries
  mcp/          # MCP server (future)
\```

---

## Deployment

Recommended:
- API + worker on Fly.io (or similar)
- Managed Postgres
- Managed Redis
- Execution via GitHub Actions (ephemeral)

Development:
- Local Bun runtime
- Redis + Postgres via Docker Compose

Do not run production jobs on laptops or via ngrok.

---

## Design Principles

- Explicit invocation
- Deterministic repo resolution
- Ephemeral execution
- Validation before PRs
- Guardrails enforced in code
- Audits over opinions
- Humans can always stop or redirect execution
- Same tooling for humans and agents — agents use the same repo setup commands, validation commands, and developer tooling as human engineers

---

## One-Line Summary

**Draftsman No. 9 opens PRs the way a careful engineer would — with limits, logs, and the ability to stop and ask before doing something dumb.**
