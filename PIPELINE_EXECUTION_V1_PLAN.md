# Pipeline Execution V1 Plan

Scope: everything that v0 explicitly deferred — shared-controller reimplementation of `fix` and `investigate`, capability-injection replacement of boolean stage flags, discriminated-union stage inputs, repo validation profile resolver, coarse risky-path guard, hardened Dockerfile self-repair, directory watcher, partial-run idempotency guarantees, and the doc updates that `PIPELINE_EXECUTION_PLAN.md` flagged as pending.

## Status

- Prerequisite: `PIPELINE_EXECUTION_PLAN.md` v0 must ship first. Everything here depends on the pipeline controller, stage interface, Ralph primitive, plan parser, and `pipeline_run` + `pipeline_task_progress` tables existing.
- v1 does not change the v0 `execute` mode behavior except where items below explicitly touch it.
- Completion of v1 is what makes the pipeline a credible shared execution layer for all three invocation modes.

## Decisions

- **Capabilities, not flags, with type-level enforcement.** `StageDefinition` becomes generic over a `Requires` tuple of capability kinds (`"git.read" | "git.write" | "ralph" | "planFindings" | "profile"`) and a stage-specific `Output` type. The controller derives an exact `StageContextFor<Requires>` type that contains only the declared handles. A stage that did not declare `"git.write"` in `requires` cannot access `ctx.gitWrite` because the property does not exist in its context type — TypeScript rejects the access at build time, and the runtime context object literally does not have the field. Boolean `commitsAllowed` and `ralphAllowed` are removed.
- **Git capability is split into read and write.** Capability kinds are `"git.read"` and `"git.write"`. After `StageContextFor<Requires>` derivation (which strips dot notation), stages access them as `ctx.gitRead` (log, diff, show, branch inspection) and `ctx.gitWrite` (commit, resetHard, push). `investigate`-mode stages declare `requires: ["git.read"]` and cannot write even accidentally — the `gitWrite` property does not exist in their context type. `execute-plan` per-task and `pre-pr` declare `requires: ["git.read", "git.write"]`.
- **Discriminated-union stage inputs.** `StageInput` is split into a run-level `RunContext` and a per-stage discriminated union `StageInput<StageKind>`. The investigate stage gets `{ kind: "analyze", ticketRef }`, the per-task execute stage gets `{ kind: "execute-task", taskKey, taskText, sectionPath, ordinal }`, etc. No hidden filesystem coupling.
- **Shared controller for all modes.** `fix` and `investigate` modes are reimplemented as pipelines on the v0 controller. `fix` becomes `ingest → resolve-profile → ralph-iterate → pre-pr → pr-create`. `investigate` becomes `ingest → analyze → post-findings`. No parallel execution paths.
- **Profile resolver is a first-class stage, not a controller detail.** `resolve-profile` runs before any mutating stage in `fix` mode and writes the resolved profile into `RunContext.profile`. The controller is taught about one pipeline-level precondition: `requiresProfile: true`. Pipelines declaring that flag block with `BLOCKED` unless `RunContext.profile` is populated by the end of `resolve-profile`. **v0 controller does not know about this flag** — v1 adds it to `PipelineDefinition` alongside the existing `mode` and `stages` fields and teaches the controller to check it.
- **Coarse risky-path guard lives in `ctx.gitWrite.commit()`.** The write capability's `commit()` rejects files matching the repo's risky-path block-list before invoking git. The block-list is read live from `RunContext.profile.pathBlockList` on every call, so any update to the run's profile is immediately enforced. No stage can bypass the guard without replacing the capability implementation, which the controller owns.
- **Dockerfile self-repair is gated behind `WAITING_FOR_INPUT`.** Auto-commit-and-push of infra changes is removed. When a stage detects missing toolchain, it returns `WAITING_FOR_INPUT` with a proposed patch to `apps/runner/Dockerfile` attached as a finding. A human reviews and approves the patch out-of-band; next run picks up the approved image.
- **Directory watcher is an optional long-running process.** `apps/watcher` consumes `.draftsman/plans/*.md` and calls `createJobFromInvocation` for new files. Watcher is stateless; idempotency comes from the existing invocation dedupe store.
- **`watcher` is a first-class canonical invocation source.** v1 adds `watcher` to the `InvocationSource` enum in `packages/core/src/canonical-model/enums.ts` alongside `trello | slack | mcp | internal`. Watcher-originated jobs get idempotency key `invoke:watcher:<absolute-path>:<sha256-of-content>`. This is the audit-clarity choice over normalizing to `internal`.
- **Partial-run recovery inherits from v0 without change.** The v0 `task_start_sha` / `task_end_sha` / `pipeline_task_progress.status` checkpoint model is the sole recovery mechanism. **v1 does not introduce a commit-trailer recovery design** — the earlier proposal to use `Draftsman-Task-Hash` as a completion signal was wrong because Ralph can emit multiple commits per task and a crash after iteration 1 would falsely mark the task complete. The Postgres row written after the stage returns `READY` is the only "task is done" signal. See v0's **Per-Task Git Checkpointing** section for the contract.
- **Commit trailers are audit-only.** See the locked commit trailer contract above: `Draftsman-Job` on all modes, `Draftsman-Task-Key` added in execute mode only. Both are for human auditability and reverse-lookups from git log → plan task or job. Neither is consulted during crash recovery.
- **Rendered prompt hash captures the exact Claude invocation.** v1 hashes the full concatenated prompt (system + user payload + any tool declarations) at `claude -p` call time, not at template load time. Template hash stays as a separate audit field. This replaces the v0 provisional definition of `rendered_hash`.
- **`GITHUB_PR_PLAN.md` lifecycle phases are mapped across pipeline stages, not owned by `pr-create` alone.** The state machine `QUEUED → PREPARE_BRANCH → EDITING → VALIDATING → PR_READY → PR_OPEN → COMPLETE` maps as follows:
  - `QUEUED` — job accepted, pipeline not yet started. Owned by the invocation layer (`createJobFromInvocation`), not the pipeline.
  - `PREPARE_BRANCH` — pipeline controller start-of-run action, before any stage. Creates the feature branch from `repo.defaultBranch`, records `pipeline_run.base_sha`. Controller-owned, not a stage.
  - `EDITING` — execute mode: `execute-plan` per-task + `de-slop` + `simplify`. Fix mode: `ralph-iterate`. Investigate mode: N/A (no edits).
  - `VALIDATING` — `pre-pr` stage.
  - `PR_READY` — lifecycle marker set by the controller after `pre-pr` returns `READY`.
  - `PR_OPEN` — `pr-create` stage. **This is the only phase `pr-create` owns.** It creates the PR via `gh pr create`, records the PR URL + number, emits the audit hook defined in `GITHUB_PR_PLAN.md#Audit Hooks` for the open transition. No editing or validation work happens in this stage.
  - `COMPLETE` — after human merge. Out of scope for the pipeline — the canonical model transitions to `completed` when the merge webhook arrives.

  `GITHUB_PR_PLAN.md` itself must be updated in v1 to (a) cover both `fix` and `execute` modes, (b) publish this phase-to-stage mapping table, and (c) make clear that rollback semantics (Phase A / B / C in the current doc) apply per-stage, not per-PR.
