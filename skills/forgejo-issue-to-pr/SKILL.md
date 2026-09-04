---
name: forgejo-issue-to-pr
description: "Implement a Forgejo issue end to end and open a linked draft PR."
---

# Forgejo Issue to Pull Request

## Rules

- Resolve a server-qualified issue before editing; never guess between remotes.
- Preserve acceptance criteria, constraints, comments, labels, dependencies, and unrelated local changes.
- Use local `git` for code, branches, commits, rebases, and pushes; Forgejo tools for server resources.
- Report only verification that ran. Do not close the issue.
- Dispatch, cancel, and rerun Actions only on explicit request. Never echo dispatch inputs; only the confirmation dialog may show them.

## Workflow

1. Activate `issue`, `pull`, and `actions` together with `forgejo_tools`; avoid extra loader round-trips.
2. Use `forgejo_context current` when needed. If target remains ambiguous, ask the user.
3. Read the qualified issue with `forgejo_issue get`, then `timeline` from page 1 with explicit limits. Follow `Next page` until complete. Retry truncated pages with lower limits or narrower `since`/`before` bounds. Derive acceptance criteria only after snapshot and timeline are complete.
4. Inspect repository conventions and Git state. Create a focused branch from intended base. For defects, reproduce first when practical.
5. Implement the smallest complete fix at the shared cause. Update affected callers, remove obsolete paths, and run the narrow behavioral check. Add a permanent test only for an otherwise uncovered contract.
6. Review final diff for unrelated changes, secrets, generated files, and placeholders. Commit with the qualified issue reference and push to its resolved Forgejo remote.
7. List Actions runs for pushed `head_sha`; inspect failed jobs with `job_log max_bytes=32000`. Raise the cap only when truncation hides required evidence. Missing runs mean unknown, not success. Download an artifact only after inspecting metadata, to a deliberate workspace path, without overwrite unless explicitly requested.
8. If the user requested required `workflow_dispatch`, check `forgejo_context capabilities`, then dispatch exact workflow/ref/string inputs through confirmation. Never dispatch merely because a push run is absent.
9. Create a draft PR from pushed head to intended base. Body must link qualified issue, summarize changes, list exact local/Actions checks and results, and state unavailable/running checks or limitations.
10. Read the created PR with `forgejo_pull get`; report its qualified ref and URL.

Before rerun/cancel, report exact run ID, workflow, ref, and status, then require explicit request and tool confirmation. If push/auth fails, keep verified local branch and do not create a PR for an unpushed head.
