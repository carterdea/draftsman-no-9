# Ralph V1 Policy

> **Status:** Superseded for v0 scope by `PIPELINE_EXECUTION_PLAN.md`. Ralph is now a primitive invoked by pipeline stages (`execute-plan` per task, `pre-pr`), not a top-level execution mode. v0 ships a stripped Ralph with iteration cap + runtime cap + diff-changed heuristic only. This document remains the roadmap for the full convergence-metric suite (failureFingerprint, no-progress counter, diff divergence, stage-A/B validation split) targeted for V2. Do not treat the scope described below as the v0 implementation contract.

Scope: concrete loop policy for `fix` jobs, shared across Claude Code and Codex paths.

## Decisions

- Claude Code path may use Anthropic's `ralph-wiggum` plugin conventions.
- Codex path uses a local skill (`docs/skills/ralph-loop/SKILL.md`) with Codex conventions.
- Both paths must run under the same controller-enforced limits and validation gates.
- Agent behavior is guidance; controller behavior is enforcement.

## Compatibility Model

- Canonical source of truth: loop controller in `packages/core`.
- Agent adapters (Claude/Codex) receive the same iteration context and constraints.
- If agent output conflicts with policy, controller rejects and stops.

## Loop Shape (V1)

1. Load job context, repo validation profile, and resolved overrides.
2. Build iteration plan with minimal-change bias.
3. Apply bounded edits.
4. Run validation in two stages:
- Stage A: targeted signal(s) relevant to touched area (fast fail)
- Stage B: required profile signals for PR eligibility
5. Compute convergence metrics.
6. Evaluate stop conditions.
7. Continue or stop.

## Validation Order

Default validation order:
1. `typecheck` (if configured)
2. `lint` (if configured)
3. `test` (if configured)
4. `build` (if configured)

Rules:
- Stage A can run a subset for quick signal.
- Stage B must satisfy profile gate before success.
- If Stage A fails with high-confidence root cause, skip Stage B for that iteration.

## Convergence Policy (V1)

Per iteration capture:
- `failureFingerprint`: deterministic hash of failing signal + normalized error headline
- `filesChanged`
- `locDelta`
- `passingSignals`

No-progress counter increments when either is true:
- same `failureFingerprint` as prior iteration with no net gain in passing signals
- `locDelta` grows but failing signals do not improve

Diff divergence trigger:
- cumulative `locDelta` grows across consecutive iterations without improved signal state

## Stop Conditions

Controller evaluates each iteration and stops on:
- `MAX_ITERATIONS`
- `MAX_RUNTIME`
- `MAX_FILES_CHANGED`
- `MAX_LOC_DELTA`
- `REPEATED_IDENTICAL_FAILURE`
- `NO_PROGRESS`
- `DIFF_DIVERGENCE`
- `RISKY_PATH_CHANGE`
- `VALIDATION_UNAVAILABLE`

Terminal mapping:
- `completed`: validation gate passes and no guardrail violations.
- `blocked`: limit/validation/policy stop requiring human decision.
- `waiting_for_input`: ambiguity or risky change needs explicit direction.

## Overrides in Ralph V1

Allowed override classes remain:
- `allowNoValidation`
- `allowDependencyChanges`
- limit extensions (job-scoped)

V1 auth model:
- any authenticated invoker may request override
- every override must include `reason` + `requested_by`
- every override is logged before loop iteration 1

## Agent Prompt Contract

Each loop iteration supplies:
- iteration index and remaining budget
- stop-risk summary (what will trigger stop next)
- validation profile summary
- path policy summary
- previous iteration failures and convergence state

Agent must return:
- change intent summary
- files to edit (planned)
- rationale tied to failing signals

## Audit Requirements

Persist per iteration:
- iteration start/end timestamps
- planned edits vs actual edits
- validation command outputs and durations
- convergence metrics
- stop-condition evaluations
- override references used

## Implementation Notes

- Keep policy logic in pure functions where possible for test determinism.
- Keep adapter differences out of policy code.
- For Codex skill usage, treat skill as assistive behavior only.

## Rollout

- [ ] Add core controller/policy modules in `packages/core`.
- [ ] Wire worker to execute loop with policy checkpoints.
- [ ] Add Codex skill loading path for `ralph-loop`.
- [ ] Add Claude adapter support for plugin-compatible loop messaging.
- [ ] Add tests for parity across Claude/Codex adapter paths.

## Unresolved Questions

- [ ] Should Stage A targeted validation be configurable per profile, or globally fixed in v1?