- **Commit trailer contract (locked):** **every** draftsman commit in any mode always carries `Draftsman-Job: <jobId>`. **In addition**, every execute-mode task commit carries `Draftsman-Task-Key: <key>`. Fix-mode commits carry only `Draftsman-Job`. Investigate-mode produces no commits. Trailers are audit metadata only; they are never consulted for crash recovery (see v0 Per-Task Git Checkpointing).
- **`investigate` mode emits delivery intent, it does not directly post to Trello.** The `post-findings` stage writes a delivery intent artifact to `.draftsman/runs/<run_id>/delivery-intent.json` following the contract in `TRELLO_DELIVERY_PLAN.md`. The separate delivery worker consumes the intent and performs the Trello write. Tests must reflect this — `post-findings` tests assert on the intent artifact shape, not on Trello API calls.

## Core Contracts

### Capability Kinds

```ts
// packages/core/src/pipeline/capabilities.ts (new in v1)

export type CapabilityKind =
  | "git.read"
  | "git.write"
  | "ralph"
  | "planFindings"
  | "profile";

export interface GitReadCapability {
  log(args: { since?: string; grep?: string }): Promise<GitLogEntry[]>;
  diff(args: { base: string; head: string }): Promise<string>;
  show(args: { sha: string; path?: string }): Promise<string>;
  headSha(): Promise<string>;
  isClean(): Promise<boolean>;
}

export interface GitWriteCapability {
  /**
   * Returns commit SHA. Rejects if any path matches the risky-path block-list
   * resolved from `RunContext.profile.pathBlockList`.
   *
   * Standard trailers are injected automatically by the capability
   * implementation (not by the caller):
   *   - `Draftsman-Job: <jobId>` is always appended, sourced from RunContext.jobId.
   *   - `Draftsman-Task-Key: <taskKey>` is appended ONLY when
   *     RunContext.mode === "execute" AND the caller supplied `taskKey` in args.
   *     The execute-plan per-task stage supplies it; de-slop, simplify, and
   *     pre-pr do not (their commits get only Draftsman-Job).
   *
   * Any additional trailers in args.trailers are appended after the standard ones.
   */
  commit(args: {
    files: string[];
    message: string;
    /** Required when called from execute-plan per-task stage. Triggers Draftsman-Task-Key injection in execute mode. */
    taskKey?: string;
    /** Optional caller-supplied trailers. Appended after the standard automatic ones. */
    trailers?: Record<string, string>;
  }): Promise<string>;

  /** Hard reset the feature branch. Used for crash recovery only. Audited. */
  resetHard(sha: string): Promise<void>;

  /** Push the feature branch. Rejects on non-fast-forward without explicit flag. */
  push(args: { force?: boolean }): Promise<void>;
}

export interface RalphCapability {
  runBounded(args: {
    taskKey: string;
    context: RalphContext;
    caps: RalphCaps;
  }): Promise<RalphResult>;
}

export interface PlanFindingsCapability {
  /**
   * Appends a markdown finding to .draftsman/runs/<runId>/<stage>-findings.md.
   * Used by the QA stage and QA fix loop for human-readable finding lists.
   * Never touches the plan file.
   */
  appendFinding(args: {
    path?: string;
    severity?: "info" | "warning" | "error";
    note: string;
  }): Promise<void>;

  /**
   * Writes a structured artifact to .draftsman/runs/<runId>/<relativePath>.
   * Used by post-findings to emit delivery-intent.json and by any stage that
   * needs a controller-tracked artifact beyond the finding-list shape.
   *
   * relativePath must stay within .draftsman/runs/<runId>/ — path traversal
   * attempts are rejected with a typed error.
   */
  writeArtifact(args: {
    relativePath: string;   // e.g. "delivery-intent.json"
    content: string | Uint8Array;
  }): Promise<void>;
}

export interface ProfileCapability {
  /** Read-only access to the resolved validation profile for this run. */
  readonly profile: ValidationProfile;
}

/**
 * Map from capability kind to its implementation interface.
 * Used by StageContextFor<Requires> to derive exact context shapes.
 */
export interface CapabilityMap {
  "git.read": GitReadCapability;
  "git.write": GitWriteCapability;
  "ralph": RalphCapability;
  "planFindings": PlanFindingsCapability;
  "profile": ProfileCapability;
}
```

### RunContext vs StageInput

```ts
// packages/core/src/pipeline/types.ts (modified in v1)

export interface RunContext {
  runId: string;
  jobId: string;
  mode: InvocationMode;
  branch: string;
  baseSha: string;
  repo: { owner: string; name: string; defaultBranch: string };
  profile?: ValidationProfile;   // set by resolve-profile stage
  caps: RunCaps;
}

export type StageInput =
  | { kind: "ingest"; source: PlanSource }
  | { kind: "open-questions-gate"; planPath: string }
  | { kind: "plan-validation"; planPath: string }
  | { kind: "execute-task"; planPath: string; taskKey: string; taskText: string; sectionPath: string; ordinal: number }
  | { kind: "de-slop" }
  | { kind: "simplify" }
  | { kind: "qa"; planPath: string }
  | { kind: "qa-fix-loop"; findingsPath: string }
  | { kind: "pre-pr" }
  | { kind: "pr-create" }
  | { kind: "analyze"; ticketRef: TicketRef }
  | { kind: "post-findings"; report: InvestigateReport }
  | { kind: "resolve-profile" }
  | { kind: "ralph-iterate"; goal: string };
```

