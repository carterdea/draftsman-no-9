# Trello Delivery Plan

Scope: Trello delivery path only. Agent suggests delivery intent. App performs Trello writes.

## Decisions

- Trello updates are deterministic app actions, not direct agent API calls.
- Agent must return explicit task outcome status: `completed | partial | failed`.
- App moves card to `Ready for Review` only when policy allows (default: PR exists).
- Attachment failures are non-blocking for list movement.
- Attachment failures are posted as warnings in the Trello comment.
- Keep board/list/link behavior configurable (DB + templates), not hardcoded.
- Optional fallback for failed attachment uploads can be added later (for example S3 + appended links).

## Contracts (v1)

### Agent -> App (`delivery_intent`)

```json
{
  "card_id": "trello_card_id",
  "task_status": "completed",
  "comment_markdown": "Delivery summary...",
  "pr_url": "https://github.com/owner/repo/pull/123",
  "shopify_preview_url": "https://store.myshopify.com/?preview_theme_id=12345",
  "shopify_customizer_url": "https://admin.shopify.com/store/store/themes/12345/editor",
  "attachments": [
    {
      "type": "image",
      "artifact_id": "playwright/screenshot.png"
    },
    {
      "type": "video",
      "artifact_id": "playwright/run.webm"
    }
  ],
  "requested_list_transition": "ready_for_review"
}
```

### App behavior on attachment failure

- Continue comment post + list move if transition policy passes.
- Append warning block with failed attachment names/reasons.
- Record warning event in audit trail.
- Do not mark job failed due to attachment upload failure alone.

## Tasks

- [ ] Define DB config for Trello board policy (`ready_for_review_list_id`, transition rules, templates).
- [ ] Implement `delivery_intent` schema validation with strict enum for `task_status`.
- [ ] Implement policy evaluator for list movement (default rule: require `pr_url`).
- [ ] Implement Trello comment renderer (PR link, Shopify links, notes, warnings).
- [ ] Implement Trello attachment uploader with per-file error capture.
- [ ] Implement non-blocking attachment failure flow + warning injection.
- [ ] Implement Trello list move command with idempotency guard.
- [ ] Add audit events for comment posted, attachment successes/failures, list move result.
- [ ] Add webhook/worker dedupe by Trello action/job id.
- [ ] Add tests for `task_status` behaviors (`completed`, `partial`, `failed`).
- [ ] Add tests proving attachment failure does not block list movement.
- [ ] Add tests for transition policy failure (for example missing `pr_url`).
- [ ] Add tests for renderer output including Shopify links when present.
- [ ] Document operator config in `README.md` once implementation lands.
- [ ] Evaluate optional fallback storage for failed attachments and decide go/no-go.

## Done Looks Like

- Agent reports explicit `task_status` on every run.
- Trello comment always posts deterministic structured output.
- Card move behavior is policy-controlled and auditable.
- Attachment upload failures surface as warnings and do not block eligible transitions.
- Test suite covers happy path and failure-path behavior for delivery.
