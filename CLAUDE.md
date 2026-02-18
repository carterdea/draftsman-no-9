# CLAUDE.md

Canonical agent guide for this repo.

## Project Intent
Draftsman No. 9 is an internal system that turns explicitly-invoked tickets into safe, auditable pull requests.

This system is:
- Procedural and bounded
- Validation-gated
- Human-overridable
- Audit-first

This system is not autonomous and should not behave like an unconstrained coding bot.

## What You Are Building
Current repo scope is a Bun monorepo with:
- `apps/api`: control-plane HTTP server
- `apps/worker`: queue consumer and orchestration entrypoints
- `packages/core`: shared policies, invocation parsing, deterministic logic
- `packages/db`: DB access layer scaffolding

Target behavior (from `README.md`):
- Explicit invocation (`investigate` or `fix`)
- Deterministic repo resolution
- Optional reproduction step
- Bounded edit/validate iteration loop
- PR only after validation passes and guardrails are respected
- Full audit trail

## Non-Negotiable Product Guardrails
Treat these as product constraints, not suggestions:
- Explicit invocation only
- Deterministic repo resolution before code changes
- Hard execution limits (iteration/time/diff size)
- Validation gates before PR creation
- Human-in-the-loop pause when ambiguity/risk is high
- No auto-merge behavior
- Small, reviewable diffs

## Engineering Defaults For This Repo
- Runtime/package manager: Bun
- Test runner: `bun test`
- Typecheck: `bun run typecheck`
- Lint/format: Biome

Use these commands from repo root:
- `bun run test`
- `bun run check`
- `bun run lint`
- `bun run typecheck`
- `bun run dev:api`
- `bun run dev:worker`

## Change Workflow (Default)
1. Read relevant docs and code paths first.
2. Keep changes minimal and local to the task.
3. Add/adjust tests for behavioral changes.
4. Run targeted checks, then broader checks if needed.
5. Summarize:
   - what changed
   - why
   - what was validated
   - open risks/questions

## Code Quality Bar
- Prefer deterministic, testable logic over prompt-only behavior.
- Keep orchestration policy in code, not in prose prompts.
- Avoid hidden side effects and implicit global state.
- Preserve clear separation:
  - control plane (API)
  - orchestration (worker)
  - shared policy/core logic
  - persistence/audit storage

## Progressive Disclosure (Read Only What You Need)
Start here:
- `README.md` for architecture, safety model, and system intent.

Then load deeper docs by task:
- `API_PLAN.md` for API design direction
- `BULLMQ_SETUP_PLAN.md` for queue setup
- `BULLMQ_PAUSE_RESUME_PLAN.md` for waiting/resume flow
- `INVOCATION_TRIGGER_PLAN.md` for invocation behavior
- `DOCKER_EXECUTION_PLAN.md` for execution environment strategy
- `TRELLO_DELIVERY_PLAN.md` for Trello integration details

## PR / Delivery Expectations
When preparing output for review:
- Be explicit about validation status.
- Do not claim tests/checks ran if they did not.
- Do not invent metrics, case studies, or outcomes.
- List unresolved questions at the end when present.
