# Pipeline Execution Plan

Scope: linear multi-stage execution pipeline that turns a design-doc-style plan file into a reviewed pull request. Supersedes the Ralph-only execution model for the new `execute` invocation mode, and becomes the shared controller that the existing `investigate` and `fix` modes also compose onto.

## Status

- v0 target: `execute` mode, CLI-only, synchronous, single-repo (draftsman-no-9 meta-bootstrap). QA stage deferred.
- Ralph V1 as specified in `EXECUTION_VALIDATION_PLAN.md` is the long-term target for the Ralph primitive. v0 ships a stripped Ralph (iteration cap + runtime cap + diff-changed heuristic) called from inside pipeline stages that need bounded convergence.
- `RALPH_V1_POLICY.md` is superseded for v0 scope by this document. Its convergence metrics remain the roadmap for V2.

## Decisions

- Execution is modeled as a **linear pipeline of named stages**, not a single monolithic agent session or a top-level convergence loop.
- Each stage runs in a **fresh `claude -p` invocation** with its own system prompt. No context carries between stages at the LLM level.
- The **Docker container is reused across stages** within one pipeline run. Disk state (git commits, plan file, audit files) is the only cross-stage state.
- **Ralph is a primitive**, not a top-level mode. Pipeline stages that need bounded convergence call `runBoundedIteration(context, caps)`. `fix` mode becomes a short pipeline around a single Ralph invocation. `execute` mode calls Ralph twice: once per task inside `execute-plan`, once inside `pre-pr` when validation fails.
- **Every stage emits a structured verdict** enforced by `claude -p --json-schema`, validated host-side against a Zod schema. Three-layer enforcement: prompt contract → Claude schema validator → controller Zod parse.
- **Plan files have no required YAML frontmatter.** Section-name matching uses loose case-insensitive regex. The `/design-doc` skill output drops in without changes.
- **The plan file is mounted read-only.** No stage, for any reason, writes to it. This removes a TOCTOU class (snapshot-run-diff can't catch a stage that edits mid-run and reverts before exit) and makes plans a true immutable input.
- **Execution progress lives in Postgres, not in the plan file.** A `pipeline_task_progress` table keyed by `task_key` (where `task_key = sha256(section_path + ordinal + normalized_text)`) records per-task state (`pending | in_progress | completed | blocked | abandoned`). Unique per `(run_id, task_key)`; resume lookup by `(plan_id, task_key)`. Re-runs resume by reading this table, not by re-parsing checkboxes.
- **QA findings and any stage-produced annotations live in controller-managed artifact files** under `.draftsman/runs/<run_id>/` inside the workspace. These files are gitignored and are copied out to artifact storage on run completion. The plan file itself is never mutated.
- **Stage prompts are markdown files** colocated with stage code in `packages/core/src/pipeline/prompts/`. Versioned as source, reviewed in PRs, hashed per invocation for audit.
- **JSONL streaming** from Claude invocations into per-stage log files in the container. Controller copies out to host on run completion and persists to artifact storage.
- **Dockerfile self-repair** is allowed: if a build fails because a toolchain is missing, the runner edits the Dockerfile, commits, and pushes. Not filed as a task. Next run rebuilds from the updated image.
- **No auto-merge.** Pipeline ends at `gh pr create`. Human review always gates merge.
- **Container-first from v0.** No host execution path. Same Dockerfile as production.

## Invocation Modes

**v0 ships `execute` mode only.** The existing `investigate` and `fix` modes keep running on the legacy execution path until v1 reimplements them on the shared pipeline controller. See `PIPELINE_EXECUTION_V1_PLAN.md` for the v1 migration of those modes. No v0 code should claim support for `investigate` or `fix` on the new controller.

### `execute`
`ingest → open-questions-gate → plan-validation → execute-plan (per task, inner Ralph) → de-slop → simplify → [qa → qa-fix-loop] → pre-pr (inner Ralph) → pr-create`

QA bracketed because it is deferred in v0. Repos opt into QA via profile flag once a boot strategy is chosen.

## Core Contracts

### Stage Interface

```ts
interface Stage<I extends StageInput, O extends StageOutput> {
  name: StageName;
  systemPromptPath: string;   // relative to pipeline/prompts/
  schema: ZodSchema<O>;       // host-side validation
  run(input: I, ctx: PipelineContext): Promise<O>;
  commitsAllowed: boolean;    // v0 only: enforced by controller clean-tree check
  ralphAllowed: boolean;      // v0 only: enforced by runtime gate before Ralph invocation
}
```

> **v1 replaces these booleans with type-level capability injection.** v0 ships the boolean form because it is faster to implement and still gives clean-tree + runtime-gate enforcement. The v1 redesign (generic `StageDefinition<Requires>` with derived `StageContextFor<Requires>`) is specified in `PIPELINE_EXECUTION_V1_PLAN.md`. Do not build new stages in v0 that depend on the boolean shape surviving — the migration path is deliberate.

### Stage Input

```ts
type StageInput = {
  runId: string;
  planId: string;
  planPath: string;           // inside workspace
  branch: string;
  stage: StageName;
  previousStageOutput?: StageOutput;
  caps: StageCaps;
};

type StageCaps = {
  maxIterations?: number;     // only if ralphAllowed
  maxRuntimeMs?: number;
  maxLocDelta?: number;
};
```

### Stage Output

```ts
type StageOutput = {
  status: "READY" | "BLOCKED" | "WAITING_FOR_INPUT";
  reason: string;
  commits: string[];          // git SHAs written this stage
  findings: Array<{
    path?: string;
    note: string;
  }>;
  artifacts: {
    logPath: string;          // inside workspace
    jsonlPath: string;
  };
  // Per-stage extensions allowed via union types in stages/*.ts
};
```

### Pipeline Definition

```ts
type PipelineDefinition = {
  mode: "execute";   // v0 supports only execute; v1 adds "fix" and "investigate"
  stages: Stage<any, any>[];
};
```

v0 intentionally has no `frozenPlanSections` or `appendOnlyPlanSections` fields. The plan file is read-only at the mount layer; there is no concept of per-section write policy. v1 may introduce pipeline-level preconditions (e.g. `requiresProfile`) via additional fields on this type.

### Pipeline Controller

```ts
interface PipelineController {
  run(def: PipelineDefinition, initial: StageInput): Promise<PipelineResult>;
}

type PipelineResult = {
  runId: string;
  finalStatus: "READY" | "BLOCKED" | "WAITING_FOR_INPUT";
  stageOutputs: StageOutput[];
  prUrl?: string;
};
```

Controller responsibilities:

1. Load plan file (read-only mount). Parse task list, compute per-task `task_key` values.
2. Load or create `pipeline_run` and `pipeline_task_progress` rows for this run.
3. For each stage in order:
   - Call `stage.run(input, ctx)`. The v0 `ctx` (`PipelineContext`) is a single shared shape holding the git handle, Ralph handle, and workspace paths. Capability boundaries are enforced by the stage's declared `commitsAllowed` / `ralphAllowed` booleans plus controller-side runtime checks, not by type-level capability injection. (v1 replaces this with a generic capability model; see `PIPELINE_EXECUTION_V1_PLAN.md`.)
   - Validate output against `stage.schema`.
   - Assert the plan file content hash is unchanged since load (defensive; the RO mount should make this impossible).
   - If `commitsAllowed` is false, assert the working tree is clean (`git diff --quiet && git diff --cached --quiet`) before and after the stage.
   - If `ralphAllowed` is false, reject any Ralph invocation attempts at the `runBoundedIteration` entry (runtime gate).
   - Persist stage event to Postgres + JSONL to artifact storage.
   - For `execute-plan` per-task runs, update the corresponding `pipeline_task_progress` row (`completed` on success, `blocked` on failure, commit SHAs recorded).
   - Propagate output as `previousStageOutput` to next stage.
   - Stop on any non-`READY` status.
4. Return `PipelineResult`.

Controller does **not** know about mode semantics. Mode logic is encoded entirely by which stages appear in `def.stages`.

### Task Identity

Task identity is a stable **task key**, not just normalized text, so that duplicate or identically-worded tasks in the same plan do not collide.

```
task_key = sha256(
  section_path      // e.g. "Phase 1 — Infra" (the H2/H3 heading the task lives under)
  + "\0"
  + ordinal         // 0-indexed position within the section
  + "\0"
  + normalized_task_line
)

normalized_task_line =
  raw_line
    .replace(/^\s*-\s*\[[x ]\]\s*/, "")   // strip checkbox
    .replace(/[*_`]/g, "")                 // strip markdown inline formatting
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
```

Properties:
- Two identical task lines in the same section produce distinct keys because of the ordinal.
- Editing a task's text produces a new key — the old row becomes orphaned history, new work runs.
- Reordering tasks changes ordinals, so reordered tasks produce new keys. **Plan authors should not reorder tasks between runs.** This is an acceptable constraint: the plan is a design doc, not a mutable backlog.
- Section heading changes also change keys. Same constraint.

### Re-run Semantics and Crash Recovery

Re-running a plan after `WAITING_FOR_INPUT`, `BLOCKED`, or a hard crash works as follows:

1. Controller loads the plan file (RO mount), parses tasks, computes `task_key` for each.
2. For each task, look up the most recent `pipeline_task_progress` row by `(plan_id, task_key)`.
3. Route based on status:
   - `completed` → skip, no stage invocation. Commit SHAs already in git.
   - `pending` → run normally.
   - `blocked` → re-run the task (blocker may have been resolved).
   - `in_progress` → **crash recovery**: the previous run crashed mid-task. Controller reads `task_start_sha` from the row, runs `git reset --hard <task_start_sha>` on the feature branch to discard any partial work, marks the old row as `abandoned`, inserts a new row with status `pending`, and runs the task from a clean slate.
4. Open-questions gate re-runs from scratch every invocation. If an answer was edited in, the gate passes; otherwise `WAITING_FOR_INPUT` again.

### Per-Task Git Checkpointing

Every `execute-plan` per-task invocation follows this sequence:

1. Controller records `task_start_sha = HEAD` into the `pipeline_task_progress` row. Row status = `in_progress`.
2. Stage runs Ralph, which may emit 1+ commits on the branch.
3. Stage returns structured verdict.
4. **Only after** the stage returns `READY` does the controller:
   - Record `task_end_sha = HEAD` into the row.
   - Update status from `in_progress` → `completed`.
   - Persist audit event.
5. If the stage returns `BLOCKED`, controller runs `git reset --hard <task_start_sha>` to discard partial work, marks row `blocked`, halts the pipeline.
6. If the process crashes between steps 1 and 4, the row is left as `in_progress` with only `task_start_sha` populated. Next run's crash-recovery branch (step 3 above) resets to `task_start_sha` and re-runs the task.

**The Postgres row is the sole source of truth for task completion.** Commit trailers are audit-only metadata, not recovery state. This avoids the "Ralph emitted 2 commits with trailers but the task isn't done" ambiguity — the presence of commits with a `Draftsman-Task-Key` trailer does not imply task completion.

### Guarantee

v0 guarantees idempotent resumption across:
- `WAITING_FOR_INPUT` pause and re-run.
- `BLOCKED` halt and re-run after operator remediation.
- Process crash mid-task (via `git reset --hard task_start_sha` on next run).

v0 does **not** guarantee:
- Concurrency safety (two pipeline runs against the same plan simultaneously — behavior undefined; use BullMQ concurrency caps from `BULLMQ_SETUP_PLAN.md` to prevent).
- Stale row sweeping (abandoned `in_progress` rows from crashed runs are recovered on next run for the same plan, but untouched rows stay in place as historical audit).

## Stage Catalog (execute mode)

| Stage | Ralph | Commits | Purpose |
|---|---|---|---|
| `ingest` | no | no | Load plan from local file path (CLI `--plan <file>`, `.draftsman/plans/`, `docs/plans/`). Trello and watcher sources are deferred to v1 (see `PIPELINE_EXECUTION_V1_PLAN.md`). |
| `open-questions-gate` | no | no | Fail-closed if any unchecked `- [ ]` in the open-questions section |
| `plan-validation` | no | no | LLM classifier checks tasks are specific enough (have file paths, clear scope) |
| `execute-plan` per task | **yes** | yes | Inner Ralph loop per task. Writes commits. Stops on task completion or caps. |
| `de-slop` | no | yes | Remove AI artifacts from recent diffs. Unconditional. |
| `simplify` | no | yes | Refine clarity/consistency of recent changes. Unconditional. |
| `qa` (deferred) | no | no | Boot stack, exercise critical paths, write findings to `.draftsman/runs/<run_id>/qa-findings.md` |
| `qa-fix-loop` (deferred) | yes | yes | Bounded Ralph fix pass over QA findings from the artifact file |
| `pre-pr` | **yes** | yes | Run checks; Ralph-fix any failures |
| `pr-create` | no | no | Create PR via `gh pr create`. Never merges. |

## Ralph Primitive V1 (Stripped)

Lives in `packages/core/src/ralph/`. Peer module to `pipeline/`.

### API

```ts
interface RalphController {
  runBoundedIteration(
    context: RalphContext,
    caps: RalphCaps,
  ): Promise<RalphResult>;
}