### Exact StageContext via generic derivation

```ts
// packages/core/src/pipeline/context.ts (new in v1)

import type { CapabilityKind, CapabilityMap } from "./capabilities";

/**
 * Derived context type. Given a tuple of required capability kinds, produces
 * an object type that contains exactly those capability handles and nothing else,
 * plus a mandatory `run: RunContext` field.
 */
export type StageContextFor<Requires extends readonly CapabilityKind[]> = {
  run: RunContext;
} & {
  [K in Requires[number] as StripDotNotation<K>]: CapabilityMap[K];
};

// Turn "git.read" into "gitRead" for property access, etc.
type StripDotNotation<S extends string> = S extends `${infer A}.${infer B}`
  ? `${A}${Capitalize<B>}`
  : S;

// Examples:
// StageContextFor<["git.read"]> = { run: RunContext; gitRead: GitReadCapability }
// StageContextFor<["git.read", "git.write", "ralph"]> = {
//   run: RunContext;
//   gitRead: GitReadCapability;
//   gitWrite: GitWriteCapability;
//   ralph: RalphCapability;
// }
// StageContextFor<[]> = { run: RunContext }
```

### Stage Outputs

Each stage has its own output shape. The base shape (`BaseStageOutput`) is common; stages extend it with stage-specific fields. The controller uses typed outputs to construct the next stage's input.

```ts
// packages/core/src/pipeline/types.ts (modified in v1)

// Base shape. All stage outputs extend this.
export interface BaseStageOutput {
  status: "READY" | "BLOCKED" | "WAITING_FOR_INPUT";
  reason: string;
  commits: string[];
  findings: Array<{ path?: string; note: string }>;
  artifacts: { logPath: string; jsonlPath: string };
}

// Stage-specific outputs. Discriminated on `kind`, matching StageInput.
export type StageOutput =
  | (BaseStageOutput & { kind: "ingest"; planPath: string; planHash: string })
  | (BaseStageOutput & { kind: "open-questions-gate" })
  | (BaseStageOutput & { kind: "plan-validation"; taskKeys: string[] })
  | (BaseStageOutput & { kind: "resolve-profile"; profile: ValidationProfile | null })
  | (BaseStageOutput & { kind: "execute-task"; taskKey: string; taskStartSha: string; taskEndSha?: string })
  | (BaseStageOutput & { kind: "de-slop" })
  | (BaseStageOutput & { kind: "simplify" })
  | (BaseStageOutput & { kind: "pre-pr" })
  | (BaseStageOutput & { kind: "pr-create"; prUrl: string; prNumber: number })
  | (BaseStageOutput & { kind: "ralph-iterate"; iterations: number; outcome: "CONVERGED" | "CAPPED" | "NO_PROGRESS" })
  | (BaseStageOutput & { kind: "analyze"; report: InvestigateReport })
  | (BaseStageOutput & { kind: "post-findings"; deliveryIntentPath: string })
  | (BaseStageOutput & { kind: "qa"; findingsPath: string })
  | (BaseStageOutput & { kind: "qa-fix-loop" });

// Controller uses these helpers to extract typed outputs per kind.
export type StageOutputFor<K extends StageKind> = Extract<StageOutput, { kind: K }>;
```

### Stage Declaration

```ts
// packages/core/src/pipeline/stages/types.ts (modified in v1)

export interface StageDefinition<
  K extends StageKind,
  Requires extends readonly CapabilityKind[],
> {
  kind: K;
  requires: Requires;
  schema: ZodSchema<StageOutputFor<K>>;
  run(
    input: Extract<StageInput, { kind: K }>,
    ctx: StageContextFor<Requires>,
  ): Promise<StageOutputFor<K>>;
}

// Example usage:
export const deSlopStage: StageDefinition<"de-slop", ["git.read", "git.write"]> = {
  kind: "de-slop",
  requires: ["git.read", "git.write"] as const,
  schema: deSlopSchema,
  async run(input, ctx): Promise<StageOutputFor<"de-slop">> {
    // ctx.gitRead and ctx.gitWrite exist and are typed.
    // ctx.ralph does NOT exist in the type — access is a compile error.
    // ctx.profile does NOT exist in the type — access is a compile error.
    const files = await ctx.gitRead.diff({ base: "HEAD~1", head: "HEAD" });
    // ...
    return { kind: "de-slop", status: "READY", reason: "...", commits: [...], findings: [], artifacts: {...} };
  },
};

export const analyzeStage: StageDefinition<"analyze", ["git.read"]> = {
  kind: "analyze",
  requires: ["git.read"] as const,
  schema: analyzeSchema,
  async run(input, ctx): Promise<StageOutputFor<"analyze">> {
    const history = await ctx.gitRead.log({ since: input.ticketRef.sinceSha });
    // ...
    return { kind: "analyze", status: "READY", reason: "...", commits: [], findings: [], artifacts: {...}, report };
  },
};

export const resolveProfileStage: StageDefinition<"resolve-profile", []> = {
  kind: "resolve-profile",
  requires: [] as const,
  schema: resolveProfileSchema,
  async run(input, ctx): Promise<StageOutputFor<"resolve-profile">> {
    // No capabilities — reads .draftsman/profile.json from workspace directly.
    const profile = await loadProfile(ctx.run.repo);
    return { kind: "resolve-profile", status: "READY", reason: "...", commits: [], findings: [], artifacts: {...}, profile };
  },
};
```

### Controller Handoff Contract

The controller carries forward each stage's typed output, keyed by kind, and constructs the next stage's input using a small dispatch table. Subsequent stages that need an earlier output read it by kind from `PipelineContext.outputs`.

