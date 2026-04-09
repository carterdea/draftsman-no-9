# Execution + Validation Plan

> **Status:** Reframed by `PIPELINE_EXECUTION_PLAN.md`. The Ralph loop controller described here is now a **primitive invoked by pipeline stages**, not a top-level execution path. v0 ships a stripped Ralph (iteration cap + runtime cap + "diff changed this iteration" progress heuristic) as the minimum viable gate. The full controller contract, validation profiles, override policy, convergence metrics, and stop conditions below remain the **V1 target**, implemented incrementally on top of the v0 Ralph primitive once the pipeline is proven. Treat this document as the V1 spec, not the v0 implementation contract.

Scope: Ralph loop controller, per-repo validation profiles, override policy, and deterministic stop conditions for `fix` mode.

## Decisions

- Ralph loop policy lives in `packages/core` and is deterministic.
- Worker orchestrates lifecycle and persistence; it does not embed policy logic.
- Validation behavior is profile-driven per repo, resolved before execution starts.
- Validation profiles are file-based in repo for v1 (no profile UI required).
- PR eligibility is policy-gated in code, not in agent prompts.
- Overrides are explicit, scoped, audited, and cannot bypass global non-negotiable guardrails.
- Any authenticated invoker (Trello/Slack/MCP/API) may request job-scoped overrides in v1.
- Stop conditions are evaluated every iteration and can end in `blocked` or `waiting_for_input`.

## Core Contracts

### Ralph Loop Input

```ts
{
  jobId: string;
  mode: "fix";
  repo: { owner: string; name: string; defaultBranch: string };
  profileId: string;
  limits: {
    maxIterations: number;
    maxRuntimeMs: number;
    maxFilesChanged: number;
    maxLocDelta: number;
    maxNoProgressIterations: number;
  };
  overrides: {
    allowNoValidation: boolean;
    allowDependencyChanges: boolean;
    extendedLimits?: Partial<{
      maxIterations: number;
      maxRuntimeMs: number;
      maxFilesChanged: number;
      maxLocDelta: number;
    }>;
    reason?: string;
    requestedBy?: string;
  };
}
```

### Validation Profile

```ts
{
  id: string;
  repo: "owner/name";
  commands: {
    test?: string;
    typecheck?: string;
    lint?: string;
    build?: string;
  };
  requiredSignals: Array<"test" | "typecheck" | "lint" | "build">;
  minPassingSignals: number; // default 1
  commandTimeoutMs: number; // per command
  retryOnFlake: boolean; // default false
  pathAllowList: string[];
  pathBlockList: string[];
  allowDependencyChanges: boolean;
}
```

### Stop Condition Output

```ts
{
  shouldStop: boolean;
  code:
    | "MAX_ITERATIONS"
    | "MAX_RUNTIME"
    | "MAX_FILES_CHANGED"
    | "MAX_LOC_DELTA"
    | "REPEATED_IDENTICAL_FAILURE"
    | "NO_PROGRESS"
    | "DIFF_DIVERGENCE"
    | "RISKY_PATH_CHANGE"
    | "VALIDATION_UNAVAILABLE";
  nextState: "blocked" | "waiting_for_input";
  detail: string;
}
```

## Controller Behavior

1. Resolve repo and validation profile.
2. Merge limits with approved override extensions.
3. Run loop:
- plan changes
- apply bounded edits
- run validation commands from profile
- compute convergence metrics
- evaluate stop conditions
4. Exit `success` only when validation gate passes and no hard guardrail is violated.
5. Exit `blocked` or `waiting_for_input` when stop/override policy requires human action.

Validation gate rule:
- Must pass at least `minPassingSignals`.
- If profile has no configured commands, block unless `allowNoValidation=true` with explicit approval.

## Override Policy

Allowed override classes:
- `allowNoValidation`
- `allowDependencyChanges`
- limit extension (`maxIterations`, `maxRuntimeMs`, `maxFilesChanged`, `maxLocDelta`)