type RalphCaps = {
  maxIterations: number;
  maxRuntimeMs: number;
};

type RalphResult = {
  outcome: "CONVERGED" | "CAPPED" | "NO_PROGRESS";
  iterations: number;
  elapsedMs: number;
  lastCommit?: string;
  progressLog: Array<{ iteration: number; diffChanged: boolean }>;
};
```

### Stop Conditions (v0 only)

- `maxIterations` reached → `CAPPED`.
- `maxRuntimeMs` reached → `CAPPED`.
- Two consecutive iterations with no diff change → `NO_PROGRESS`.
- Validation signal passes → `CONVERGED`.

### Deferred to V1 (full spec in `EXECUTION_VALIDATION_PLAN.md`)

- `failureFingerprint` deterministic hash of failing signal + error headline.
- No-progress counter across non-consecutive iterations.
- Diff divergence trigger based on cumulative LOC growth.
- Stage-A/Stage-B validation split.
- Path policy enforcement (allow-list, risky-area block).
- Override policy with audit chain.

v0 keeps iteration + runtime + simple progress because that is the minimum viable gate. Full convergence metrics land when v0 is proven and we have real runs to calibrate against.

## Plan Format Conventions

No required frontmatter. The `/design-doc` skill output drops in with zero modification.

### Section-Name Matching

Loose, case-insensitive, matches any H1-H3 heading:

- Open-questions gate: `/^#{1,3}\s+(open|unresolved)\s+questions?\s*$/i`
- Task list: `/^#{1,3}\s+(tasks|rollout|steps)\s*$/i`

