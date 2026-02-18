# Invocation Trigger Plan

Scope: unified invocation path for Trello, Slack, and MCP.

## Decisions

- All external triggers normalize into one internal entrypoint: `createJobFromInvocation`.
- Default mode is `investigate` across all sources unless `fix` is explicit.
- Trello trigger path supports:
  - assignment to Draftsman service user
  - explicit `@draftsman` comment mention
- Slack trigger path is a bot app using `app_mention`; v1 requires Trello URL in message.
- MCP v1 requires `ticket_url` (Trello link).
- MCP v2 may accept plain-text intake without Trello URL, but starts in `investigate` mode only.
- Plain-text repo resolution can use LLM extraction as a hint, but execution requires deterministic confidence:
  - high confidence: proceed
  - low confidence/ambiguous: pause in `WAITING_FOR_INPUT`
- Trello card auto-creation from plain-text intake is allowed only when evidence exists:
  - bug reproduced (for example via Playwright CLI), or
  - code-level bug confirmed during investigation
- Image and media context should be passed as URLs (for example S3), not binary blobs in trigger payloads.

## Invocation Envelope (Unified Contract)

```json
{
  "source": "trello|slack|mcp",
  "source_type": "trello_ticket|plain_text_intake",
  "external_event_id": "provider_event_id",
  "invoker": {
    "id": "user_id",
    "display_name": "name"
  },
  "mode": "investigate|fix",
  "ticket_url": "https://trello.com/c/...",
  "repo_hint": "owner/repo",
  "problem_statement": "required for plain_text_intake",
  "raw_context": "required for plain_text_intake",
  "attachment_urls": ["https://..."],
  "metadata": {}
}
```

## Source Behavior (v1 -> v2)

### Trello (v1)

- Receive webhook.
- Verify signature and dedupe by action id.
- Accept only:
  - assignment to Draftsman service user, or
  - `@draftsman` comment invoke.
- Create `investigate` job by default unless invoke explicitly requests `fix`.

### Slack (v1)

- Slack app + bot token + event subscriptions.
- Handle `app_mention`.
- Parse mode + Trello URL.
- If Trello URL missing, reject with usage guidance.
- Default to `investigate`.

### MCP (v1)

- Expose `create_job`, `get_job`, `list_jobs`, `resume_job`.
- `create_job` requires Trello `ticket_url`.
- Return `job_id` immediately after enqueue.

### MCP (v2 plain text)

- Accept `source_type=plain_text_intake` with `problem_statement` + `raw_context`.
- Run `investigate`.
- Attempt deterministic repo resolution with LLM assist + confidence gate.
- If evidence threshold is met, optionally create Trello card and link it to audit/job.

## Tasks

- [ ] Implement `createJobFromInvocation` service in control plane.
- [ ] Add unified invocation schema validation.
- [ ] Add dedupe store keyed by provider event id and source.
- [ ] Implement Trello webhook handler for assignment + `@draftsman` comment triggers.
- [ ] Implement Slack bot `app_mention` handler with mode parser and Trello URL requirement.
- [ ] Implement MCP server tools (`create_job`, `get_job`, `list_jobs`, `resume_job`) using same service.
- [ ] Add repo resolver pipeline: explicit hints -> deterministic mapping -> LLM hint extraction -> confidence gate.
- [ ] Add `WAITING_FOR_INPUT` flow when repo confidence is low.
- [ ] Add plain-text intake schema and audit model for v2.
- [ ] Add Trello auto-create policy gate requiring reproduction or code-confirmed bug evidence.
- [ ] Add artifact URL ingestion support (screenshots/video links).
- [ ] Add tests for trigger parsing, dedupe, and mode default behavior.
- [ ] Add tests for repo confidence gating and pause/resume behavior.
- [ ] Add tests for Trello auto-create evidence gate.
- [ ] Update `README.md` to reference this plan once implementation starts.

## Done Looks Like

- Trello, Slack, and MCP all create jobs through one auditable code path.
- `investigate` is the safe default everywhere.
- Plain-text intake can be supported without bypassing safety controls.
- Repo ambiguity pauses execution instead of guessing.
- Trello creation from plain text happens only after objective bug evidence.