Required for every override:
- explicit reason
- requester identity
- scope (`job_id` only; no global override)
- audit event before first loop iteration

Disallowed even with override:
- disabling repo resolution checks
- bypassing path block list for high-risk areas (auth, payments, infra by default)
- auto-merge behavior

## Data Model Tasks

- [ ] Add `job_overrides` table (type, scope, reason, requested_by, requested_at, payload).
- [ ] Add `loop_iterations` table (iteration index, summary, patch stats, convergence metrics).
- [ ] Add `validation_runs` table (signal, command, exit code, duration, output ref).
- [ ] Add `job_stop_events` table (stop code, detail, chosen next state).

## Implementation Tasks

### `packages/core`

- [ ] Add `ralph-loop-controller.ts` pure controller with deterministic state transitions.
- [ ] Add `validation-profile.ts` file loader + parser + runtime guard.
- [ ] Add `validation-runner.ts` command execution adapter contract + result model.
- [ ] Add `override-policy.ts` merge/authorization checks.
- [ ] Add `stop-conditions.ts` evaluator for all hard stop triggers.
- [ ] Add `convergence-metrics.ts` (failure fingerprint, no-progress counter, diff growth ratio).
- [ ] Add repo profile file convention (for example `.draftsman/profile.json`) with schema validation.

### `apps/worker`

- [ ] Replace current idle loop path with job execution entrypoint.
- [ ] Resolve profile + override before starting iteration 1.
- [ ] Persist iteration and validation artifacts on each loop step.
- [ ] Enforce hard timeout/cancel at worker level in addition to controller checks.
- [ ] Map terminal outcomes to lifecycle states (`completed`, `failed`, `blocked`, `waiting_for_input`).

### `apps/api`

- [ ] Add endpoint for submitting job-scoped overrides with requester metadata.
- [ ] Add response shape exposing resolved profile id/path, stop code, and override usage on job detail.

## Test Plan

### Unit

- [ ] Loop state machine transitions across success, blocked, and waiting flows.
- [ ] Stop condition evaluation for each stop code.
- [ ] Validation gate behavior for mixed pass/fail signals.
- [ ] Override policy rejects missing requester metadata.
- [ ] Override merge respects non-negotiable guardrails.

### Integration

- [ ] Worker executes multi-iteration loop and persists every iteration.
- [ ] Profile with no commands blocks PR path unless approved `allowNoValidation`.
- [ ] Repeated identical failure stops with `REPEATED_IDENTICAL_FAILURE`.
- [ ] Diff divergence and no-progress counters trigger deterministic stop.
- [ ] Risky path edit triggers `waiting_for_input` before PR.

### End-to-End

- [ ] Trello `@draftsman fix` runs against repo profile and opens PR only after gate pass.
- [ ] Job with approved override records full override audit chain.
- [ ] Job exceeding limits exits safely and posts actionable blocked summary.

## Rollout Phases

- [ ] Phase 1: core contracts + DB schema + unit tests.
- [ ] Phase 2: worker integration + integration tests.
- [ ] Phase 3: API/operator surfaces + override submission flow.
- [ ] Phase 4: end-to-end validation + docs updates in `README.md`.

## Done Looks Like

- Ralph loop decisions are deterministic and test-covered.
- Every repo can define validation requirements without code changes.
- Overrides are auditable, scoped, and safe-by-default.
- Stop conditions prevent runaway edits and ambiguous PR creation.
- PR creation remains validation-gated and policy-enforced.

## Unresolved Questions

- [ ] Should profiles support optional DB override after v1, or remain file-only through v2?
  Current default while unresolved:
  1. v1 is file-only (`.draftsman/profile.json`).
  2. Add `ProfileResolver` interface now.
  3. Ship only `FileProfileResolver` in v1.
  4. Re-evaluate DB-backed resolver in v2 based on operator pain and repo count.