Multiple matching sections are a hard error at ingest. The controller rejects the plan with `BLOCKED` before any stage runs. Plan authors must consolidate into a single section.

### Immutability

The entire plan file is immutable during execution. The RO mount enforces this at the filesystem layer, and the controller defensively verifies the content hash matches pre-stage and post-stage. There are no per-section exceptions — no writable carve-outs, no append-only sections, no controller-mediated mutation API.

### Checkbox Semantics

- Open-questions gate: section must be absent, empty, or contain zero `- [ ]` unchecked items. Any unchecked item → `WAITING_FOR_INPUT` with the list posted in the reason.
- Task list: unchecked `- [ ]` items are the initial work queue at first run. On re-runs, the controller reads `pipeline_task_progress` rather than the checkboxes to decide what still needs to run. Checkbox state in the plan file is advisory — the controller never writes to it and never uses it as the source of truth for progress after the first run.

### Run State Storage

Per-run state lives in two places, both controller-owned:

1. **Postgres** — `pipeline_run` and `pipeline_task_progress` tables. See **Run Progress State** section below.
2. **Workspace artifact files** under `.draftsman/runs/<run_id>/` inside the runner container. Used for free-form stage outputs that don't fit into structured columns:
   - `qa-findings.md` — the QA stage and QA fix loop append findings here instead of to the plan.
   - `<stage>.log` — human-readable formatted output per stage.
   - `<stage>.jsonl` — raw Claude stream-json per stage.
   - `pipeline-result.json` — final pipeline verdict.

   The `.draftsman/runs/` directory is added to `.gitignore` in the target repo. Artifacts are copied out to artifact storage (R2 in prod, bind mount in dev) on run completion.