```ts
// packages/core/src/pipeline/controller.ts

interface PipelineInternalContext {
  run: RunContext;
  outputs: {
    [K in StageKind]?: StageOutputFor<K>;
  };
}

// After each stage completes, the controller stores its output:
internal.outputs[stage.kind] = stageOutput;

// Specific post-stage actions:
//   - "resolve-profile" → controller merges output.profile into run.profile (see below)
//   - "ingest" → controller stores planPath and planHash for later gate verification
//   - "analyze" → controller hands output.report to the next stage's input construction
//   - "execute-task" → controller writes task_start_sha / task_end_sha to pipeline_task_progress
//   - "pr-create" → controller records output.prUrl for the final PipelineResult

// Next-stage input construction is a typed dispatch per kind:
function buildNextInput(
  next: StageKind,
  internal: PipelineInternalContext,
): StageInput {
  switch (next) {
    case "post-findings":
      return { kind: "post-findings", report: internal.outputs["analyze"]!.report };
    case "execute-task":
      // Caller (controller's per-task loop) supplies taskKey/taskText/etc.
      throw new Error("execute-task inputs are constructed per iteration");
    // ... etc
  }
}
```

This closes the stage-to-stage data gap: every forward-propagated value lives in a typed slot in `internal.outputs`, and the next stage's input is a typed dispatch from that slot.

### Controller Capability Injection

Capability implementations must not capture mutable run state at construction time. Instead, they hold a reference to the `RunContext` and read live from it. This avoids stale capability behavior after the `resolve-profile` stage merges the profile into `RunContext.profile` — any capability that depends on the profile reads the up-to-date value on every call.

```ts
// packages/core/src/pipeline/controller.ts (modified in v1)

// Capability factories take RunContext as a live reference, not captured values.
// When resolve-profile merges a profile into run.profile, downstream capability
// method calls immediately see the new value — there is no stale capture.
interface CapabilityFactories {
  "git.read": (run: RunContext) => GitReadCapability;
  "git.write": (run: RunContext) => GitWriteCapability;  // reads run.profile?.pathBlockList live
  "ralph": (run: RunContext) => RalphCapability;
  "planFindings": (run: RunContext) => PlanFindingsCapability;
  "profile": (run: RunContext) => ProfileCapability;     // reads run.profile live
}

function buildStageContext<Requires extends readonly CapabilityKind[]>(
  requires: Requires,
  run: RunContext,
  factories: CapabilityFactories,
): StageContextFor<Requires> {
  const ctx: Record<string, unknown> = { run };
  for (const kind of requires) {
    const key = stripDotNotation(kind);
    ctx[key] = factories[kind](run);
  }
  return ctx as StageContextFor<Requires>;
}
```

`GitWriteCapability.commit()` reads `run.profile?.pathBlockList` on every invocation, not from a captured value. `ProfileCapability.profile` is a getter that returns `run.profile` live. This eliminates the stale-capability risk and removes the need for a post-resolve capability "rebuild" step — there is nothing to rebuild.

TypeScript enforces the boundary at build time via `StageContextFor`. The runtime context is a fresh object per stage invocation built from the declared `requires` tuple. Both layers agree; neither can be bypassed without explicit casts that would show up in code review.

### Branch Publication

Remote branch publication is an explicit controller action between `pre-pr` completing READY and `pr-create` running. `gh pr create` requires the branch to exist on the remote before it will succeed, so the controller runs `git push --set-upstream origin <branch>` as a controller-owned step, not inside any stage. Audit event: `BRANCH_PUBLISHED`. The push uses the controller's `GitWriteCapability` handle to keep rollback/auditing consistent with stage-level writes.

If `BRANCH_PUBLISHED` fails (network, auth, non-fast-forward), the pipeline halts with `BLOCKED` before `pr-create` is invoked. `pr-create` itself never calls `push()` — it assumes the branch is already on remote and fails loudly if not.

### Profile Resolver Stage Contract

```ts
// packages/core/src/profile/resolver.ts (new in v1)

export interface ValidationProfile {
  id: string;
  repo: string;
  commands: {
    test?: string;
    typecheck?: string;
    lint?: string;
    build?: string;
    security?: string;
  };
  requiredSignals: Array<"test" | "typecheck" | "lint" | "build" | "security">;
  pathAllowList: string[];
  pathBlockList: string[];
  commandTimeoutMs: number;
  allowDependencyChanges: boolean;
}

export interface ProfileResolver {
  resolve(repo: { owner: string; name: string }): Promise<ValidationProfile | null>;
}
```

v1 ships one implementation: `FileProfileResolver` reading `.draftsman/profile.json` from the target repo. DB-backed resolver is deferred to V2 as noted in `EXECUTION_VALIDATION_PLAN.md`.

**Resolve stage has no capabilities.** The `resolve-profile` stage declares `requires: []`. It reads `.draftsman/profile.json` directly from the workspace (plain filesystem read, no capability wrapper needed — the plan file mount is already RO and workspace reads are not capability-gated). It returns the resolved profile as a field in its stage output:

```ts
type ResolveProfileOutput = StageOutput & {
  kind: "resolve-profile";
  profile: ValidationProfile | null;
};
```

The controller merges `output.profile` into `RunContext.profile` after the stage returns `READY`, before invoking any subsequent stage. Downstream stages declare `requires: ["profile"]` to read `RunContext.profile` via a wrapper handle — at that point the profile already exists. The `profile` capability is always read-only; no stage after `resolve-profile` can modify it.

This resolves the chicken-and-egg: the stage that produces the profile does not need the capability that consumes it.

### Pipeline Definitions

