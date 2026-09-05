import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgejoError, type ForgejoClient } from "../src/client.js";
import {
	SourceWatchManager,
	type SourceWatchEmission,
} from "../src/source-watch.js";
import type {
	ApiResult,
	ForgejoActionRun,
	ForgejoIssue,
	ForgejoPullRequest,
	ResourceRef,
	ServerAlias,
} from "../src/types.js";

const ref: ResourceRef = {
	server: "work",
	owner: "acme",
	repo: "app",
	kind: "pull",
	index: 9,
};
const now = "2026-08-12T10:00:00.000Z";

function result<T>(data: T): ApiResult<T> {
	return { data, status: 200, headers: new Headers() };
}

function pull(sha: string): ForgejoPullRequest {
	return {
		id: 9,
		number: 9,
		title: "REMOTE TITLE",
		state: "open",
		updated_at: now,
		head: { ref: "feature", sha },
		base: { ref: "main", sha: "000" },
	} as unknown as ForgejoPullRequest;
}

function run(id: number, status: ForgejoActionRun["status"]): ForgejoActionRun {
	return {
		id,
		title: "REMOTE RUN TITLE",
		workflow_id: "ci.yml",
		index_in_repo: id,
		prettyref: "refs/heads/feature",
		commit_sha: "abc",
		event: "push",
		status,
		started: now,
		stopped: now,
		created: now,
		updated: now,
		html_url: `https://work.example/acme/app/actions/runs/${id}`,
	};
}

function reviewIssue(number: number): ForgejoIssue {
	return {
		id: number,
		number,
		title: `REMOTE REVIEW ${number}`,
		state: "open",
		updated_at: now,
		html_url: `https://work.example/acme/app/pulls/${number}`,
		repository: {
			id: 1,
			name: "app",
			full_name: "acme/app",
			html_url: "https://work.example/acme/app",
		},
	} as unknown as ForgejoIssue;
}

function fakeClient(
	request: ReturnType<typeof vi.fn>,
	alias: ServerAlias = "work",
): ForgejoClient {
	return {
		alias,
		config: { baseUrl: `https://${alias}.example` },
		request,
	} as unknown as ForgejoClient;
}