## Run Progress State

See **Task Identity** and **Per-Task Git Checkpointing** sections above for the identity model and recovery contract. The schema below implements that contract.

### Postgres Schema

```sql
CREATE TABLE pipeline_run (
  run_id         TEXT PRIMARY KEY,
  job_id         TEXT NOT NULL REFERENCES jobs(id),
  plan_id        TEXT NOT NULL,
  plan_path      TEXT NOT NULL,
  plan_hash      TEXT NOT NULL,      -- SHA256 of the plan file at ingest
  mode           TEXT NOT NULL,      -- v0: always 'execute'
  branch         TEXT NOT NULL,
  base_sha       TEXT NOT NULL,      -- HEAD of the base branch at pipeline start
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMPTZ,
  final_status   TEXT                -- 'READY' | 'BLOCKED' | 'WAITING_FOR_INPUT'
);

CREATE TABLE pipeline_task_progress (
  id             BIGSERIAL PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES pipeline_run(run_id),
  plan_id        TEXT NOT NULL,
  task_key       TEXT NOT NULL,      -- sha256(section_path + ordinal + normalized_text)
  section_path   TEXT NOT NULL,      -- heading of the containing section
  ordinal        INT NOT NULL,       -- position within the section
  task_text      TEXT NOT NULL,      -- original line, for audit + human display
  status         TEXT NOT NULL,      -- 'pending' | 'in_progress' | 'completed' | 'blocked' | 'abandoned'
  task_start_sha TEXT,               -- HEAD when stage started; null until run begins
  task_end_sha   TEXT,               -- HEAD when stage returned READY; null unless status=completed
  commit_shas    TEXT[] NOT NULL DEFAULT '{}',  -- audit list of commits in this task's range
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  error_reason   TEXT
);

-- A single run may have at most one row per task_key.
-- Across runs, the same (plan_id, task_key) pair accumulates history.
CREATE UNIQUE INDEX pipeline_task_progress_unique_per_run
  ON pipeline_task_progress (run_id, task_key);

CREATE INDEX pipeline_task_progress_by_plan_key
  ON pipeline_task_progress (plan_id, task_key, started_at DESC);
```