```ts
// packages/core/src/pipeline/definitions.ts (new in v1)

// PipelineDefinition gains one new field in v1:
//   requiresProfile: boolean
// The v0 controller is extended to enforce this precondition — if true and
// RunContext.profile is still undefined after the resolve-profile stage
// completes, the pipeline halts with BLOCKED.

export const executePipeline: PipelineDefinition = {
  mode: "execute",
  stages: [
    ingestStage,
    openQuestionsGateStage,
    planValidationStage,
    resolveProfileStage,
    executePlanPerTaskStage,
    deSlopStage,
    simplifyStage,
    prePrStage,
    prCreateStage,
  ],
  requiresProfile: true,
};

export const fixPipeline: PipelineDefinition = {
  mode: "fix",
  stages: [
    ingestStage,
    resolveProfileStage,
    ralphIterateStage,
    prePrStage,
    prCreateStage,
  ],
  requiresProfile: true,
};

export const investigatePipeline: PipelineDefinition = {
  mode: "investigate",
  stages: [
    ingestStage,
    analyzeStage,
    postFindingsStage,    // emits delivery-intent.json, does not post to Trello directly
  ],
  requiresProfile: false,
};
```

## Implementation Tasks

### `packages/core/src/pipeline/` (modifications to v0 code)

- [ ] Replace `commitsAllowed` / `ralphAllowed` booleans with `requires: readonly CapabilityKind[]` on `StageDefinition`. Make `StageDefinition` generic over `Requires` — `packages/core/src/pipeline/stages/types.ts`.
- [ ] Split `StageInput` into discriminated union keyed by `kind` — `packages/core/src/pipeline/types.ts`.
- [ ] Introduce `RunContext` as a separate type from stage-local input — `packages/core/src/pipeline/types.ts`.
- [ ] Implement `StageContextFor<Requires>` generic derivation in `packages/core/src/pipeline/context.ts` — new file.
- [ ] Implement `buildStageContext` helper that returns a fresh object containing only the declared capability handles — `packages/core/src/pipeline/controller.ts`.
- [ ] Add pipeline definitions for all three modes — create `packages/core/src/pipeline/definitions.ts`.
- [ ] Extend `PipelineDefinition` with `requiresProfile: boolean` — `packages/core/src/pipeline/types.ts`.
- [ ] Update controller to enforce `requiresProfile: true` — if `RunContext.profile` is undefined after `resolve-profile` stage runs, pipeline halts with `BLOCKED` — `packages/core/src/pipeline/controller.ts`.
- [ ] Delete all uses of `ctx.commitsAllowed` / `ctx.ralphAllowed` across the codebase — `packages/core/src/pipeline/stages/*.ts`.

### `packages/core/src/pipeline/capabilities.ts` (new in v1)

- [ ] Create the file with `GitReadCapability`, `GitWriteCapability`, `RalphCapability`, `PlanFindingsCapability`, `ProfileCapability` interfaces plus the `CapabilityKind` union and `CapabilityMap` type.
- [ ] Implement `createGitReadCapability(run: RunContext)` — log, diff, show, headSha, isClean. Holds `run` as a live reference. Never mutates the tree.
- [ ] Implement `createGitWriteCapability(run: RunContext, ralphController: RalphController)` — commit, resetHard, push. `commit()` reads `run.profile?.pathBlockList` live on every call and rejects paths matching it. Automatically appends `Draftsman-Job: <run.jobId>` on every commit. Additionally appends `Draftsman-Task-Key: <taskKey>` when `run.mode === "execute"` and the caller supplied `taskKey` in commit args. No profile is captured at construction time — the capability always sees the latest `run.profile`.
- [ ] Implement `createRalphCapability(run: RunContext, ralphController: RalphController)` — thin wrapper that injects the run's Ralph controller instance.
- [ ] Implement `createPlanFindingsCapability(run: RunContext, stageName: string)` — `appendFinding` writes to `.draftsman/runs/<run.runId>/<stageName>-findings.md`; `writeArtifact` writes to `.draftsman/runs/<run.runId>/<relativePath>`. Both reject path-traversal attempts that escape the run directory.
- [ ] Implement `createProfileCapability(run: RunContext)` — returns an object with a `profile` getter that reads `run.profile` live. No capture.
- [ ] Unit tests for capability construction, live-read behavior after `run.profile` mutation, and the risky-path reject path.

### `packages/core/src/pipeline/stages/` (new stages in v1)

- [ ] Implement `resolve-profile` stage with `requires: []`. Reads `.draftsman/profile.json` directly from the workspace, returns the resolved profile in its stage output. Controller merges into `RunContext.profile` on stage completion — `packages/core/src/pipeline/stages/resolve-profile.ts`.
- [ ] Extend controller to merge `ResolveProfileOutput.profile` into `RunContext.profile` before the next stage starts — `packages/core/src/pipeline/controller.ts`.
- [ ] Implement `ralph-iterate` stage for `fix` mode with `requires: ["git.read", "git.write", "ralph", "profile"]` — `packages/core/src/pipeline/stages/ralph-iterate.ts`.
- [ ] Implement `analyze` stage for `investigate` mode with `requires: ["git.read"]` — cannot commit, by type. `packages/core/src/pipeline/stages/analyze.ts`.
- [ ] Implement `post-findings` stage for `investigate` mode with `requires: ["planFindings"]` — writes delivery intent to `.draftsman/runs/<run_id>/delivery-intent.json`. Does NOT call Trello APIs directly. `packages/core/src/pipeline/stages/post-findings.ts`.
- [ ] Update `execute-task` stage to declare `requires: ["git.read", "git.write", "ralph", "profile"]`. Commits automatically get `Draftsman-Task-Key: <key>` trailer via the write capability. `packages/core/src/pipeline/stages/execute-task.ts`.
- [ ] Update `de-slop` and `simplify` stages to declare `requires: ["git.read", "git.write"]` — `packages/core/src/pipeline/stages/de-slop.ts`, `simplify.ts`.
- [ ] Update `pre-pr` stage to declare `requires: ["git.read", "git.write", "ralph", "profile"]` and use `ctx.profile.profile.commands` instead of hard-coded checks — `packages/core/src/pipeline/stages/pre-pr.ts`.
- [ ] Update `pr-create` stage to declare `requires: ["git.read"]`. Narrow scope: create the PR via `gh pr create`, record `pr_number` and `pr_url` in the run artifacts, emit the `PR_OPEN` audit hook from `GITHUB_PR_PLAN.md#Audit Hooks`. Reads current branch name and head SHA via `gitRead`. Does NOT write, commit, or push — branch publication is controller-owned and happens before this stage runs. — `packages/core/src/pipeline/stages/pr-create.ts`.
- [ ] Implement controller-owned branch preparation at run start (before first stage). Creates the feature branch from `repo.defaultBranch`, records `pipeline_run.base_sha`, emits the `PREPARE_BRANCH` audit hook — `packages/core/src/pipeline/controller.ts`.
- [ ] Wire the `EDITING` / `VALIDATING` / `PR_READY` lifecycle transitions to their corresponding stage boundaries. Emit audit hooks from the controller, not the stages, so stages stay mode-agnostic — `packages/core/src/pipeline/controller.ts`.
- [ ] Implement controller-owned branch publication step between `pre-pr` READY and `pr-create`. Runs `gitWrite.push({})` once, emits `BRANCH_PUBLISHED` audit event, halts with `BLOCKED` on failure. `pr-create` never calls push itself — `packages/core/src/pipeline/controller.ts`.

