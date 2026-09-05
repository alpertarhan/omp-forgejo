# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-09-05

### Added

- `refs[]` batch operations: `forgejo_issue` and `forgejo_pull` `get`/`update`/`close`/`reopen` accept up to 10 qualified refs in one call (batch close confirms once with every ref enumerated); `forgejo_pull action=create` accepts `prs[]` to open up to 10 pull requests in one call.
- `forgejo_tools` now replies with a per-domain action cheatsheet so the agent picks the right action on the first try.

### Changed

- The toolkit activates only in repositories whose Git remotes resolve to a configured Forgejo server: elsewhere its tools are removed from the active set and its skills are not contributed, keeping the model context free of Forgejo schemas, prompts, and skills. Skills now load through resource discovery instead of the package manifest.
- The live Forgejo integration smoke test now covers cross-server attention degradation: arming with an unreachable server, waking from the healthy server, and `degradedServers` reporting.

### Fixed

- Cross-server attention watches no longer withhold healthy servers' wakes while another server is degraded; a server unreachable at arming is absorbed as a silent baseline on recovery, and `action=list` reports `degradedServers`.
- An incomplete timeline scan now matches events from its fetched pages, grows its scan capacity adaptively, and fails the watch once maximal capacity is still incomplete instead of silently live-locking.
- Timeline-only watches re-sync the server clock from the timeline response `Date` header each poll, so post-arm local clock drift cannot stretch the scan bound.
- CI watches reject `since` and `include_self` instead of silently ignoring them, and observe Actions runs beyond the first page (up to 150 newest runs per head SHA).
- Attention wake re-arm hints echo the original `servers` scope.
- `include_self=false` reports an actionable error when the token cannot read the authenticated user.
- The timeline and source watch managers share one scheduler implementation.

## [0.6.1] - 2026-09-04

### Changed

- Compressed model-visible tool schemas and bundled workflow prompts without changing tool names, actions, validation, or confirmation gates; CI now enforces schema and skill byte budgets.
- Model-visible output now defaults to 16 KB for normal results and 32 KB for diffs, Actions logs, and watch lists; callers can still request up to 128 KB with `max_bytes`.
- Raised the declared Node.js floor from 20.3 to 22.19.0 to match Pi's own runtime requirement; the CI import smoke test now runs under Node 22.19.

## [0.6.0] - 2026-08-26

### Added

- `forgejo_watch events=["ci"]`: one-shot CI watches that poll a pull request's Actions runs by its current head SHA and wake when a run that was in flight or started after arming finishes; new pushes are followed to the fresh head SHA, and runs already terminal at arming are baseline.
- `forgejo_watch target=review_requests|notifications`: cross-server attention watches that seed a silent baseline and wake the agent on new incoming review requests or unread notifications — the TUI dashboard's human notification, delivered as an agent wake.
- Watch wake messages now include a re-arm hint for continuing a completed watch, follow-up hints (`forgejo_actions action=jobs` for failed runs, `forgejo_pull action=get` for new review requests), and toolkit-generated item URLs.
- Integration smoke test against a real Forgejo 16 container in CI (`scripts/smoke.ts`), covering repository, PR, issue, timeline, watch, and attention query flows end to end.

### Changed

- The `User-Agent` version now comes from `package.json` instead of a hand-edited constant.
- CI runs a third job that exercises the toolkit against a live Forgejo instance.

### Fixed

- `forgejo_watch` no longer reports a merged pull request as `closed`: resource-level close detection now excludes merges, matching the timeline `closed` filter semantics.
- Dashboard notifications no longer re-announce previously seen review requests, failed runs, or notifications after a server error recovers or the dashboard scope changes; degraded servers keep their known items until they refresh successfully.
- An idle watch that reaches its timeout now gets one final poll, so a match landing exactly on the deadline is reported as a match instead of a timeout.
- An incomplete timeline poll scan now backs off and retries instead of permanently failing the watch.

### Changed

- `forgejo_watch action=stop` with an explicit `all=false` now fails with a clear message instead of the generic "exactly one of id or all=true" error.
- `any`-filtered watches no longer fetch the pull/issue resource on every poll; the extra request could never produce a match.
- Terminal watches release their timeline fingerprint cursors immediately, keeping history summaries lightweight.
- Link-header pagination parsing is shared between the client and the timeline scanner, removing a stricter/looser duplicate regex pair.

## [0.5.2] - 2026-08-21

### Fixed