### Re-run Lookup

On pipeline start, for each task in the plan:

1. Compute `task_key` from `(section_path, ordinal, normalized_text)`.
2. Query `SELECT status, task_start_sha, task_end_sha, commit_shas FROM pipeline_task_progress WHERE plan_id = ? AND task_key = ? ORDER BY started_at DESC LIMIT 1`.
3. Route based on result:
   - No row → mark `pending`, run it.
   - `completed` → skip, insert a new row for the new `run_id` with status `completed`, copying `task_start_sha`, `task_end_sha`, and `commit_shas` from the previous row for audit.
   - `pending` → run normally.
   - `blocked` → re-run it (blocker may have been resolved).
   - `in_progress` → crashed-mid-task recovery: run `git reset --hard <task_start_sha>` on the feature branch to discard any partial work, mark the old row `abandoned`, insert a fresh `pending` row, then run the task.
   - `abandoned` → treat as pending (already superseded in a prior run).

This gives durable, idempotent resumption across `WAITING_FOR_INPUT` pauses, `BLOCKED` halts, and process crashes. See the **Guarantee** subsection of Re-run Semantics for the exact scope of what v0 covers and does not cover.

## Stage Prompts

### Location

`packages/core/src/pipeline/prompts/<stage-name>.system.md`

One file per stage. Plain markdown. Loaded via `Bun.file(...).text()` at stage init. Prompt ends with an explicit output schema contract that mirrors the Zod schema in code.

### Hashing

Each stage invocation logs two hashes to the audit row:

- `template_hash`: git blob SHA of the prompt file (free, automatic). Tracks which version of the template was active.
- `rendered_hash`: SHA256 of the fully rendered prompt content. v0 hashes the rendered template at load time (after variable substitution). **v1 tightens this to hash the exact string passed to `claude -p` at invocation time**, including the user message payload and any tool declarations. The v0 definition is provisional; see `PIPELINE_EXECUTION_V1_PLAN.md` for the v1 contract.

Template hash tracks prompt version. Rendered hash enables reproduction of what Claude saw (bounded by the v0 provisional definition until v1 lands).

### Example Prompt Shape

```markdown
# System: de-slop

You are the de-slop stage of the Draftsman pipeline. Your job is to remove AI artifacts from recent changes.

## Scope
- Only modify files changed in the last N commits on this branch.
- Remove: vacuous comments, unused helpers, speculative abstractions, trailing explanation blocks.
- Preserve: working code, existing tests, intentional comments.

## Output Schema

Return a single JSON object:

```json
{
  "status": "READY" | "BLOCKED",
  "reason": "one-line summary",
  "commits": ["<sha>", ...],
  "findings": [{"path": "...", "note": "..."}]
}
```
```

Actual rendering replaces `N` with a config value. The rendered string is hashed for audit.

## Execution Container

### Lifecycle

One container per pipeline run.

1. Control plane (host) spawns runner container with `docker run` (existing `apps/runner/Dockerfile`).
2. Entrypoint invokes the Bun pipeline CLI (`apps/runner/cli.ts`), not the legacy `entrypoint.sh` bash loop.
3. CLI loads `PipelineDefinition` for the mode, runs the controller inside the container.
4. On completion, container exits. Host copies artifacts out via `docker cp` or pre-mounted volume.
5. Container is removed.

### JSONL Streaming

Each stage:

- Invokes `claude -p --dangerously-skip-permissions --verbose --output-format stream-json --json-schema '<schema>' '<prompt>'`.
- Pipes raw JSONL to `/workspace/.draftsman/logs/<runId>/<stage>.jsonl` inside the container.
- Controller parses the `result`/`structured_output` event for the stage verdict.
- Full JSONL persisted to artifact storage (R2 in prod, local bind mount in dev).

### Dockerfile Self-Repair

If any stage's work fails due to a missing toolchain (`cargo: command not found`, `python3: not found`):

- Stage edits `apps/runner/Dockerfile` to add the missing toolchain via a new `RUN` layer.
- Commits and pushes the Dockerfile change on the same branch.
- Returns `BLOCKED` with `reason: "dockerfile updated, retry"`.
- Next run rebuilds the runner image and picks up the change.

Not filed as a plan task. Intentional fail-open for infra drift.

