# PR Outcome Tracking Design Doc

## Problem Context

Draftsman creates PRs but has no feedback loop. Once a PR is opened, the system has no idea whether CI passed or failed, or whether the PR was eventually merged or closed. This means:

- No way to measure whether Draftsman is producing valid code
- No signal to detect regression in generation or validation quality
- No per-repo or per-mode pass rate to inform confidence thresholds
- Operators must manually check PRs to know what happened

The highest-value signal is **CI pass/fail on the PR**. This tells you whether the code Draftsman produced actually works in the target repo's real CI environment (which may differ from the local validation step). Merge/close status is secondary — it reflects human decisions with many confounding factors.

## Proposed Solution

Two-tier outcome tracking:

1. **Primary: CI results via GitHub App webhooks (real-time)**
   - GitHub App (already required for scoped PR credentials) subscribes to `check_suite` and `check_run` events
   - New `POST /webhooks/github` endpoint receives CI outcomes as they complete
   - Results stored in `ci_results` table, linked to job via repo + PR number

2. **Secondary: PR status via lazy polling with backoff (background)**
   - On PR creation, enqueue a delayed BullMQ job to check PR status
   - Poll with increasing intervals: `6h -> 12h -> 24h -> 48h -> stop`
   - Fibonacci-ish schedule; exact curve doesn't matter since this is low-priority
   - Store final status in `pr_outcomes` table

No new infrastructure. Uses the existing GitHub App, existing BullMQ queue, existing Postgres, existing webhook pattern from Trello.

## Goals and Non-Goals

### Goals

- Goal 1: real-time CI pass/fail tracking per PR, per repo, per invocation mode
- Goal 2: identify which checks fail most often (tests? types? lint?) to guide validation improvements
- Goal 3: lazy background capture of PR merge/close status for long-term metrics
- Goal 4: notify originating Trello card when CI fails (Slack as follow-on channel)
- Goal 5: audit trail entries for all outcome events

### Non-Goals

- Non-goal 1: auto-retry on CI failure (observe + notify only, no automated re-runs)
- Non-goal 2: real-time PR merge/close tracking (not worth a webhook subscription for low-value data)
- Non-goal 3: tracking CI on PRs Draftsman didn't create (out of scope)
- Non-goal 4: dashboard UI (metrics are queryable; dashboard is a separate effort)

## Design

CI webhook events flow through the API into Postgres. PR status is polled lazily by the worker. Both write to the audit trail.

```
GitHub CI webhook                     Lazy PR poller
     |                                     |
     v                                     v
POST /webhooks/github              BullMQ delayed job
     |                                     |
     v                                     v
Verify signature                   GitHub API: GET /pulls/:number
     |                                     |
     v                                     v
Match PR -> job_id                 Update pr_outcomes
     |                                     |
     v                                     |
Write ci_results                   Re-enqueue with backoff
     |                                  (or stop if terminal)
     v                                     |
Append job_event                   Append job_event
     |
     v
CI failed?
     |yes
     v
Enqueue notification
(draftsman:notifications)
     |
     v
Post to Trello card
(Slack as follow-on)
```

### Key Components

#### Component A: GitHub Webhook Endpoint

New route: `POST /webhooks/github`

