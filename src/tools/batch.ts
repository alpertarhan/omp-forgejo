import { apiPath } from "../client.js";
import { parseResourceRef } from "../refs.js";
import type { ForgejoRuntime } from "../runtime.js";
import type {
	ForgejoIssue,
	ForgejoPullRequest,
	ResourceRef,
} from "../types.js";
import { boundModelText, toolResult } from "./common.js";

export const MAX_BATCH_REFS = 10;
const PREVIEW_BYTES = 240;

export interface BatchPullSpec {
	head: string;
	base: string;
	title: string;
	body?: string;
}

interface BatchItem {
	content: string;
	details: Record<string, unknown>;
}

function preview(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length === 0) return undefined;
	return boundModelText(normalized, PREVIEW_BYTES, "…").text;
}

function requestOptions(signal: AbortSignal | undefined): {
	signal?: AbortSignal;
} {
	return signal === undefined ? {} : { signal };
}

function resolveRefs(
	runtime: ForgejoRuntime,
	refs: readonly string[],
	kind: "issue" | "pull",
): ResourceRef[] {
	if (refs.length === 0)
		throw new Error("refs must list at least one qualified reference");
	return refs.map((raw) => {
		const parsed = parseResourceRef(raw);
		if (!parsed || parsed.kind !== kind)
			throw new Error(`invalid ${kind} reference '${raw}'`);
		return runtime.resolveResource({ ref: raw }, kind);
	});
}

async function runBatch(
	header: string,
	references: readonly string[],
	load: (reference: string, index: number) => Promise<BatchItem>,
	maxBytes: number,
): Promise<ReturnType<typeof toolResult>> {
	const items = await Promise.all(
		references.map(async (reference, index) => {
			try {
				return await load(reference, index);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				return {
					content: `- ${reference} [error] ${message}`,
					details: { reference, error: message },
				};
			}
		}),
	);
	const assembled = boundModelText(
		[header, ...items.map((item) => item.content)].join("\n"),
		maxBytes,
		"…",
	);
	const failures = items.filter((item) => item.details.error !== undefined)
		.length;
	return toolResult(assembled.text, {
		requested: references.length,
		failed: failures,
		items: items.map((item) => item.details),
		...(assembled.truncated ? { truncated: true } : {}),
	});
}

export async function batchGetIssues(
	runtime: ForgejoRuntime,
	refs: readonly string[],
	signal: AbortSignal | undefined,
	maxBytes: number,
): Promise<ReturnType<typeof toolResult>> {
	const resolved = resolveRefs(runtime, refs, "issue");
	return runBatch(`Issues (${refs.length}):`, refs, async (reference, index) => {
		const ref = resolved[index] as ResourceRef;
		const response = await runtime
			.client(ref.server)
			.request<ForgejoIssue>(
				apiPath("repos", ref.owner, ref.repo, "issues", ref.index),
				requestOptions(signal),
			);
		const issue = response.data;
		const body = preview(issue.body);
		return {
			content: [
				`- ${reference} [${issue.state}] ${issue.title} — @${issue.user?.login ?? "unknown"}, ${issue.comments ?? 0} comments, updated ${issue.updated_at}`,
				...(body === undefined ? [] : [`  ${body}`]),
			].join("\n"),
			details: {
				reference,
				number: issue.number,
				state: issue.state,
				title: issue.title,
				user: issue.user?.login,
				comments: issue.comments,
				labels: issue.labels?.map((label) => label.name) ?? [],
				updatedAt: issue.updated_at,
			},
		};
	}, maxBytes);
}

export async function batchGetPulls(
	runtime: ForgejoRuntime,
	refs: readonly string[],
	signal: AbortSignal | undefined,
	maxBytes: number,
): Promise<ReturnType<typeof toolResult>> {
	const resolved = resolveRefs(runtime, refs, "pull");
	return runBatch(`Pulls (${refs.length}):`, refs, async (reference, index) => {
		const ref = resolved[index] as ResourceRef;
		const response = await runtime
			.client(ref.server)
			.request<ForgejoPullRequest>(
				apiPath("repos", ref.owner, ref.repo, "pulls", ref.index),
				requestOptions(signal),
			);
		const pull = response.data;
		const flags = [
			pull.state,
			...(pull.merged ? ["merged"] : []),
			...(pull.draft ? ["draft"] : []),
		].join(",");
		const body = preview(pull.body);
		return {
			content: [
				`- ${reference} [${flags}] ${pull.title} — ${pull.head?.ref ?? "?"}→${pull.base?.ref ?? "?"}, @${pull.user?.login ?? "unknown"}, updated ${pull.updated_at}`,
				...(body === undefined ? [] : [`  ${body}`]),
			].join("\n"),
			details: {
				reference,
				number: pull.number,
				state: pull.state,
				title: pull.title,
				head: pull.head?.ref,
				base: pull.base?.ref,
				user: pull.user?.login,
				merged: pull.merged === true,
				draft: pull.draft === true,
				updatedAt: pull.updated_at,
			},
		};
	}, maxBytes);
}