## Pre-PR Scope (v0)

Pre-PR is a Ralph-iterating stage. It runs checks; if any fail, it invokes a fixer with the failure output and re-runs. Bounded by stage caps.

### Checks (v0)

- Typecheck — must fix.
- Lint — must fix.
- Tests — must fix (either fix the test or fix the broken feature).
- Build — must pass.
- Semgrep (`bun run security`) — must address.

### Deferred

- Breaking-change detection.
- Coverage gates.

Both can become optional scans via profile flag once we have runs to calibrate against.

## Audit Surface

Pipeline stage transitions are first-class audit events.

### New Data (extends existing `AUDIT_STORAGE_PLAN.md`)

- `jobs.current_stage` — string, nullable.
- `pipeline_run` table — see **Run Progress State** section for full schema.
- `pipeline_task_progress` table — see **Run Progress State** section for full schema.
- `pipeline_stage_events` table (or extended `job_events` kinds):
  - `event_id`, `job_id`, `run_id`, `stage_name`, `status`, `reason`
  - `template_hash`, `rendered_hash`
  - `started_at`, `ended_at`
  - `log_path`, `jsonl_path`
  - `commits[]`

Exact schema decision for stage events (new table vs extended `job_events`) deferred to the migration PR. The `pipeline_run` and `pipeline_task_progress` tables are load-bearing for durable re-runs and must ship in v0.

### Plan file update in `AUDIT_STORAGE_PLAN.md`

`AUDIT_STORAGE_PLAN.md` does not currently reference pipeline stage events or task progress. A follow-up pass updates it to reference the three new tables above.

## Relation to Existing Plans

### Superseded for v0

- **`RALPH_V1_POLICY.md`** — scope is deferred to V2. Full convergence metric suite lives there as the roadmap.

### Updated

- **`EXECUTION_VALIDATION_PLAN.md`** — reframed: Ralph is a primitive invoked by pipeline stages, not a top-level mode. V1 stripped scope applies for v0; full spec is V2 target.
- **`INVOCATION_TRIGGER_PLAN.md`** — adds `execute` mode alongside `investigate` and `fix`. v0 plan sources are CLI path, `.draftsman/plans/`, or `docs/plans/`. Trello card body as a plan source is deferred to v1.
- **`README.md`** — adds pipeline execution layer reference.
- **`CLAUDE.md`** — adds pipeline to the "What You Are Building" section.

### Pending updates (this doc contradicts them; follow-up pass required)

- **`CANONICAL_MODEL_PLAN.md`** — the canonical enums do not include an `execute` mode or the `READY | BLOCKED | WAITING_FOR_INPUT` stage-verdict vocabulary. Canonical model must be extended with `execute` mode, `current_stage` field on jobs, and a mapping from stage verdicts to lifecycle states.
- **`AUDIT_STORAGE_PLAN.md`** — must reference `pipeline_run`, `pipeline_task_progress`, and stage events. Current schema has no place for these.
- **`GITHUB_PR_PLAN.md`** — defines a PR lifecycle state machine (`QUEUED → PREPARE_BRANCH → EDITING → VALIDATING → PR_READY → PR_OPEN → COMPLETE`), deterministic branch naming, commit trailer format, and rollback semantics. The pipeline's `pr-create` stage must implement this contract. The pipeline doc currently leaves this implicit and needs a cross-reference.

### Consumers (unchanged by this doc)

- `API_PLAN.md`, `ARTIFACT_STORAGE_PLAN.md`, `BULLMQ_SETUP_PLAN.md`, `BULLMQ_PAUSE_RESUME_PLAN.md`, `DOCKER_EXECUTION_PLAN.md`, `TRELLO_DELIVERY_PLAN.md`.

### Follow-up pass

After this doc is committed, a separate PR updates the three pending docs above to match. The pipeline code should not ship until those updates land.

## v0 Scope

### In

- `execute` mode pipeline (minus QA stages) running on a new pipeline controller.
- Pipeline controller + stage interface + Ralph primitive in `packages/core`.
- Plan parser with loose section matching, duplicate-heading hard-fail, RO mount + content-hash verification.
- Task key model (`section_path + ordinal + normalized_text`) for stable identity across runs.
- `pipeline_run` + `pipeline_task_progress` Postgres tables and migration, with `task_start_sha` / `task_end_sha` columns for crash recovery.
- Per-task git checkpoint recovery: `git reset --hard <task_start_sha>` on abandoned `in_progress` tasks.
- Headless system prompts for `execute-plan`, `de-slop`, `simplify`, `plan-validation`, `pre-pr`.
- Docker runner image rebuild, `apps/runner/cli.ts` as pipeline entrypoint.
- JSONL streaming to container-local log files, `docker cp` on completion.
- Dockerfile self-repair pattern (v1 hardens this behind `WAITING_FOR_INPUT` + human approval).
- Postgres audit writes on every stage transition.
- Template + rendered prompt hashing (rendered hash is provisional; v1 tightens).
- Unit tests for plan parser, gate logic, Ralph caps, handoff schema round-trip, task key collision behavior, crash recovery via `task_start_sha` reset.
- Integration test: run the pipeline against a fixture plan in a scratch git repo.
- End-to-end meta test: run the pipeline on a plan file inside draftsman-no-9 itself.