### Stage prompts (new + updated)

- [ ] `packages/core/src/pipeline/prompts/resolve-profile.system.md` — new.
- [ ] `packages/core/src/pipeline/prompts/ralph-iterate.system.md` — new, structured output for Ralph task plan.
- [ ] `packages/core/src/pipeline/prompts/analyze.system.md` — new, investigate-mode analysis output.
- [ ] `packages/core/src/pipeline/prompts/post-findings.system.md` — new, delivery-intent output.

### `packages/core/src/profile/` (new in v1)

- [ ] Define `ValidationProfile` type — create `packages/core/src/profile/types.ts`.
- [ ] Implement `FileProfileResolver` reading `.draftsman/profile.json` from the target repo workspace — create `packages/core/src/profile/file-resolver.ts`.
- [ ] Define `ProfileResolver` interface and export factory — create `packages/core/src/profile/index.ts`.
- [ ] Add profile schema validation using Zod — `packages/core/src/profile/schema.ts`.

### `packages/core/src/ralph/` (modifications to v0 code)

v1 does not add crash-recovery logic to Ralph. Crash recovery is fully owned by the pipeline controller via `task_start_sha` / `task_end_sha` checkpoints and Postgres-recorded task status (see v0 doc, **Per-Task Git Checkpointing**). Ralph's job is single-task convergence; it does not need to know about resume semantics.

- [ ] No Ralph changes required for recovery. Trailer-based Ralph short-circuit is NOT implemented — the earlier proposal was unsound (Ralph can emit multiple commits per task, a crash after iteration 1 would falsely mark the task complete). Leave Ralph alone for v1.

### `packages/db/migrations/` (new in v1)

- [ ] `005_alter_jobs_current_stage.sql` — add `current_stage TEXT` column.
- [ ] `006_create_pipeline_run.sql` — (may have already landed in v0 migration PR; if so, skip).
- [ ] `007_create_pipeline_task_progress.sql` — (same).
- [ ] `008_create_pipeline_stage_events.sql` — new table for stage transition audit events per v0's deferred decision.

### `packages/core/src/canonical-model/` (modifications)

- [ ] Add `execute` to `InvocationMode` enum — `packages/core/src/canonical-model/enums.ts`.
- [ ] Add `watcher` to `InvocationSource` enum (was `trello | slack | mcp | internal`) — `packages/core/src/canonical-model/enums.ts`.
- [ ] Add `StageVerdict` enum (`READY | BLOCKED | WAITING_FOR_INPUT`) — `packages/core/src/canonical-model/enums.ts`.
- [ ] Document verdict-to-lifecycle mapping in `packages/core/src/canonical-model/transitions.ts`:
  - `READY` + final stage → `JobStatus.completed`
  - `BLOCKED` → `JobStatus.failed`
  - `WAITING_FOR_INPUT` → `JobStatus.waiting_for_input` (re-uses existing resume flow)
- [ ] Add `current_stage` field to canonical job shape — `packages/core/src/canonical-model/index.ts`.
- [ ] Add watcher idempotency key builder: `invoke:watcher:<absolute-path>:<sha256-of-content>` — `packages/core/src/canonical-model/idempotency.ts`.
- [ ] Update `CANONICAL_MODEL_PLAN.md` canonical enum list and canonical idempotency key section to match.

### `apps/watcher/` (new in v1)

- [ ] Create `apps/watcher/package.json`.
- [ ] Implement `apps/watcher/src/watcher.ts` — chokidar-based watch on `.draftsman/plans/*.md`, debounce, call `createJobFromInvocation`.
- [ ] Dedupe via existing idempotency store (key: `invoke:watcher:<absolute-path>:<sha256-of-content>`, matching the canonical model task).
- [ ] Add to top-level `docker-compose.yml` as an optional service.

### `apps/runner/cli.ts` (modifications to v0 code)

- [ ] Wire the capability-injecting controller into the CLI entry point — `apps/runner/cli.ts`.
- [ ] Support `draftsman fix --ticket <url>` and `draftsman investigate --ticket <url>` subcommands using the new pipeline definitions.

### Dockerfile self-repair hardening

- [ ] Remove auto-commit-and-push path from `execute-task` stage and any other stage that edits `apps/runner/Dockerfile`.
- [ ] Stage that detects missing toolchain returns `WAITING_FOR_INPUT` with a `dockerfile_patch` finding — `packages/core/src/pipeline/stages/execute-task.ts`.
- [ ] Human approval flow reuses existing `waiting_for_input` resume path; approved patch applied by a separate manual PR.
- [ ] Document the flow in `PIPELINE_EXECUTION_PLAN.md` follow-up edit.

### Cross-plan documentation updates