- `forgejo_review` submit no longer lands approvals as PENDING reviews: the verdict enum now matches the Forgejo API event values (`APPROVED`), and a submit whose review stays PENDING is rejected loudly with the created review id instead of pretending success (#8).
- `forgejo_pull` readiness/merge no longer blocks merges the server allows: outstanding review requests only block when branch protection sets `block_on_official_review_requests`, and a request from a reviewer with a current review counts as answered. Requested changes likewise only block under `block_on_rejected_reviews`, and `remove_reviewers` verification failures now surface the accepted HTTP status (#9).

## [0.5.1] - 2026-08-19

### Changed

- Dashboard refreshes now coalesce without cancelling active work, `current` scope limits server polling, timeline-only watches avoid redundant resource requests, and cached identity lookup no longer forces Swagger rediscovery.

### Fixed

- Fixed shared credential and capability cancellation leaking between callers, session shutdown leaving discovery work alive, mutation prompts ignoring tool cancellation, and title-prefixed draft pull requests bypassing merge readiness.

## [0.5.0] - 2026-08-17

### Added

- Mutation confirmations now offer `Allow once`, session-wide approval, and an explicitly global `Always allow on all servers and repositories`. Saved approvals use stable action keys in `allowedMutations` in the global config only (never a committed project config), are refreshed by active Pi sessions before each mutation, and also enable approved mutations in headless print mode. Config writes use a cross-process lock so concurrent Pi sessions cannot overwrite each other's approvals.

## [0.4.2] - 2026-08-16

### Fixed

- `forgejo_watch` start no longer fails with `response.data is not iterable`: Forgejo marshals an empty timeline window (Go nil slice) as JSON `null`, which the timeline scan now treats as no events (#6).

## [0.4.1] - 2026-08-15

### Changed

- Repository resolution now reports an explicit reason when Git remotes point at GitHub, GitLab, or Bitbucket instead of a configured Forgejo server, directing agents to the `gh` CLI or plain git instead of leaving the failure generic.
- Server configuration rejects known non-Forgejo hosts up front with a clear configuration error, preventing partially compatible GitHub/GitLab API setups that fail in confusing ways.

## [0.4.0] - 2026-08-14

### Added

- Added the lazy `forgejo_watch` domain for session-scoped one-shot issue and pull-request timeline watches, with start/list/stop controls and metadata-only Pi wake messages.

### Changed

- The dashboard widget, popup notifier, and automatic polling now start only when local Git remotes match a configured Forgejo server; explicit dashboard commands remain available elsewhere.
- Dashboard mutation refreshes are coalesced in the background, capability discovery is cached per server, explicit refreshes bypass that cache, and unsupported Actions polling is skipped.
- Incremental timeline scans now tolerate Forgejo pagination limits and local/server clock skew, cancel failed polls cleanly, deduplicate transition events, and bound watch-list model output.
- Large HTTP responses and artifact downloads are streamed with byte limits and request deadlines; merge readiness and label resolution page through complete decision inputs.
- Issue and pull-request comments, subscriptions, and planning metadata now share one verified mutation path to prevent behavior drift.
- GitHub Actions are pinned to immutable commits, release caches are disabled, Dependabot updates use a seven-day cooldown, and CI compiles/imports the extension under the minimum Node runtime.

### Fixed

- Fixed issue-list and server-clamped metadata pagination, issue-specific label updates, issue state-transition verification, UTF-8/job-log truncation, dashboard abort/repository races and privacy rendering, timeline cursor gaps, malformed reference handling, and remote base-path matching.

### Security

- Project-local Forgejo configuration and Git/SSH discovery are ignored until the project is trusted.
- Authenticated redirects cannot leave the configured API root; external links use validated HTTP(S) URLs and a shell-free Windows launcher.
- Watch notifications exclude remote bodies, titles, diffs, and raw errors; session shutdown closes active watches before runtime teardown.

## [0.3.0] - 2026-08-12

### Added

- `/fj-setup` is now a native four-step guided TUI for configuration scope, multi-server `fgj` or environment-token setup, Git remote aliases, dashboard profiles or custom preferences, final review, and atomic owner-only writes without manual JSON editing.

## [0.2.2] - 2026-08-12

### Changed

- Dashboard labels now identify authored pull-request totals explicitly as open counts.

## [0.2.1] - 2026-08-12

### Fixed

- Dashboard refresh failures now clear the failed server's cached issues, pull requests, notifications, and CI runs instead of presenting stale data.
- Changing repository context immediately clears CI runs belonging to the previous repository.

## [0.2.0] - 2026-08-12

### Changed

- Dashboard issue and pull collections now defensively discard closed results even if a Forgejo server ignores the requested `state=open` filter.
- The existing `env` credential provider is now explicitly documented and tested as the CLI-independent API-token path, including whitespace-token rejection.
- Dashboard polling now pauses when both the widget and notifications are disabled; explicit refreshes remain on demand and the status line reports sync and attention state.
- Dynamic tool loading now accepts at most four explicit domains per call instead of an all-domains shortcut, reducing accidental context growth.
- Cross-server search bodies use bounded previews, and oversized hidden tool details are compacted before session persistence.
- Always-on loader metadata and bundled skill descriptions are shorter without removing mutation safety requirements.

## [0.1.0] - 2026-08-12

### Added

- Multi-server Forgejo context resolution from local Git remotes and explicit qualified references.
- Compact TUI dashboard for assigned issues, authored pull requests, review requests, unread notifications, and failed Actions runs.
- Issue, pull request, notification, search, review, dashboard, context, and Actions tools.
- Paginated timelines and session-scoped incremental conversation cursors.
- Safe pull request readiness and merge checks with interactive confirmation.
- Forgejo Actions run, job, log, dispatch, cancel, rerun, artifact listing, and bounded download support.
- `forgejo-issue-to-pr` and `forgejo-pr-review` workflow skills.
- Environment-variable and `fgj` credential providers with redirect and secret-redaction protections.

[Unreleased]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.6.1...v0.7.0
[0.4.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/alpertarhan/pi-forgejo-toolkit/releases/tag/v0.1.0