### Out (deferred to v1 — see `PIPELINE_EXECUTION_V1_PLAN.md`)

- `investigate` and `fix` modes on the shared controller. v0 leaves these on the legacy execution path.
- Capability-injection replacement of the `commitsAllowed` / `ralphAllowed` boolean flags.
- Discriminated-union `StageInput` and split `RunContext`.
- Validation profile resolver (multi-repo support).
- Risky-path block-list enforcement.
- Dockerfile self-repair hardening (v0 allows auto-commit-and-push; v1 moves it behind human approval).
- Commit trailer standardization (`Draftsman-Task-Key` trailer on execute-mode commits).
- Directory watcher for `.draftsman/plans/`.
- Trello card body as a plan source.
- Exact-invocation rendered prompt hash.
- BullMQ queue integration for pipeline runs (v0 runs synchronously from the CLI inside the runner container).
- Multi-repo concurrency / human pause-resume on `WAITING_FOR_INPUT` across sessions.

### Out (beyond v1, no ETA)

- QA stage and QA fix loop (deferred until boot strategy chosen).
- Full Ralph V1 convergence metrics (failureFingerprint, no-progress counter, diff divergence, stage-A/B split).
- Override policy and audit chain.

## Rollout Phases

Follows the standard 5-phase mental model.

### Phase 1 — Infra

- [ ] Create `packages/core/src/pipeline/` module.
- [ ] Create `packages/core/src/ralph/` module.
- [ ] Define `Stage`, `StageInput`, `StageOutput`, `PipelineDefinition`, `PipelineContext`, `PipelineResult` types + Zod schemas in `pipeline/types.ts`.
- [ ] Implement `PipelineController` in `pipeline/controller.ts`.
- [ ] Implement `RalphController.runBoundedIteration` in `ralph/controller.ts` with v0 stop conditions.
- [ ] Extend runner `Dockerfile` with Bun, git, `gh` CLI, Claude CLI, and pipeline code.
- [ ] Add JSONL logging helper and per-stage log file convention.
- [ ] Add Postgres migration for `pipeline_stage_events` (or `job_events` kind extension).

### Phase 2 — Wiring

- [ ] Implement plan parser with loose section matching, duplicate-heading hard-fail, and task key extraction (`section_path + ordinal + normalized_text`) in `pipeline/plan-parser.ts`.
- [ ] Implement content-hash verification against the RO-mounted plan file before and after each stage in `pipeline/controller.ts`.
- [ ] Implement open-questions gate stage.
- [ ] Implement plan-validation stage with `--json-schema` enforcement.
- [ ] Implement stage prompt loader and template-hash logging.
- [ ] Implement Claude invocation helper (`runClaudeStage(systemPrompt, input, schema)`).
- [ ] Implement per-task git checkpoint helper: `recordTaskStart`, `recordTaskEnd`, `resetToTaskStart` in `pipeline/task-checkpoint.ts`.

### Phase 3 — Adaptation

- [ ] Port `/execute-plan` intent into headless `execute-plan.system.md`.
- [ ] Port `/de-slop` intent into headless `de-slop.system.md`.
- [ ] Port `/simplify` intent into headless `simplify.system.md`.
- [ ] Port `/pre-pr` intent into headless `pre-pr.system.md`, scoped to typecheck/lint/tests/build/Semgrep.
- [ ] Write `plan-validation.system.md` from scratch (no interactive skill equivalent).

### Phase 4 — Integration

- [ ] Implement `apps/runner/cli.ts` with `draftsman execute --plan <file>` command.
- [ ] Register stage sequence for `execute` mode only. `investigate` and `fix` registrations land in v1.
- [ ] Retire legacy `apps/runner/entrypoint.sh` bash Ralph loop.
- [ ] Run end-to-end: pipeline executes a real plan inside draftsman-no-9, opens a real PR.

### Phase 5 — Testing

