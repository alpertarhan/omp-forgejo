import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ForgejoClient } from "../src/client.js";
import type { ForgejoRuntime } from "../src/runtime.js";
import type { ResourceRef } from "../src/types.js";
import { registerIssueTool } from "../src/tools/issue.js";
import { registerPullTool } from "../src/tools/pull.js";

interface CapturedTool {
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<unknown>;
}

type ToolRegistrar = (
	api: ExtensionAPI,
	runtimeProvider: () => ForgejoRuntime,
) => void;

function captureTool(
	register: ToolRegistrar,
	runtime: ForgejoRuntime,
): CapturedTool {
	let captured: CapturedTool | undefined;
	const api = {
		registerTool(definition: CapturedTool) {
			captured = definition;
		},
	} as unknown as ExtensionAPI;
	register(api, () => runtime);
	if (!captured) throw new Error("tool was not registered");
	return captured;
}

function issue(index: number, overrides: Record<string, unknown> = {}) {
	return {
		id: index,
		number: index,
		title: `REMOTE ISSUE TITLE ${index}`,
		state: "open",
		body: `REMOTE BODY ${index}\nsecond line`,
		updated_at: "2026-08-12T10:00:00Z",
		comments: 3,
		user: { id: 1, login: "bob" },
		labels: [],
		...overrides,
	};
}

function pull(index: number, overrides: Record<string, unknown> = {}) {
	return {
		id: index,
		number: index,
		title: `REMOTE PULL TITLE ${index}`,
		state: "open",
		body: `REMOTE PULL BODY ${index}`,
		updated_at: "2026-08-12T10:00:00Z",
		draft: false,
		merged: false,
		user: { id: 1, login: "bob" },
		head: { ref: "feature", sha: `head-${index}` },
		base: { ref: "main", sha: "base-sha" },
		...overrides,
	};
}

function makeFixture(kind: "issue" | "pull") {
	const request = vi.fn(
		async (
			path: string,
			options?: { method?: string; body?: Record<string, unknown> },
		) => {
			if (options?.method === "POST" && path.endsWith("/pulls"))
				return {
					data: pull(31, { title: String(options.body?.title ?? "") }),
					status: 201,
					headers: new Headers(),
				};
			if (options?.method === "PATCH" && path.endsWith("/issues/9"))
				return {
					data: issue(9, {
						state: String(options.body?.state ?? "open"),
						title: String(options.body?.title ?? "REMOTE ISSUE TITLE 9"),
					}),
					status: 200,
					headers: new Headers(),
				};
			if (options?.method === "PATCH" && path.endsWith("/pulls/9"))
				return {
					data: pull(9, {
						state: String(options.body?.state ?? "open"),
						title: String(options.body?.title ?? "REMOTE PULL TITLE 9"),
					}),
					status: 200,
					headers: new Headers(),
				};
			if (path.endsWith("/issues/9") || path.endsWith("/pulls/9"))
				return {
					data:
						kind === "issue"
							? issue(9)
							: pull(9, { state: "closed", merged: true }),
					status: 200,
					headers: new Headers(),
				};
			throw new Error(`unexpected path ${path}`);
		},
	);
	const refresh = vi.fn(async () => undefined);
	const runtime = {
		sessionMutationApprovals: new Set<string>(),
		globalConfigPath: ".test-no-forgejo-config.json",
		resolveRepo: () => ({ server: "work", owner: "acme", repo: "app" }),
		resolveResource: (
			input: { ref?: string },
			resolvedKind: string,
		): ResourceRef => ({
			server: "work",
			owner: "acme",
			repo: "app",
			kind: resolvedKind === kind ? kind : (resolvedKind as "issue" | "pull"),
			index: Number(input.ref?.match(/(\d+)$/)?.[1] ?? 9),
		}),
		client: () => ({ request }) as unknown as ForgejoClient,
		dashboard: { refresh, refreshIfObserved: refresh },
	} as unknown as ForgejoRuntime;
	return { runtime, request, refresh };
}

const signal = new AbortController().signal;
const noUi = { hasUI: false } as ExtensionContext;

function toolResultOf(value: unknown): { content: string; data: unknown } {
	const result = value as {
		content: Array<{ type: string; text: string }>;
		details?: { data?: unknown };
	};
	const text = result.content.find((part) => part.type === "text")?.text ?? "";
	return { content: text, data: result.details?.data };
}

