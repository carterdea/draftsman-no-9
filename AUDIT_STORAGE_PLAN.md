# Audit Storage Plan

Scope: storage model for audit logs, artifacts, and retention policy across Trello, Slack, and MCP invocation paths.

## Decisions

- Use Postgres for durable job state and append-only audit metadata.
- Keep raw audit event payloads for 90 days.
- Keep compact job summary fields and key outcome links long-term.
- Store large blobs (screenshots, video, trace, full stdout/stderr) in object storage; store pointers in Postgres.
- Screenshot is recommended evidence by default.
- Video is recommended only when a screenshot is insufficient (for example animation, timing-sensitive behavior, multi-step transitions).
- Artifact backend and environment wiring details live in `ARTIFACT_STORAGE_PLAN.md`.

## Required Tables (MVP)

### `jobs`

Canonical run record.

- `id` (uuid pk)
- `status` (`queued | running | waiting_for_input | resumed | completed | failed | canceled | expired`)
- `mode` (`investigate | fix`)
- `source` (`trello | slack | mcp | internal`)
- `source_ref_id` (card id / message ts / mcp request id)
- `source_ref_url` (deep link to invocation message/card when available)
- `invoker_id`, `invoker_display`
- `repo_owner`, `repo_name`, `base_sha`, `head_sha`, `branch_name`
- `agent_name`, `agent_version`
- `final_outcome`, `result_summary`
- `created_at`, `started_at`, `ended_at`

Indexes:

- `(status, created_at desc)`
- `(source, source_ref_id)` unique for idempotency
- `(repo_owner, repo_name, created_at desc)`

### `job_events`

Append-only timeline.

- `id` (bigserial pk)
- `job_id` (fk -> `jobs.id`)
- `seq` (int, monotonic per job)
- `event_type` (text)
- `event_ts` (timestamptz)
- `payload_json` (jsonb)
- `payload_size_bytes` (int)

Indexes:

- `(job_id, seq)` unique
- `(job_id, event_ts)`
- `(event_type, event_ts desc)`

### `job_artifacts`

Artifact pointers and delivery outputs.

- `id` (uuid pk)
- `job_id` (fk -> `jobs.id`)
- `kind` (`pr_url | screenshot | video | playwright_trace | delivery_comment | validation_log | diff_summary`)
- `storage_provider` (`r2 | local_fs`)
- `uri` (url/path/object key)
- `metadata_json` (jsonb)
- `created_at` (timestamptz)

Indexes:

- `(job_id, kind, created_at desc)`

## Optional Tables (Not Required for MVP)

- `job_event_retention_runs`: record each daily retention task execution and deleted row counts.
- `job_event_compactions`: if later compressing older events into periodic summaries.
- `job_costs`: if later tracking per-run token/compute costs in normalized form.

## Retention Policy

### Raw Event Retention

- Retain `job_events.payload_json` for 90 days.
- After 90 days, delete rows or replace payload with minimal tombstone payload, based on compliance needs.

Recommended MVP action:

- Hard-delete `job_events` rows older than 90 days.
- Keep `jobs` and `job_artifacts` rows so run history and outcomes remain visible.

### Artifact Retention

- Keep lightweight artifact pointers in `job_artifacts`.
- Configure object storage lifecycle:
- screenshots/traces/log bundles: 90 days default
- delivery links and PR URLs: keep long-term
- video: 90 days unless policy override requires longer

## Daily Retention Job

- Run once per day (off-peak).
- Delete `job_events` where `event_ts < now() - interval '90 days'`.
- Optionally prune object blobs older than policy horizon.
- Emit an internal audit event with counts deleted by table/kind.

## Event Type Baseline

- `invocation.received`
- `repo.resolved`
- `execution.started`
- `llm.iteration.started`
- `llm.iteration.completed`
- `command.started`
- `command.completed`
- `validation.completed`
- `human_input.requested`
- `human_input.received`
- `human_input.expired`
- `delivery.comment_posted`
- `delivery.attachment_uploaded`
- `delivery.attachment_failed`
- `delivery.list_moved`
- `pr.created`
- `job.completed`
- `job.failed`
- `job.canceled`
- `job.expired`

## Do We Need Any Other DB Tables To Execute This?

For audit logs specifically, `jobs + job_events + job_artifacts` is sufficient.

For full Draftsman workflow (pause/resume + human input + cancellation), also needed:

- `job_checkpoints`
- `job_questions`
- `job_answers`
- `job_cancellations`

Those are execution-control tables, not audit-storage requirements.

## Implementation Tasks

- [ ] Add migrations for `jobs`, `job_events`, `job_artifacts`.
- [ ] Add retention worker (daily) for 90-day event cleanup.
- [ ] Add artifact storage adapter with URI metadata.
- [ ] Add audit API filters for `event_type`, `since`, `cursor`.
- [ ] Add tests for append-only event ordering and retention deletion behavior.