- [ ] Unit: plan parser section matching across loose headings.
- [ ] Unit: open-questions gate logic on empty, all-checked, mixed cases.
- [ ] Unit: Ralph v0 stop conditions (cap hit, runtime hit, no-progress).
- [ ] Unit: handoff schema Zod round-trip.
- [ ] Unit: plan parser hard-fails on duplicate matching headings.
- [ ] Unit: task key stable across whitespace/checkbox-state/inline-formatting changes, changes on content edits.
- [ ] Unit: two identical task lines in the same section get distinct keys via ordinal.
- [ ] Unit: re-run resumption skips `completed` tasks by key, re-runs `pending` and `blocked`.
- [ ] Unit: crash recovery resets working tree to `task_start_sha` on abandoned `in_progress` rows.
- [ ] Unit: completion only recorded after stage returns `READY` (not after first commit).
- [ ] Unit: controller detects content-hash drift on plan file (defensive check against a broken RO mount).
- [ ] Unit: controller detects dirty working tree for stages without commit capability.
- [ ] Integration: full pipeline run against fixture plan in scratch repo, mocked `gh pr create`.
- [ ] Meta: pipeline runs on its own design doc and produces a feature branch.

## Done Looks Like

- `draftsman execute --plan <file>` runs an end-to-end pipeline in Docker and opens a PR.
- Every stage emits a structured verdict; controller enforces it via Zod.
- Plan files with unchecked open questions hard-block at the gate, no code changes made.
- Hygiene stages (de-slop, simplify) run unconditionally and produce their own commits.
- Pre-PR stage fixes its own failures via a bounded Ralph pass.
- PR is created, never merged.
- Audit rows show every stage transition with template and rendered prompt hashes.
- Meta test: the pipeline successfully ships a PR against the draftsman-no-9 repo from a committed plan file.

## Resolved Decisions (moved out of Unresolved Questions in round-3 review)

These items were open earlier in the design. Recording them here so they are not relitigated:

- **Duplicate task lines are valid input.** Identity is the `task_key` formed from section path + ordinal + normalized text. Two identical lines in the same section get distinct keys via ordinal.
- **Crash recovery is a v0 guarantee.** Abandoned `in_progress` rows trigger `git reset --hard <task_start_sha>` on the next run, then the task re-runs from a clean slate.
- **Task completion is controller-owned Postgres state, not git-log heuristic.** The row's status transitions to `completed` only after the stage returns `READY`. Commit trailers are audit metadata, not recovery signal.
- **`investigate` and `fix` modes stay on the legacy execution path for v0.** They migrate to the shared controller in v1. The v0 doc no longer claims any support for them on the new controller.
- **v0 keeps `commitsAllowed` / `ralphAllowed` as booleans.** v1 replaces them with capability-injected types. Do not build v0 stages that depend on the boolean shape outlasting v1.
- **Dockerfile self-repair stays as an auto-commit-and-push fail-open in v0.** v1 hardens it behind a `WAITING_FOR_INPUT` + human approval flow. Tracked as a known trade-off, not a v0 blocker.
- **`de-slop` and `simplify` ship in v0.** They are load-bearing for the hygiene-first workflow that distinguishes this pipeline from naive autonomous loops.
- **Trello card body as a plan source is deferred to v1.** v0 accepts only local file paths.
- **Directory watcher is deferred to v1.** v0 is CLI-invoked only.

## Unresolved Questions

- [ ] QA stage boot strategy: host-side boot with container-side driver, GitHub Actions preview env, or profile-gated opt-in with no default implementation? Decision blocks the QA stage shipping at all, not v0 completion.
- [ ] `pipeline_stage_events` as a new table vs extending `job_events` with new event kinds? Deferred to migration PR. `pipeline_run` + `pipeline_task_progress` are not deferred — both must ship in v0.
- [ ] Ralph primitive V1 scope: ship full `EXECUTION_VALIDATION_PLAN.md` spec in v1 or phase the convergence metrics in over multiple releases?
- [ ] Task reordering semantics: currently a reorder changes ordinals, which changes keys, which makes reordered tasks look like new tasks. This is the desired behavior for now (reorders become new work) but plan authors should know. Worth considering a "task id" plan-file convention (e.g. `- [ ] [T1] do the thing`) for long-lived plans where reordering is legitimate.
- [ ] Should `pipeline_task_progress` rows have a sweeper for old `abandoned` rows, or accumulate forever as audit history? Leaning accumulate; audit-first wins here.
- [ ] The content-hash verification of the RO-mounted plan file is defensive. If an attacker can break the RO mount, they can do worse things anyway. Is the double-check worth the code, or is the RO mount sufficient on its own? Leaning keep the double-check — small code, obvious audit benefit.