- Verify `X-Hub-Signature-256` header (HMAC-SHA256 with app webhook secret)
- Filter to relevant events only (`check_suite.completed`, `check_run.completed`)
- Match incoming PR to Draftsman job:
  - Look up `pr_outcomes` row by `repo` + `pr_number`
  - If no match, discard (PR wasn't created by Draftsman)
- Write to `ci_results` table
- Append `ci_result_received` event to `job_events`
- Return `200 OK` immediately (no processing in request path)

Signature verification follows the same pattern as Trello webhook auth in `API_PLAN.md`, but uses GitHub's HMAC-SHA256 scheme:

```ts
import { createHmac } from "node:crypto";

function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
```

Events to subscribe to on the GitHub App:

| Event | Action filter | What we extract |
|---|---|---|
| `check_suite` | `completed` | Overall CI status (`success`, `failure`, `neutral`), `head_sha`, `pull_requests[].number` |
| `check_run` | `completed` | Individual check name, conclusion, details URL |

`check_suite` gives the aggregate; `check_run` gives per-check granularity. Both are useful:
- Aggregate answers "did CI pass?"
- Per-check answers "what broke?"

#### Component B: PR-to-Job Mapping

When Draftsman opens a PR, the worker already knows `job_id`, `repo`, and gets back `pr_number` + `pr_url` from the GitHub API response. At that point, insert into `pr_outcomes`:

```sql
INSERT INTO pr_outcomes (job_id, repo, pr_number, pr_url, head_sha, status, created_at)
VALUES ($1, $2, $3, $4, $5, 'open', NOW());
```

Webhook handler matches on `(repo, pr_number)` — fast index lookup, no parsing PR bodies or metadata.

#### Component C: CI Results Storage

```sql
CREATE TABLE ci_results (
  ci_result_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(job_id),
  pr_number     INT NOT NULL,
  repo          TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  check_name    TEXT,          -- NULL for check_suite aggregate
  event_type    TEXT NOT NULL,  -- 'check_suite' | 'check_run'
  conclusion    TEXT NOT NULL,  -- 'success' | 'failure' | 'neutral' | 'cancelled' | etc
  details_url   TEXT,
  raw_payload   JSONB,         -- full event payload; volume is low (~1K rows/month), keep indefinitely
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ci_results_job ON ci_results (job_id);
CREATE INDEX idx_ci_results_repo_pr ON ci_results (repo, pr_number);
```

One row per `check_run` event, plus one row per `check_suite` event. This means a single CI run might produce 5-10 rows (one aggregate + individual checks). That's fine; volume is low.

#### Component D: PR Outcome Polling (Lazy Backoff)

On PR creation, enqueue a delayed job on `draftsman:jobs`:

```ts
await jobsQueue.add(
  "check-pr-outcome",
  { jobId, repo, prNumber, attempt: 0 },
  { delay: 6 * 60 * 60 * 1000 }, // first check at +6h
);
```

Worker handler:

```ts
const POLL_DELAYS_HOURS = [6, 12, 24, 48]; // ~4 days total coverage

async function handleCheckPrOutcome(data: PrOutcomePayload) {
  const pr = await github.pulls.get({ owner, repo, pull_number: data.prNumber });

  if (pr.data.state === "closed") {
    // Terminal — record and stop
    await db.updatePrOutcome(data.jobId, {
      status: pr.data.merged ? "merged" : "closed",
      closedAt: pr.data.closed_at,
      mergedAt: pr.data.merged_at,
    });
    await db.appendJobEvent(data.jobId, "pr_outcome_resolved", {
      status: pr.data.merged ? "merged" : "closed",
    });
    return; // done, no re-enqueue
  }

  // Still open — re-enqueue with next delay, or stop
  const nextAttempt = data.attempt + 1;
  if (nextAttempt < POLL_DELAYS_HOURS.length) {
    await jobsQueue.add(
      "check-pr-outcome",
      { ...data, attempt: nextAttempt },
      { delay: POLL_DELAYS_HOURS[nextAttempt] * 60 * 60 * 1000 },
    );
  }
  // If we've exhausted attempts, stop. PR stays 'open' in our records.
}
```

Total API calls per PR: at most 4. Negligible load.

```sql
CREATE TABLE pr_outcomes (
  pr_outcome_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID NOT NULL REFERENCES jobs(job_id),
  repo          TEXT NOT NULL,
  pr_number     INT NOT NULL,
  pr_url        TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'merged' | 'closed'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ,
  merged_at     TIMESTAMPTZ,
  last_polled   TIMESTAMPTZ,

  UNIQUE (repo, pr_number)
);

CREATE INDEX idx_pr_outcomes_job ON pr_outcomes (job_id);
CREATE INDEX idx_pr_outcomes_status ON pr_outcomes (status) WHERE status = 'open';
```

#### Component E: Audit Events

New `job_events` event kinds:

| Event kind | When | Payload |
|---|---|---|
| `pr_opened` | Worker creates PR | `{ pr_number, pr_url, head_sha }` |
| `ci_result_received` | Webhook delivers check result | `{ check_name, conclusion, event_type }` |
| `ci_suite_completed` | Webhook delivers check_suite aggregate | `{ conclusion, check_count }` |
| `pr_outcome_polled` | Lazy poller checks PR status | `{ status, attempt }` |
| `pr_outcome_resolved` | PR reached terminal state | `{ status: "merged" \| "closed" }` |

#### Component F: Queryable Metrics

With `ci_results` + `pr_outcomes` in Postgres, these queries are straightforward:

```sql
-- CI pass rate by repo (last 30 days)
SELECT repo,
  COUNT(*) FILTER (WHERE conclusion = 'success') AS passed,
  COUNT(*) AS total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE conclusion = 'success') / COUNT(*), 1) AS pass_rate
FROM ci_results
WHERE event_type = 'check_suite' AND received_at > NOW() - INTERVAL '30 days'
GROUP BY repo;

-- Most common failing checks
SELECT check_name, COUNT(*) AS failures
FROM ci_results
WHERE conclusion = 'failure' AND event_type = 'check_run'
GROUP BY check_name
ORDER BY failures DESC;

-- Merge rate (secondary metric)
SELECT status, COUNT(*)
FROM pr_outcomes
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY status;
```

No dashboard needed initially. `psql` or a simple API endpoint can surface these.

#### Component G: CI Failure Notifications

When a `check_suite` webhook arrives with `conclusion: failure`, enqueue a notification on `draftsman:notifications` (the existing outbound queue from `BULLMQ_PAUSE_RESUME_PLAN.md`).

The webhook handler does the enqueue — not the notification logic itself. Keeps the webhook response fast.

```ts
// In the check_suite webhook handler, after writing ci_results:
if (conclusion === "failure") {
  await notificationsQueue.add("ci-failure-notify", {
    jobId,
    repo,
    prNumber,
    prUrl,
    failedChecks, // names of individual checks that failed, from check_runs
    detailsUrl,   // link to the check suite or first failing check
  });
}
```

Notification worker posts a comment on the originating Trello card:

```
CI failed on PR #42.
Failed checks: tests, typecheck
Details: https://github.com/org/repo/actions/runs/123

— Draftsman No. 9
```

Design notes:
- Uses existing `draftsman:notifications` queue — same retry/dead-letter policy as other outbound notifications
- Notification worker looks up the Trello card ID from the `jobs` table (already stored as part of the invocation source metadata)
- Only fires on `check_suite` failure, not individual `check_run` failures — avoids spamming one comment per failing check
- Idempotency: keyed by `(job_id, head_sha, check_suite_id)` to avoid duplicate comments if GitHub retries the webhook
- **Slack follow-on**: same notification payload, different delivery adapter. Add when Slack invocation channel is implemented per `INVOCATION_TRIGGER_PLAN.md`

## Alternatives Considered

| Alternative | Pros | Cons | Why Not Chosen |
|---|---|---|---|
| Webhook for PR merge/close events | Real-time merge data | High noise (PR events fire on every label/assign/review), low value signal | Lazy polling is simpler and merge data isn't urgent |
| Poll for CI status instead of webhook | No webhook setup needed | Delays CI signal by minutes/hours, more API calls | CI is the high-value signal — want it real-time |
| GitHub Actions workflow_run event | Cleaner than check_suite for Actions-based CI | Not all repos use Actions; check_suite/check_run are universal | check_suite works regardless of CI provider |
| Store CI results in job_events only | Fewer tables | Hard to query for aggregate metrics; events are append-only with mixed types | Dedicated table is cleaner for analytics |
| Exponential backoff (2x) for polling | Standard pattern | Jumps too fast (6h -> 12h -> 24h -> 48h -> 96h = 7.75 days) | Close enough; current schedule (6/12/24/48) covers ~4 days which is the useful window |

## Open Questions

- [ ] Should the `check-pr-outcome` polling job live on `draftsman:jobs` or get its own lightweight queue? Low volume suggests sharing the main queue is fine, but it's a different concern than core orchestration.
- [ ] Should CI failure notification include a summary of which files/tests failed, or just link to the GitHub details page? More detail is useful but requires parsing check_run annotations.

### Resolved

- ~~Raw payload retention~~ — keep full JSONB indefinitely. At triple-digit PRs/month, `ci_results` grows single-digit MB/month. Not worth a retention policy.
- ~~CI failure notification~~ — yes, post to originating Trello card on `check_suite` failure. Slack as follow-on when that channel is implemented.

## Implementation Plan

### - [ ] Phase 1: Foundation

- [ ] Add `pr_outcomes` table schema and migration
- [ ] Add `ci_results` table schema and migration
- [ ] Add `pr_opened` audit event emission in worker PR creation path
- [ ] Enqueue first `check-pr-outcome` delayed job on PR creation

### - [ ] Phase 2: CI Webhook + Failure Notification

- [ ] Add `POST /webhooks/github` route to API server
- [ ] Implement GitHub HMAC-SHA256 signature verification
- [ ] Implement `check_suite` event handler (aggregate CI status)
- [ ] Implement `check_run` event handler (per-check granularity)
- [ ] Add `ci_result_received` and `ci_suite_completed` audit events
- [ ] On `check_suite` failure, enqueue CI failure notification on `draftsman:notifications`
- [ ] Implement Trello comment delivery for CI failure notifications
- [ ] Configure GitHub App webhook subscription for check events

### - [ ] Phase 3: Lazy PR Polling

- [ ] Implement `check-pr-outcome` job handler in worker
- [ ] Implement backoff schedule with re-enqueue logic
- [ ] Add `pr_outcome_polled` and `pr_outcome_resolved` audit events
- [ ] Handle edge cases: PR deleted, repo transferred, API errors

### - [ ] Phase 4: Testing

- [ ] Unit: GitHub signature verification (valid, invalid, missing)
- [ ] Unit: check_suite/check_run event parsing and filtering
- [ ] Unit: PR-to-job matching (found, not found, duplicate events)
- [ ] Unit: polling backoff schedule and re-enqueue logic
- [ ] Unit: idempotent CI result insertion (same check_run delivered twice)
- [ ] Unit: CI failure enqueues notification; CI success does not
- [ ] Unit: notification idempotency (duplicate webhook doesn't duplicate Trello comment)
- [ ] Integration: webhook -> ci_results -> job_events pipeline
- [ ] Integration: PR creation -> delayed poll -> status resolution
- [ ] Metric queries return expected results from test data

## Appendix

- GitHub App webhook events reference: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- GitHub `check_suite` event shape: includes `conclusion`, `head_sha`, `pull_requests[]`
- GitHub `check_run` event shape: includes `name`, `conclusion`, `details_url`, `check_suite.id`
- Existing webhook pattern: `API_PLAN.md` Component A (Trello signature verification)
- Queue setup: `BULLMQ_SETUP_PLAN.md` and `BULLMQ_PAUSE_RESUME_PLAN.md`
- Current API: `apps/api/src/server.ts`
- Current worker: `apps/worker/src/worker.ts`

---

Open questions to discuss:
1. Polling queue placement — share `draftsman:jobs` or dedicate a queue?
2. CI failure comment detail level — just link, or parse check_run annotations?

Ready to refine any section or proceed to implementation?
