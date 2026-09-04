---
name: forgejo-pr-review
description: "Review a Forgejo PR, draft inline findings, and submit only when asked."
---

# Forgejo Pull Request Review

## Rules

- Review the exact qualified PR and head commit; never guess between remotes.
- Prioritize concrete correctness, regression, security, concurrency, data-loss, error-handling, and coverage defects—not style.
- Each finding needs an observable failure and changed file/line.
- Analysis is read-only. Never dispatch/cancel/rerun Actions. Never publish comments before preview and explicit submission request.

## Workflow

1. Activate `pull`, `review`, and `actions` together with `forgejo_tools`; avoid extra loader round-trips. Resolve target with `forgejo_context` if needed.
2. Use `forgejo_pull get`; record head SHA. Read `timeline`, `files`, and `commits` from page 1 through all pages, plus `diff`, `checks`, and `readiness`. Retry truncation with lower limits or narrower bounds. Treat timeline as canonical conversation/update stream.
3. Inspect affected local symbols and callers. Validate suspected defects against code, tests, config, Forgejo metadata, and checks. Missing evidence is unknown, not success; discard speculative findings.
4. List reviews and read bodies. Fetch relevant inline comments by `review_id`; retain stale/dismissed reviews as history, not current approval/blockers.
5. When run-level evidence is needed, list Actions by recorded head SHA; inspect failed jobs with `job_log max_bytes=32000`. Raise the cap only when truncation hides required evidence. Inspect artifact metadata before any deliberate, non-overwriting download.
6. Choose verdict: `REQUEST_CHANGES` for blocking defects, `COMMENT` for non-blocking findings/questions, `APPROVED` only with no blocker.
7. Create one review draft with findings first and reviewed head SHA. Add actionable inline comments at correct changed path and old/new position.
8. Preview complete verdict, body, and comments. Submit only when user requested publication; tool confirmation still applies. If head changed, discard/rebuild draft and review new snapshot, timeline, diff, and runs.

With no findings, report inspected evidence and limits; never invent a finding. Handle later rerun/cancel requests as separate confirmed mutations using exact run IDs.