describe("forgejo_issue refs[] batch operations", () => {
	it("batch get renders one compact block per issue and survives a failed ref", async () => {
		const { runtime, request } = makeFixture("issue");
		const tool = captureTool(registerIssueTool, runtime);
		const result = toolResultOf(
			await tool.execute(
				"t1",
				{ action: "get", refs: ["work:acme/app#9", "work:acme/app#10"] },
				signal,
				undefined,
				noUi,
			),
		);
		expect(result.content).toContain("Issues (2):");
		expect(result.content).toContain(
			"- work:acme/app#9 [open] REMOTE ISSUE TITLE 9 — @bob, 3 comments",
		);
		expect(result.content).toContain("REMOTE BODY 9 second line");
		expect(result.content).toContain("- work:acme/app#10 [error]");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("batch update applies one patch to every ref and rejects empty patches", async () => {
		const { runtime, request } = makeFixture("issue");
		const tool = captureTool(registerIssueTool, runtime);
		await expect(
			tool.execute(
				"t1",
				{ action: "update", refs: ["work:acme/app#9"] },
				signal,
				undefined,
				noUi,
			),
		).rejects.toThrow("update requires title, body, or state");
		const result = toolResultOf(
			await tool.execute(
				"t2",
				{ action: "update", refs: ["work:acme/app#9"], state: "closed" },
				signal,
				undefined,
				noUi,
			),
		);
		expect(result.content).toContain("Updated 1 issues:");
		expect(request).toHaveBeenCalledWith(
			"repos/acme/app/issues/9",
			expect.objectContaining({
				method: "PATCH",
				body: { state: "closed" },
			}),
		);
	});

	it("rejects refs[] outside get, update, close, and reopen", async () => {
		const { runtime } = makeFixture("issue");
		const tool = captureTool(registerIssueTool, runtime);
		await expect(
			tool.execute(
				"t1",
				{ action: "timeline", refs: ["work:acme/app#9"] },
				signal,
				undefined,
				noUi,
			),
		).rejects.toThrow("refs[] supports get, update, close, and reopen");
	});
});

describe("forgejo_pull refs[] and prs[] batch operations", () => {
	it("batch get includes merged and draft flags with branch targets", async () => {
		const { runtime } = makeFixture("pull");
		const tool = captureTool(registerPullTool, runtime);
		const result = toolResultOf(
			await tool.execute(
				"t1",
				{ action: "get", refs: ["work:acme/app!9"] },
				signal,
				undefined,
				noUi,
			),
		);
		expect(result.content).toContain(
			"- work:acme/app!9 [closed,merged] REMOTE PULL TITLE 9 — feature→main",
		);
	});

	it("batch create posts every pr and reports per-item outcomes", async () => {
		const { runtime, request, refresh } = makeFixture("pull");
		const tool = captureTool(registerPullTool, runtime);
		const result = toolResultOf(
			await tool.execute(
				"t1",
				{
					action: "create",
					prs: [
						{ head: "feat-a", base: "main", title: "First change" },
						{
							head: "feat-b",
							base: "main",
							title: "Second change",
							body: "Details",
						},
					],
				},
				signal,
				undefined,
				noUi,
			),
		);
		expect(result.content).toContain("Created pull requests (2):");
		expect(result.content).toContain("- Created work:acme/app!31 [open]");
		expect(request).toHaveBeenCalledWith(
			"repos/acme/app/pulls",
			expect.objectContaining({
				method: "POST",
				body: {
					title: "Second change",
					head: "feat-b",
					base: "main",
					body: "Details",
				},
			}),
		);
		expect(refresh).toHaveBeenCalled();
	});

	it("rejects prs entries missing required fields before creating anything", async () => {
		const { runtime, request } = makeFixture("pull");
		const tool = captureTool(registerPullTool, runtime);
		await expect(
			tool.execute(
				"t1",
				{
					action: "create",
					prs: [{ head: "feat-a", base: "main" }],
				},
				signal,
				undefined,
				noUi,
			),
		).rejects.toThrow("each prs[] entry requires title, head, and base");
		expect(request).not.toHaveBeenCalled();
	});

	it("batch close confirms once with every ref enumerated", async () => {
		const { runtime, request } = makeFixture("pull");
		const tool = captureTool(registerPullTool, runtime);
		const select = vi.fn(async () => "Allow once");
		const ctx = {
			hasUI: true,
			ui: { select },
		} as unknown as ExtensionContext;
		await tool.execute(
			"t1",
			{ action: "close", refs: ["work:acme/app!9"] },
			signal,
			undefined,
			ctx,
		);
		expect(select).toHaveBeenCalledTimes(1);
		expect(String(select.mock.calls[0])).toContain("work:acme/app!9");
		expect(request).toHaveBeenCalledWith(
			"repos/acme/app/pulls/9",
			expect.objectContaining({ method: "PATCH", body: { state: "closed" } }),
		);
	});
});