function manager(
	clientFor: (server: string) => ForgejoClient,
	aliases: ServerAlias[] = ["work"],
): {
	manager: SourceWatchManager;
	emissions: SourceWatchEmission[];
} {
	const emissions: SourceWatchEmission[] = [];
	return {
		manager: new SourceWatchManager(
			clientFor,
			() => aliases,
			(emission) => emissions.push(emission),
		),
		emissions,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("SourceWatchManager CI watches", () => {
	it("wakes when a baseline run finishes", async () => {
		let runs: ForgejoActionRun[] = [run(42, "running")];
		const request = vi.fn(async (path: string) => {
			if (path.endsWith("/pulls/9")) return result(pull("abc"));
			if (path.endsWith("/actions/runs"))
				return result({ workflow_runs: runs, total_count: runs.length });
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await subject.arm({ ref, pollIntervalMs: 100 });

		runs = [run(42, "success")];
		await vi.advanceTimersByTimeAsync(100);

		expect(emissions[0]).toMatchObject({ kind: "matched", source: "ci" });
		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(emissions[0].events).toHaveLength(1);
		expect(emissions[0].events[0]).toMatchObject({
			type: "ci-success",
			reference: "work:acme/app!9",
			runId: 42,
			workflow: "ci.yml",
			status: "success",
		});
		expect(subject.list()[0]).toMatchObject({ state: "matched" });
	});

	it("reports a run first observed as terminal", async () => {
		let runs: ForgejoActionRun[] = [];
		const request = vi.fn(async (path: string) => {
			if (path.endsWith("/pulls/9")) return result(pull("abc"));
			if (path.endsWith("/actions/runs"))
				return result({ workflow_runs: runs, total_count: runs.length });
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await subject.arm({ ref, pollIntervalMs: 100 });

		runs = [run(7, "failure")];
		await vi.advanceTimersByTimeAsync(100);

		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(emissions[0].events[0]).toMatchObject({
			type: "ci-failure",
			runId: 7,
		});
	});

	it("stays active while statuses do not change", async () => {
		const runs: ForgejoActionRun[] = [run(42, "running")];
		const request = vi.fn(async (path: string) => {
			if (path.endsWith("/pulls/9")) return result(pull("abc"));
			if (path.endsWith("/actions/runs"))
				return result({ workflow_runs: runs, total_count: runs.length });
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await subject.arm({ ref, pollIntervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);
		await vi.advanceTimersByTimeAsync(100);

		expect(emissions).toEqual([]);
		expect(subject.list()[0]).toMatchObject({ state: "active" });
	});

	it("follows a new head sha after a push", async () => {
		let sha = "first";
		const runsBySha: Record<string, ForgejoActionRun[]> = {
			first: [run(1, "running")],
			second: [run(2, "success")],
		};
		const request = vi.fn(async (path: string) => {
			if (path.endsWith("/pulls/9")) return result(pull(sha));
			if (path.endsWith("/actions/runs"))
				return result({
					workflow_runs: runsBySha[sha] ?? [],
					total_count: (runsBySha[sha] ?? []).length,
				});
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await subject.arm({ ref, pollIntervalMs: 100 });

		sha = "second";
		await vi.advanceTimersByTimeAsync(100);

		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(emissions[0].totalCount).toBe(1);
		expect(emissions[0].events[0]).toMatchObject({ runId: 2 });
	});

	it("does not report runs that were terminal at the baseline", async () => {
		const runs: ForgejoActionRun[] = [run(42, "failure")];
		const request = vi.fn(async (path: string) => {
			if (path.endsWith("/pulls/9")) return result(pull("abc"));
			if (path.endsWith("/actions/runs"))
				return result({ workflow_runs: runs, total_count: runs.length });
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await subject.arm({ ref, pollIntervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);

		expect(emissions).toEqual([]);
		expect(subject.list()[0]).toMatchObject({ state: "active" });
	});

	it("rejects a non-pull reference", async () => {
		const request = vi.fn();
		const { manager: subject } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await expect(
			subject.arm({
				ref: { ...ref, kind: "issue" },
				pollIntervalMs: 100,
			}),
		).rejects.toThrow("pull-request reference");
	});
});

describe("SourceWatchManager attention watches", () => {
	it("seeds a baseline and wakes only on new items", async () => {
		let issues: ForgejoIssue[] = [reviewIssue(30)];
		const request = vi.fn(async (path: string) => {
			if (path === "repos/issues/search") return result(issues);
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await subject.arm({ target: "review_requests", pollIntervalMs: 100 });
		expect(emissions).toEqual([]);

		issues = [reviewIssue(30), reviewIssue(31)];
		await vi.advanceTimersByTimeAsync(100);

		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(emissions[0]).toMatchObject({ source: "attention" });
		expect(emissions[0].events).toHaveLength(1);
		expect(emissions[0].events[0]).toMatchObject({
			type: "review-request",
			reference: "work:acme/app!31",
			title: "REMOTE REVIEW 31",
		});
	});

	it("watches notifications across multiple servers", async () => {
		const notifications: Record<string, unknown[]> = {
			work: [],
			community: [],
		};
		const requestFor = (alias: string) =>
			vi.fn(async (path: string) => {
				if (path === "notifications")
					return result(notifications[alias] ?? []);
				throw new Error(`unexpected path ${path}`);
			});
		const workRequest = requestFor("work");
		const communityRequest = requestFor("community");
		const { manager: subject, emissions } = manager(
			(server) =>
				fakeClient(
					server === "work" ? workRequest : communityRequest,
					server as ServerAlias,
				),
			["work", "community"],
		);
		await subject.arm({
			target: "notifications",
			pollIntervalMs: 100,
		});

		notifications.community = [
			{
				id: 5,
				unread: true,
				updated_at: now,
				subject: {
					title: "REMOTE SUBJECT",
					type: "Pull",
					html_url: "https://community.example/acme/app/pulls/3",
					url: "https://community.example/api/v1/repos/acme/app/pulls/3",
				},
				repository: {
					id: 2,
					name: "app",
					full_name: "acme/app",
					html_url: "https://community.example/acme/app",
				},
			},
		];
		await vi.advanceTimersByTimeAsync(100);

		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(emissions[0].events[0]).toMatchObject({
			type: "notification",
			reference: "community:acme/app!3",
		});
	});

	it("rejects unknown servers and empty server lists", async () => {
		const request = vi.fn();
		const { manager: subject } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await expect(
			subject.arm({
				target: "review_requests",
				servers: ["ghost"],
				pollIntervalMs: 100,
			}),
		).rejects.toThrow("unknown server 'ghost'");
		await expect(
			subject.arm({
				target: "review_requests",
				servers: [],
				pollIntervalMs: 100,
			}),
		).rejects.toThrow("at least one server");
	});

	it("deduplicates identical active watches", async () => {
		const request = vi.fn(async (path: string) => {
			if (path === "repos/issues/search") return result([]);
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		const first = await subject.arm({
			target: "review_requests",
			pollIntervalMs: 100,
		});
		const second = await subject.arm({
			target: "review_requests",
			pollIntervalMs: 100,
		});
		expect(second.id).toBe(first.id);
	});
});

describe("SourceWatchManager reliability", () => {
	it("backs off transient failures and fails permanently on auth errors", async () => {
		let calls = 0;
		const request = vi.fn(async (path: string) => {
			if (path === "repos/issues/search") {
				calls += 1;
				if (calls === 1) return result([]);
				if (calls === 2)
					throw new ForgejoError("REMOTE 503 BODY", {
						server: "work",
						status: 503,
						code: "http",
					});
				throw new ForgejoError("REMOTE 401 BODY", {
					server: "work",
					status: 401,
					code: "auth",
				});
			}
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await subject.arm({ target: "review_requests", pollIntervalMs: 100 });

		await vi.advanceTimersByTimeAsync(100);
		expect(subject.list()[0]).toMatchObject({
			state: "active",
			failures: 1,
			lastError: { code: "http", status: 503 },
		});
		await vi.advanceTimersByTimeAsync(200);
		expect(subject.list()[0]).toMatchObject({
			state: "failed",
			lastError: { code: "auth", status: 401 },
		});
		if (emissions[0]?.kind !== "failed") throw new Error("expected failure");
		expect(JSON.stringify(emissions)).not.toContain("REMOTE");
	});

	it("gives an expiring watch one final poll before timing out", async () => {
		const request = vi.fn(async (path: string) => {
			if (path === "repos/issues/search") return result([]);
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await subject.arm({
			target: "review_requests",
			pollIntervalMs: 100,
			timeoutMs: 100,
		});

		await vi.advanceTimersByTimeAsync(100);

		expect(emissions[0]).toMatchObject({ kind: "timed-out" });
		expect(subject.list()[0]).toMatchObject({ state: "timed-out" });
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("SourceWatchManager server degradation", () => {
	it("keeps waking from healthy servers while another server is degraded", async () => {
		let communityDown = false;
		let workHasItem = false;
		const workRequest = vi.fn(async (path: string) => {
			if (path === "repos/issues/search")
				return result(workHasItem ? [reviewIssue(31)] : []);
			throw new Error(`unexpected path ${path}`);
		});
		const communityRequest = vi.fn(async (path: string) => {
			if (path === "repos/issues/search") {
				if (communityDown)
					throw new ForgejoError("REMOTE NETWORK BODY", {
						server: "community",
						code: "network",
					});
				return result([]);
			}
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager(
			(server) =>
				fakeClient(
					server === "work" ? workRequest : communityRequest,
					server as ServerAlias,
				),
			["work", "community"],
		);
		await subject.arm({
			target: "review_requests",
			servers: ["work", "community"],
			pollIntervalMs: 100,
		});

		communityDown = true;
		workHasItem = true;
		await vi.advanceTimersByTimeAsync(100);

		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(emissions[0].events[0]).toMatchObject({
			reference: "work:acme/app!31",
		});
		expect(subject.list()[0]).toMatchObject({
			state: "matched",
			degradedServers: ["community"],
			lastError: { code: "network" },
		});
	});

	it("absorbs a degraded-at-arm server's items silently on recovery", async () => {
		let communityDown = true;
		let communityItems: ForgejoIssue[] = [reviewIssue(40)];
		const workRequest = vi.fn(async (path: string) => {
			if (path === "repos/issues/search") return result([]);
			throw new Error(`unexpected path ${path}`);
		});
		const communityRequest = vi.fn(async (path: string) => {
			if (path === "repos/issues/search") {
				if (communityDown)
					throw new ForgejoError("REMOTE NETWORK BODY", {
						server: "community",
						code: "network",
					});
				return result(communityItems);
			}
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager(
			(server) =>
				fakeClient(
					server === "work" ? workRequest : communityRequest,
					server as ServerAlias,
				),
			["work", "community"],
		);
		const armed = await subject.arm({
			target: "review_requests",
			servers: ["work", "community"],
			pollIntervalMs: 100,
		});
		expect(armed.degradedServers).toEqual(["community"]);

		communityDown = false;
		await vi.advanceTimersByTimeAsync(100);
		expect(emissions).toHaveLength(0);
		expect(subject.list()[0]).toMatchObject({ state: "active" });
		expect(subject.list()[0]?.degradedServers).toBeUndefined();

		const absorbed = communityItems[0] as ForgejoIssue;
		communityItems = [absorbed, reviewIssue(41)];
		await vi.advanceTimersByTimeAsync(100);
		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(emissions[0].events.map((event) => event.reference)).toEqual([
			"community:acme/app!41",
		]);
	});

	it("backs off only when every server is degraded", async () => {
		let allDown = false;
		const request = vi.fn(async (path: string) => {
			if (path === "repos/issues/search") {
				if (allDown)
					throw new ForgejoError("REMOTE NETWORK BODY", {
						server: "work",
						code: "network",
					});
				return result([]);
			}
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject } = manager((server) =>
			fakeClient(request, server as ServerAlias),
		);
		await subject.arm({ target: "review_requests", pollIntervalMs: 100 });

		allDown = true;
		await vi.advanceTimersByTimeAsync(100);
		expect(subject.list()[0]).toMatchObject({
			state: "active",
			failures: 1,
			lastError: { code: "network" },
		});
	});

	it("delivers a healthy-server match on the final expiry poll despite a degraded peer", async () => {
		let communityDown = false;
		let workHasItem = false;
		const workRequest = vi.fn(async (path: string) => {
			if (path === "repos/issues/search")
				return result(workHasItem ? [reviewIssue(55)] : []);
			throw new Error(`unexpected path ${path}`);
		});
		const communityRequest = vi.fn(async (path: string) => {
			if (path === "repos/issues/search") {
				if (communityDown)
					throw new ForgejoError("REMOTE NETWORK BODY", {
						server: "community",
						code: "network",
					});
				return result([]);
			}
			throw new Error(`unexpected path ${path}`);
		});
		const { manager: subject, emissions } = manager(
			(server) =>
				fakeClient(
					server === "work" ? workRequest : communityRequest,
					server as ServerAlias,
				),
			["work", "community"],
		);
		await subject.arm({
			target: "review_requests",
			servers: ["work", "community"],
			pollIntervalMs: 100,
			timeoutMs: 100,
		});

		communityDown = true;
		workHasItem = true;
		await vi.advanceTimersByTimeAsync(100);

		if (emissions[0]?.kind !== "matched") throw new Error("expected match");
		expect(subject.list()[0]).toMatchObject({ state: "matched" });
	});
});