- [ ] Update `CANONICAL_MODEL_PLAN.md` — add `execute` to `InvocationMode`, add `watcher` to `InvocationSource`, add `StageVerdict` enum (`READY | BLOCKED | WAITING_FOR_INPUT`), add `jobs.current_stage` field, add verdict-to-lifecycle mapping, add watcher idempotency key to the Canonical Idempotency Keys section, cross-reference `PIPELINE_EXECUTION_PLAN.md`.
- [ ] Update `AUDIT_STORAGE_PLAN.md`:
  - Add `pipeline_run`, `pipeline_task_progress`, `pipeline_stage_events` tables to Required Tables.
  - Add pipeline stage event kinds to the Event Type Baseline section.
  - Update the `jobs` table definition: add `mode: 'investigate' | 'fix' | 'execute'` (currently only fix/investigate documented).
  - Update the `jobs` table definition: add `source` value `'watcher'` alongside the existing trello/slack/mcp/internal.
  - Add `jobs.current_stage TEXT NULL` field to the `jobs` table definition.
- [ ] Update `GITHUB_PR_PLAN.md` scope to cover both `fix` and `execute` modes (currently fix-scoped). Add a **Pipeline Phase-to-Stage Mapping** section that publishes the phase ownership table defined in this v1 plan's Decisions section: `QUEUED` = invocation layer, `PREPARE_BRANCH` = pipeline controller at run start, `EDITING` = `execute-plan`+`de-slop`+`simplify` (execute) or `ralph-iterate` (fix), `VALIDATING` = `pre-pr`, `PR_READY` = controller-emitted marker, `PR_OPEN` = `pr-create` stage (ONLY phase this stage owns), `COMPLETE` = merge webhook (out of pipeline scope). Update the **Commit Message Contract** section to specify `Draftsman-Job: <jobId>` on every commit in every mode and additionally `Draftsman-Task-Key: <key>` on execute-mode task commits. Reconcile the branch-naming and rollback rules with the pipeline's use of the same deterministic naming.
- [ ] Update `EXECUTION_VALIDATION_PLAN.md` — mark the profile resolver as implemented in v1, keep the override policy and convergence metrics as V2 targets.
- [ ] Update `PIPELINE_EXECUTION_PLAN.md` — mark the "Pending updates" follow-up as completed once v1 lands.

## Test Plan

### Unit

- [ ] Capability injection: stage declaring `requires: ["git.read"]` receives a `ctx.gitRead` handle and the property `gitWrite` does not exist on the runtime object. Assert via `Object.keys(ctx)`.
- [ ] Capability injection type-level: TypeScript compile error when a stage with `requires: ["git.read"]` tries to access `ctx.gitWrite`. Test via a `// @ts-expect-error` annotation in the test file.
- [ ] Git write capability: `commit()` rejects paths matching the profile's `pathBlockList` with a typed error.
- [ ] Git write capability: `commit()` automatically appends `Draftsman-Task-Key: <key>` trailer for execute-mode commits and `Draftsman-Job: <jobId>` trailer for fix-mode commits.
- [ ] Profile resolver: `FileProfileResolver` returns `null` for repos without `.draftsman/profile.json`.
- [ ] Profile resolver: Zod rejects invalid profile shapes.
- [ ] Canonical enum: `StageVerdict` values are exhaustive; transition map covers all combinations.
- [ ] Canonical enum: `InvocationSource` includes `watcher`; idempotency key builder produces the expected format.
- [ ] Stage input discrimination: TypeScript narrows `input.kind` correctly in each stage's `run` function.
- [ ] Pipeline definitions: `requiresProfile: true` pipeline blocks with `BLOCKED` if profile is still undefined after the resolve-profile stage runs.
- [ ] Rendered prompt hash: two identical stage invocations produce identical rendered hashes. Rendered hash reflects the exact string passed to `claude -p`, not just the template.

### Integration

- [ ] `fix` mode end-to-end in a scratch repo with a `.draftsman/profile.json` — runs Ralph, runs pre-pr, opens a PR.
- [ ] `investigate` mode end-to-end — analyzes a mock ticket, emits `delivery-intent.json` to the run artifact directory, creates no commits, no PR, does NOT call Trello APIs.
- [ ] `execute` mode with partial completion: run once, interrupt mid-task-2 with a process kill, re-run, verify task-1 is skipped (completed row in Postgres) and task-2 is reset via `git reset --hard <task_start_sha>` before re-running.
- [ ] `execute` mode completed re-run: run once to completion, re-run against the unchanged plan, verify all tasks are skipped via completed rows in Postgres (no Ralph invocations happen).
- [ ] Risky path guard: attempt to commit a file in the block-list, verify the commit is rejected by the capability before reaching git.
- [ ] Dockerfile self-repair: stage detects missing toolchain, returns `WAITING_FOR_INPUT` with `dockerfile_patch` finding, pipeline halts, no commits, no pushes.
- [ ] Watcher: drop a plan file into the watched directory, verify job is enqueued with `source: "watcher"` and idempotency key `invoke:watcher:<abs-path>:<content-sha256>`.
- [ ] Watcher dedupe: drop the same file twice, verify only one job is created.

### End-to-End

- [ ] `@draftsman fix` against draftsman-no-9 itself produces a valid PR via the pipeline.
- [ ] `@draftsman investigate` against a live Trello card: agent emits delivery intent; separate delivery worker consumes the intent and posts findings to the card. End-to-end test asserts that the comment lands, not that the agent called Trello.
- [ ] `@draftsman execute` invoked via watcher on a committed plan file produces a PR identical to CLI invocation.

## Rollout Phases

### Phase 1 — Capability Foundation

- [ ] `packages/core/src/pipeline/capabilities.ts` with all interfaces + implementations.
- [ ] `packages/core/src/pipeline/types.ts` migrated to discriminated unions + RunContext split.
- [ ] Controller rewritten to inject capabilities based on stage `requires`.
- [ ] Unit tests for capability injection and risky-path guard.

### Phase 2 — Profile + `fix` Mode

- [ ] `packages/core/src/profile/` module with `FileProfileResolver`.
- [ ] `resolve-profile` stage implementation.
- [ ] `ralph-iterate` stage + prompt for `fix` mode.
- [ ] `fixPipeline` definition.
- [ ] Integration tests for `fix` mode end-to-end.

### Phase 3 — `investigate` Mode

- [ ] `analyze` and `post-findings` stages + prompts.
- [ ] `investigatePipeline` definition.
- [ ] Integration tests for `investigate` mode.

