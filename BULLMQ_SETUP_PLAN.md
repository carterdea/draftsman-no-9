# BullMQ Setup Plan

Scope: get from webhook invocation to running jobs, with safe pause/resume when human input is required.

## Decisions

- BullMQ handles durable queueing and retries only.
- Execution state lives in Postgres, not only in BullMQ job payloads.
- A waiting-for-human step does not hold a BullMQ worker slot.
- When input is needed, runner exits cleanly and orchestration resumes from checkpoint after answer arrives.
- One queue is enough for MVP (`draftsman:jobs`), split queues later only if throughput demands it.

## Job Lifecycle (MVP)

`queued -> running -> waiting_for_input -> resumed -> running -> completed|failed|canceled`

Notes:
- `waiting_for_input` is a DB state.
- BullMQ job should complete when entering `waiting_for_input`.
- Resume creates a new BullMQ job referencing the same `job_id`.

## Queue Contract

Queue name: `draftsman:jobs`

Payload:

```json
{
  "jobId": "uuid",
  "trigger": "trello|slack|mcp",
  "action": "start|resume",
  "resumeFromCheckpointId": "optional"
}
```

Job options:
- deterministic `jobId` for dedupe: `${source}:${external_event_id}`
- `attempts`: 3
- exponential backoff with jitter
- `removeOnComplete`: bounded (for example 1000)
- `removeOnFail`: bounded + long retention

## Pause/Resume Design (Human Input)

1. Worker starts orchestration for `jobId`.
2. Runner executes until it either:
- finishes, or
- emits `needs_input` with structured question + checkpoint.
3. Worker persists:
- `status=waiting_for_input`
- `checkpoint_id`
- question payload
- timeout/expiry timestamp
4. Worker enqueues outbound notification task (Slack/Trello/MCP response).
5. Worker completes BullMQ job.
6. Human answer arrives via Slack webhook or MCP `resume_job`.
7. API validates answer, stores it, sets `status=resumed`.
8. API enqueues new BullMQ job with `action=resume` and `resumeFromCheckpointId`.
9. Worker restarts runner with checkpoint + answer context.

Why this shape:
- no long-running locked BullMQ job
- no worker slot pinned for hours
- retries remain simple and deterministic
- exact resume point is explicit and auditable

## Runner Contract Changes

- Add structured terminal outcomes:
- `SUCCESS`
- `FAILED`
- `NEEDS_INPUT`
- For `NEEDS_INPUT`, runner returns:
- `checkpoint_id`
- `question` (id, text, choices, freeform allowed)
- optional `context_snippet` for user-facing message
- Worker maps runner outcome into DB status + queue behavior.

## Control Plane Tasks

- [ ] Add Redis/BullMQ connection factory (`apps/api` + `apps/worker` shared helper).
- [ ] Add `draftsman:jobs` queue producer in API webhook path.
- [ ] Add worker consumer that handles `start|resume`.
- [ ] Add idempotent enqueue keyed by `source + external_event_id`.
- [ ] Add queue event hooks (`completed`, `failed`, `stalled`) into audit events.
- [ ] Add health endpoints for Redis + queue depth snapshots.

## Data Model Tasks

- [ ] Add `jobs` table with status, mode, source, repo, audit pointers.
- [ ] Add `job_checkpoints` table (checkpoint payload, created_at).
- [ ] Add `job_questions` table (question payload, channel, expires_at, answered_at).
- [ ] Add `job_answers` table (answer payload, responder identity, source event id).
- [ ] Add status transition guard logic (`running -> waiting_for_input -> resumed` only).

## API Tasks

- [ ] `POST /webhooks/trello`: create invocation + enqueue `start`.
- [ ] `POST /webhooks/slack`: parse answer/intake; enqueue `resume` on valid answer.
- [ ] MCP `create_job`: enqueue `start`.
- [ ] MCP `resume_job`: validate question is open, store answer, enqueue `resume`.
- [ ] Return deterministic errors for invalid/expired resume attempts.

## Worker Tasks

- [ ] Replace polling loop with BullMQ `Worker`.
- [ ] Load job state from DB at processor start (never trust queue payload alone).
- [ ] Dispatch runner backend (`docker run --rm`) with job context.
- [ ] Persist `NEEDS_INPUT` checkpoint and exit successfully.
- [ ] On `resume`, load checkpoint + answer, continue execution.
- [ ] Enforce hard timeouts and attempts at worker layer.

## Test Tasks

- [ ] Unit tests for enqueue dedupe and deterministic job ids.
- [ ] Unit tests for status transitions including illegal transition rejection.
- [ ] Unit tests for `NEEDS_INPUT` mapping to `waiting_for_input`.
- [ ] Integration test: Trello invocation enqueues and worker starts run.
- [ ] Integration test: `NEEDS_INPUT` pauses without occupying worker; resume answer restarts.
- [ ] Integration test: expired question cannot resume.
- [ ] Integration test: duplicate resume events are idempotent.

## Rollout Steps

- [ ] Phase 1: queue + worker skeleton + `start` action only.
- [ ] Phase 2: DB status model + audit hooks.
- [ ] Phase 3: `NEEDS_INPUT` pause + Slack/MCP resume flow.
- [ ] Phase 4: runner checkpoint resume support + end-to-end tests.

## Done Looks Like

- Any invocation source can enqueue a deterministic job.
- Worker processes jobs with retries and bounded failure behavior.
- Human-input pauses are durable and do not tie up worker capacity.
- Resume from Slack/MCP continues from a saved checkpoint.
- Full lifecycle is auditable in DB and visible in dashboard/logs.