export async function batchPatchIssues(
	runtime: ForgejoRuntime,
	refs: readonly string[],
	patch: Record<string, unknown>,
	options: { verb: string; requireState?: "open" | "closed" },
	signal: AbortSignal | undefined,
): Promise<ReturnType<typeof toolResult>> {
	const resolved = resolveRefs(runtime, refs, "issue");
	const result = await runBatch(
		`${options.verb} ${refs.length} issues:`,
		refs,
		async (reference, index) => {
			const ref = resolved[index] as ResourceRef;
			const response = await runtime
				.client(ref.server)
				.request<ForgejoIssue>(
					apiPath("repos", ref.owner, ref.repo, "issues", ref.index),
					{ method: "PATCH", body: patch, ...requestOptions(signal) },
				);
			if (
				options.requireState !== undefined &&
				response.data.state !== options.requireState
			)
				throw new Error(
					`Forgejo returned state '${response.data.state}' after requesting '${options.requireState}'`,
				);
			return {
				content: `- ${reference} [${response.data.state}] ${response.data.title}`,
				details: {
					reference,
					state: response.data.state,
					title: response.data.title,
					updatedAt: response.data.updated_at,
				},
			};
		},
		16_000,
	);
	return result;
}

export async function batchPatchPulls(
	runtime: ForgejoRuntime,
	refs: readonly string[],
	patch: Record<string, unknown>,
	options: { verb: string; requireState?: "open" | "closed" },
	signal: AbortSignal | undefined,
): Promise<ReturnType<typeof toolResult>> {
	const resolved = resolveRefs(runtime, refs, "pull");
	const result = await runBatch(
		`${options.verb} ${refs.length} pulls:`,
		refs,
		async (reference, index) => {
			const ref = resolved[index] as ResourceRef;
			const response = await runtime
				.client(ref.server)
				.request<ForgejoPullRequest>(
					apiPath("repos", ref.owner, ref.repo, "pulls", ref.index),
					{ method: "PATCH", body: patch, ...requestOptions(signal) },
				);
			if (
				options.requireState !== undefined &&
				response.data.state !== options.requireState
			)
				throw new Error(
					`Forgejo returned state '${response.data.state}' after requesting '${options.requireState}'`,
				);
			return {
				content: `- ${reference} [${response.data.state}] ${response.data.title}`,
				details: {
					reference,
					state: response.data.state,
					title: response.data.title,
					updatedAt: response.data.updated_at,
				},
			};
		},
		16_000,
	);
	return result;
}

export async function batchCreatePulls(
	runtime: ForgejoRuntime,
	repo: { server: string; owner: string; repo: string },
	prs: readonly BatchPullSpec[],
	signal: AbortSignal | undefined,
): Promise<ReturnType<typeof toolResult>> {
	for (const pr of prs) {
		if (!pr.title || !pr.head || !pr.base)
			throw new Error(
				"each prs[] entry requires title, head, and base (prefix the title with WIP: for a draft)",
			);
	}
	const client = runtime.client(repo.server);
	const items = await Promise.all(
		prs.map(async (pr) => {
			try {
				const response = await client.request<ForgejoPullRequest>(
					apiPath("repos", repo.owner, repo.repo, "pulls"),
					{
						method: "POST",
						body: {
							title: pr.title,
							head: pr.head,
							base: pr.base,
							body: pr.body ?? "",
						},
						...requestOptions(signal),
					},
				);
				const reference = `${repo.server}:${repo.owner}/${repo.repo}!${response.data.number}`;
				return {
					content: `- Created ${reference} [${response.data.state}] ${response.data.title}`,
					details: {
						reference,
						number: response.data.number,
						state: response.data.state,
						title: response.data.title,
						head: pr.head,
						base: pr.base,
					},
				};
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				return {
					content: `- ${pr.head}→${pr.base} [error] ${message}`,
					details: { head: pr.head, base: pr.base, title: pr.title, error: message },
				};
			}
		}),
	);
	const failures = items.filter((item) => item.details.error !== undefined)
		.length;
	const assembled = boundModelText(
		[`Created pull requests (${prs.length}):`, ...items.map((item) => item.content)].join(
			"\n",
		),
		16_000,
		"…",
	);
	return toolResult(assembled.text, {
		requested: prs.length,
		failed: failures,
		items: items.map((item) => item.details),
		...(assembled.truncated ? { truncated: true } : {}),
	});
}