### Phase 4 — Self-Repair Hardening

- [ ] Dockerfile self-repair path removed from stages, replaced with `WAITING_FOR_INPUT` flow returning a `dockerfile_patch` finding.
- [ ] Human approval flow wired through existing `waiting_for_input` resume path.
- [ ] Integration test for partial-run resumption via v0 `task_start_sha` checkpoint — no v1 changes to the recovery path, test just verifies the v0 mechanism works under v1's capability-injected stages.

### Phase 5 — Watcher + Canonical Updates + Doc Pass

- [ ] `apps/watcher` module.
- [ ] Canonical model migration for `execute` mode + `StageVerdict` + `jobs.current_stage`.
- [ ] DB migrations for `pipeline_stage_events` (and `pipeline_run`, `pipeline_task_progress` if not landed in v0).
- [ ] Documentation updates across `CANONICAL_MODEL_PLAN.md`, `AUDIT_STORAGE_PLAN.md`, `GITHUB_PR_PLAN.md`, `EXECUTION_VALIDATION_PLAN.md`, `PIPELINE_EXECUTION_PLAN.md`.
- [ ] End-to-end tests for all three modes.

## Done Looks Like

- `fix`, `investigate`, and `execute` all run on the same pipeline controller with mode-specific stage sequences.
- A stage cannot call `ctx.gitWrite.commit()` without declaring `requires: ["git.write"]`. TypeScript enforces the boundary at build time; the runtime object literally does not have the `gitWrite` field on stages that didn't declare it.
- `investigate`-mode stages cannot commit, by type. The read/write git split prevents accidental acquisition of write power.
- Risky-path block-list prevents any stage from committing files in disallowed directories, regardless of what the LLM generates.
- Partial runs resume cleanly via the v0 `task_start_sha` / `task_end_sha` checkpoint model. No trailer-based recovery heuristic.
- Missing toolchain drops the pipeline into `WAITING_FOR_INPUT` with a human-reviewable Dockerfile patch. No autonomous infra edits.
- `.draftsman/plans/` is a working drop point: commit a plan, watcher picks it up, pipeline runs it. Watcher jobs show `source: "watcher"` in the audit trail.
- `investigate` emits delivery intent artifacts; the existing delivery worker performs Trello writes. Agent never calls Trello APIs directly.
- `pr-create` stage honors `GITHUB_PR_PLAN.md` for both `fix` and `execute` modes. Commit contracts include `Draftsman-Task-Key` trailers on execute-mode commits.
- `CANONICAL_MODEL_PLAN.md`, `AUDIT_STORAGE_PLAN.md`, `GITHUB_PR_PLAN.md`, and `EXECUTION_VALIDATION_PLAN.md` reference the pipeline accurately. No stale claims about what's built or planned.
- Codex re-review of both plan docs returns "Approve as written" or "Approve with changes" at worst. No remaining Critical findings.

## Resolved in this round

Recording for audit; do not relitigate:

- **Git capability splits into read and write.** `analyze` and `pr-create` declare `requires: ["git.read"]` and cannot commit by type — `pr-create` never pushes either (branch publication is a controller-owned step between `pre-pr` READY and `pr-create`). `execute-task`, `de-slop`, `simplify`, `pre-pr`, and `ralph-iterate` declare both `git.read` and `git.write`.
- **Capability injection is type-level via `StageContextFor<Requires>`**, not "optional fields on a shared shape." Runtime object mirrors the type — only declared handles exist.
- **Trailer-based crash recovery is rejected.** v0's `task_start_sha` / `task_end_sha` checkpoint model is the sole recovery path. Trailers are audit metadata only.
- **Commit trailer contract (final):** every draftsman commit in any mode always carries `Draftsman-Job: <jobId>`. Execute-mode task commits additionally carry `Draftsman-Task-Key: <key>`. Fix-mode commits carry only `Draftsman-Job`. Both trailers are audit-only. Injection is automatic (controller-owned), not stage-supplied.
- **`resolve-profile` stage has no capabilities.** It reads `.draftsman/profile.json` directly, returns the profile in its stage output, controller merges the output into `RunContext.profile` before the next stage runs. No chicken-and-egg with a `profile` capability that doesn't yet exist. Downstream stages declare `requires: ["profile"]` and receive a read-only wrapper.
- **`watcher` is a first-class `InvocationSource`.** Idempotency key: `invoke:watcher:<absolute-path>:<sha256-of-content>`.
- **`GITHUB_PR_PLAN.md` lifecycle phases are distributed across pipeline stages**, not owned by `pr-create`. `PREPARE_BRANCH` is controller-owned. `EDITING` spans execute-plan + de-slop + simplify (execute) or ralph-iterate (fix). `VALIDATING` is `pre-pr`. `PR_READY` is a controller-emitted marker. `PR_OPEN` is the `pr-create` stage's sole responsibility. `COMPLETE` is out of pipeline scope (triggered by merge webhook).
- **`post-findings` emits a delivery intent artifact**, does not call Trello APIs directly. Delivery worker handles the write.

## Unresolved Questions

- [ ] Should `resolve-profile` be a distinct stage or folded into `ingest`? Distinct is cleaner for auditability (separate verdict, separate log), folded is fewer moving parts. Leaning distinct.
- [ ] Profile schema validation: fail hard on invalid `.draftsman/profile.json` at resolve-profile stage, or soft-degrade to `allowNoValidation` with audit warning? Leaning hard-fail.
- [ ] Watcher as a long-running service vs a cron job running `draftsman execute` directly on new files: long-running is more responsive, cron is operationally simpler. Leaning long-running with debounce.
- [ ] Do we need a per-repo `.draftsman/path-policy.json` separate from `.draftsman/profile.json`, or are allow/block lists a field on the profile? Leaning: same file. Profile is the single per-repo config source.
- [ ] V1 release as one big PR or phased PRs per rollout phase? Phased is easier to review but longer to fully land. One big PR is faster but harder to review. Leaning phased with each phase behind a feature flag that defaults off until the whole v1 is done.
