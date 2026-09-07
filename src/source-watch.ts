import { listActionRuns } from "./actions.js";
import { apiPath, ForgejoError, type ForgejoClient } from "./client.js";
import { queryAttentionItems, type AttentionTarget } from "./attention.js";
import { formatResourceRef } from "./refs.js";
import { WatchScheduler } from "./watch-scheduler.js";
import type { WatchErrorMetadata } from "./watch.js";
import type {
	DashboardItem,
	ForgejoActionRun,
	ForgejoPullRequest,
	ResourceRef,
	ServerAlias,
} from "./types.js";

export type SourceWatchAttention = "turn" | "context";
export type SourceWatchState =
	| "active"
	| "matched"
	| "stopped"
	| "timed-out"
	| "failed";

export interface SourceWatchEvent {
	type: string;
	reference?: string;
	runId?: number;
	workflow?: string;
	status?: string;
	title?: string;
	url?: string;
	updatedAt?: string;
}

export interface SourceWatch {
	id: string;
	source: "ci" | "attention";
	reference: string;
	target?: AttentionTarget;
	servers?: ServerAlias[];
	attention: SourceWatchAttention;
	note?: string;
	state: SourceWatchState;
	createdAt: string;
	pollIntervalMs: number;
	timeoutMs?: number;
	nextPollAt?: string;
	expiresAt?: string;
	failures: number;
	lastError?: WatchErrorMetadata;
	deliveryFailed?: boolean;
	matchedAt?: string;
	matchedEvents?: SourceWatchEvent[];
	matchedTotal?: number;
	degradedServers?: string[];
}

export type SourceWatchEmission =
	| (SourceWatchEmissionBase & {
			kind: "matched";
			events: SourceWatchEvent[];
			totalCount: number;
	  })
	| (SourceWatchEmissionBase & { kind: "timed-out" })
	| (SourceWatchEmissionBase & {
			kind: "failed";
			error: WatchErrorMetadata;
	  });

interface SourceWatchEmissionBase {
	watchId: string;
	source: "ci" | "attention";
	reference: string;
	target?: AttentionTarget;
	servers?: ServerAlias[];
	attention: SourceWatchAttention;
	note?: string;
}

export interface ArmCIWatchOptions {
	ref: ResourceRef;
	pollIntervalMs?: number;
	timeoutMs?: number;
	attention?: SourceWatchAttention;
	note?: string;
	signal?: AbortSignal;
}

export interface ArmAttentionWatchOptions {
	target: AttentionTarget;
	servers?: ServerAlias[];
	pollIntervalMs?: number;
	timeoutMs?: number;
	attention?: SourceWatchAttention;
	note?: string;
	signal?: AbortSignal;
}

type ArmOptions = ArmCIWatchOptions | ArmAttentionWatchOptions;

interface PollOutcome {
	events: SourceWatchEvent[];
	degradedError?: unknown;
}

interface ActiveSourceWatch extends SourceWatch {
	key: string;
	nextPollTime?: number;
	expiresTime?: number;
	expiryPolled: boolean;
	inFlight: boolean;
	controller: AbortController;
	previewLimit: number;
	// CI watches
	client?: ForgejoClient;
	currentPath?: string;
	repo?: { server: string; owner: string; repo: string };
	lastHeadSha?: string;
	runStatuses: Map<number, string>;
	// Attention watches
	targetServers?: ServerAlias[];
	seenKeys: Set<string>;
	degraded: Set<ServerAlias>;
	unbased: Set<ServerAlias>;
}

const DEFAULT_POLL_MS = 60_000;
const MAX_POLL_MS = 60 * 60_000;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_ACTIVE = 20;
const MAX_HISTORY = 50;
const MAX_EMITTED_EVENTS = 20;
const DEFAULT_PREVIEW_LIMIT = 25;
const MAX_RUNS_PER_POLL = 50;
const MAX_RUN_PAGES = 3;
const TERMINAL_RUN_STATUSES = new Set([
	"success",
	"failure",
	"cancelled",
	"skipped",
]);

const SAFE_TOKEN = /^[A-Za-z0-9._:@\/#-]{1,128}$/;

function safeToken(value: string | undefined): string | undefined {
	return value !== undefined && SAFE_TOKEN.test(value) ? value : undefined;
}

function safeTimestamp(value: string | undefined): string | undefined {
	return value !== undefined && Number.isFinite(Date.parse(value))
		? new Date(value).toISOString()
		: undefined;
}

function safeTitle(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return (
		value
			.replace(/[\u0000-\u001f\u007f]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 120) || undefined
	);
}

function safeUrl(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
			return undefined;
		return parsed.href.slice(0, 500);
	} catch {
		return undefined;
	}
}

function normalizedNote(note: string | undefined): string | undefined {
	if (note === undefined) return undefined;
	if (note.length > 500) throw new Error("note must be at most 500 characters");
	return note
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function positive(
	value: number | undefined,
	name: string,
	maximum: number,
	fallback?: number,
): number {
	const result = value ?? fallback;
	if (
		result === undefined ||
		!Number.isSafeInteger(result) ||
		result < 1 ||
		result > maximum
	)
		throw new Error(`${name} must be an integer from 1 to ${maximum}`);
	return result;
}

function safeError(error: unknown): WatchErrorMetadata {
	if (!(error instanceof ForgejoError)) return { code: "internal" };
	return {
		code: error.code,
		...(error.status === undefined ? {} : { status: error.status }),
	};
}

function isTransient(error: unknown): boolean {
	return (
		error instanceof ForgejoError &&
		(error.code === "network" ||
			error.code === "rate-limit" ||
			(error.status !== undefined && error.status >= 500))
	);
}

function attentionEvent(item: DashboardItem): SourceWatchEvent {
	const event: SourceWatchEvent = {
		type: item.kind === "review" ? "review-request" : "notification",
	};
	if (item.index !== undefined && item.resourceKind !== "repository") {
		const ref: ResourceRef = {
			server: item.server,
			owner: item.owner,
			repo: item.repo,
			kind: item.resourceKind,
			index: item.index,
		};
		event.reference = formatResourceRef(ref);
	} else {
		event.reference = `${item.server}:${item.owner}/${item.repo}`;
	}
	const title = safeTitle(item.title);
	if (title !== undefined) event.title = title;
	const url = safeUrl(item.webUrl);
	if (url !== undefined) event.url = url;
	const updatedAt = safeTimestamp(item.updatedAt);
	if (updatedAt !== undefined) event.updatedAt = updatedAt;
	return event;
}

function ciEvent(
	reference: string,
	run: ForgejoActionRun,
): SourceWatchEvent {
	const event: SourceWatchEvent = {
		type: `ci-${run.status}`,
		reference,
		runId: run.id,
	};
	const workflow = safeToken(run.workflow_id);
	if (workflow !== undefined) event.workflow = workflow;
	event.status = run.status;
	const url = safeUrl(run.html_url);
	if (url !== undefined) event.url = url;
	const updatedAt = safeTimestamp(run.stopped || run.updated);
	if (updatedAt !== undefined) event.updatedAt = updatedAt;
	return event;
}

async function fetchRunPages(
	client: ForgejoClient,
	repo: { server: string; owner: string; repo: string },
	headSha: string,
	signal: AbortSignal | undefined,
): Promise<ForgejoActionRun[]> {
	const runs: ForgejoActionRun[] = [];
	for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
		const result = await listActionRuns(
			client,
			repo,
			{ headSha, page, limit: MAX_RUNS_PER_POLL },
			signal,
		);
		runs.push(...result.runs);
		if (result.runs.length < MAX_RUNS_PER_POLL) break;
	}
	return runs;
}

export class SourceWatchManager {
	private readonly watches = new Map<string, ActiveSourceWatch>();
	private nextId = 1;
	private readonly clientFor: (server: string) => ForgejoClient;
	private readonly aliasesFor: () => ServerAlias[];
	private readonly emit: (emission: SourceWatchEmission) => void;
	private readonly scheduler: WatchScheduler<ActiveSourceWatch>;

	constructor(
		clientFor: (server: string) => ForgejoClient,
		aliasesFor: () => ServerAlias[],
		emit: (emission: SourceWatchEmission) => void,
	) {
		this.clientFor = clientFor;
		this.aliasesFor = aliasesFor;
		this.emit = emit;
		this.scheduler = new WatchScheduler(
			() => this.watches.values(),
			(watch) => this.poll(watch),
			(watch) => this.finishTimeout(watch),
		);
	}

	async arm(options: ArmOptions): Promise<SourceWatch> {
		if (this.scheduler.closed) throw new Error("watch manager is closed");
		if ("target" in options) return this.armAttention(options);
		return this.armCI(options);
	}

	list(): SourceWatch[] {
		return [...this.watches.values()].map((watch) => this.publicInfo(watch));
	}

	stop(id: string): boolean {
		const watch = this.watches.get(id);
		if (!watch || watch.state !== "active") return false;
		watch.state = "stopped";
		delete watch.nextPollTime;
		delete watch.nextPollAt;
		watch.seenKeys.clear();
		watch.runStatuses.clear();
		// degraded/unbased sets stay for list() reporting; they are bounded by
		// the server count and die with the watch.
		watch.controller.abort();
		this.prune();
		this.scheduler.schedule();
		return true;
	}

	close(): void {
		this.scheduler.close();
		for (const watch of this.watches.values()) {
			if (watch.state === "active") watch.state = "stopped";
			watch.controller.abort();
			delete watch.nextPollTime;
			delete watch.nextPollAt;
		}
		this.prune();
	}

	private async armCI(options: ArmCIWatchOptions): Promise<SourceWatch> {
		if (options.ref.kind !== "pull")
			throw new Error("CI watches require a pull-request reference");
		const reference = formatResourceRef(options.ref);
		const settings = this.normalizedSettings(options);
		const key = JSON.stringify({ source: "ci", reference, ...settings });
		const duplicate = this.activeByKey(key);
		if (duplicate) return this.publicInfo(duplicate);
		this.assertCapacity();

		const client = this.clientFor(options.ref.server);
		const currentPath = apiPath(
			"repos",
			options.ref.owner,
			options.ref.repo,
			"pulls",
			options.ref.index,
		);
		const requestOptions =
			options.signal === undefined ? {} : { signal: options.signal };
		const current = await client.request<ForgejoPullRequest>(
			currentPath,
			requestOptions,
		);
		const headSha = current.data.head?.sha ?? "";
		const runStatuses = new Map<number, string>();
		if (headSha) {
			for (const run of await fetchRunPages(
				client,
				{
					server: options.ref.server,
					owner: options.ref.owner,
					repo: options.ref.repo,
				},
				headSha,
				options.signal,
			))
				runStatuses.set(run.id, run.status);
		}
		if (this.scheduler.closed)
			throw new Error("watch manager is closed");
		const raced = this.activeByKey(key);
		if (raced) return this.publicInfo(raced);
		this.assertCapacity();

		const watch = this.createWatch({
			source: "ci",
			reference,
			key,
			settings,
			client,
			currentPath,
			repo: {
				server: options.ref.server,
				owner: options.ref.owner,
				repo: options.ref.repo,
			},
			lastHeadSha: headSha,
			runStatuses,
		});
		this.watches.set(watch.id, watch);
		this.scheduler.schedule();
		return this.publicInfo(watch);
	}

	private async armAttention(
		options: ArmAttentionWatchOptions,
	): Promise<SourceWatch> {
		if (options.servers !== undefined) {
			if (options.servers.length === 0)
				throw new Error("servers must list at least one server alias");
			for (const alias of options.servers)
				if (!this.aliasesFor().includes(alias))
					throw new Error(`unknown server '${alias}'`);
		}
		const servers = options.servers ?? this.aliasesFor();
		if (servers.length === 0)
			throw new Error("no Forgejo servers are configured");
		const settings = this.normalizedSettings(options);
		const key = JSON.stringify({
			source: "attention",
			target: options.target,
			servers: [...servers].sort(),
			...settings,
		});
		const duplicate = this.activeByKey(key);
		if (duplicate) return this.publicInfo(duplicate);
		this.assertCapacity();

		const settled = await Promise.allSettled(
			servers.map((alias) =>
				queryAttentionItems(
					this.clientFor(alias),
					options.target,
					DEFAULT_PREVIEW_LIMIT,
					options.signal,
				),
			),
		);
		if (this.scheduler.closed)
			throw new Error("watch manager is closed");
		if (options.signal?.aborted) throw new Error("watch arm was aborted");
		if (settled.every((result) => result.status === "rejected"))
			throw (settled[0] as PromiseRejectedResult).reason;
		const baselineItems = settled.flatMap((result) =>
			result.status === "fulfilled" ? result.value : [],
		);
		const unreachable = new Set(
			settled
				.map((result, index) =>
					result.status === "rejected" ? servers[index] : undefined,
				)
				.filter((alias): alias is ServerAlias => alias !== undefined),
		);
		const raced = this.activeByKey(key);
		if (raced) return this.publicInfo(raced);
		this.assertCapacity();

		const seenKeys = new Set(baselineItems.map((item) => item.key));
		const watch = this.createWatch({
			source: "attention",
			reference: `${options.target.replace("_", " ")} on ${[...servers].sort().join(", ")}`,
			key,
			settings,
			target: options.target,
			targetServers: [...servers],
			seenKeys,
			degraded: unreachable,
			unbased: new Set(unreachable),
		});
		this.watches.set(watch.id, watch);
		this.scheduler.schedule();
		return this.publicInfo(watch);
	}

	private normalizedSettings(options: ArmOptions): {
		attention: SourceWatchAttention;
		note?: string;
		pollIntervalMs: number;
		timeoutMs?: number;
	} {
		const attention = options.attention ?? "turn";
		if (attention !== "turn" && attention !== "context")
			throw new Error(`unsupported attention '${String(attention)}'`);
		const note = normalizedNote(options.note);
		const pollIntervalMs = positive(
			options.pollIntervalMs,
			"pollIntervalMs",
			MAX_POLL_MS,
			DEFAULT_POLL_MS,
		);
		const timeoutMs =
			options.timeoutMs === undefined
				? undefined
				: positive(options.timeoutMs, "timeoutMs", MAX_TIMEOUT_MS);
		return {
			attention,
			pollIntervalMs,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			...(note === undefined ? {} : { note }),
		};
	}

	private createWatch(
		details: {
			source: "ci" | "attention";
			reference: string;
			key: string;
			settings: ReturnType<SourceWatchManager["normalizedSettings"]>;
		} & Partial<ActiveSourceWatch>,
	): ActiveSourceWatch {
		const { settings } = details;
		const now = Date.now();
		const watch: ActiveSourceWatch = {
			id: `srcwatch-${this.nextId++}`,
			key: details.key,
			source: details.source,
			reference: details.reference,
			attention: settings.attention,
			...(settings.note === undefined ? {} : { note: settings.note }),
			state: "active",
			createdAt: new Date().toISOString(),
			pollIntervalMs: settings.pollIntervalMs,
			...(settings.timeoutMs === undefined
				? {}
				: {
						timeoutMs: settings.timeoutMs,
						expiresTime: now + settings.timeoutMs,
						expiresAt: new Date(now + settings.timeoutMs).toISOString(),
					}),
			nextPollTime: now + settings.pollIntervalMs,
			nextPollAt: new Date(now + settings.pollIntervalMs).toISOString(),
			failures: 0,
			expiryPolled: false,
			inFlight: false,
			controller: new AbortController(),
			previewLimit: DEFAULT_PREVIEW_LIMIT,
			...(details.client === undefined ? {} : { client: details.client }),
			...(details.currentPath === undefined
				? {}
				: { currentPath: details.currentPath }),
			...(details.repo === undefined ? {} : { repo: details.repo }),
			...(details.lastHeadSha === undefined
				? {}
				: { lastHeadSha: details.lastHeadSha }),
			runStatuses: details.runStatuses ?? new Map(),
			seenKeys: details.seenKeys ?? new Set(),
			degraded: details.degraded ?? new Set(),
			unbased: details.unbased ?? new Set(),
			...(details.target === undefined ? {} : { target: details.target }),
			...(details.targetServers === undefined
				? {}
				: { targetServers: details.targetServers, servers: [...details.targetServers] }),
		};
		return watch;
	}

	private activeByKey(key: string): ActiveSourceWatch | undefined {
		return [...this.watches.values()].find(
			(watch) => watch.state === "active" && watch.key === key,
		);
	}

	private activeCount(): number {
		return [...this.watches.values()].filter((watch) => watch.state === "active")
			.length;
	}

	private assertCapacity(): void {
		if (this.activeCount() >= MAX_ACTIVE)
			throw new Error(`at most ${MAX_ACTIVE} active source watches are allowed`);
	}

	private async poll(watch: ActiveSourceWatch): Promise<void> {
		const pollController = new AbortController();
		const abortPoll = (): void =>
			pollController.abort(watch.controller.signal.reason);
		if (watch.controller.signal.aborted) abortPoll();
		else
			watch.controller.signal.addEventListener("abort", abortPoll, {
				once: true,
			});
		try {
			const outcome =
				watch.source === "ci"
					? await this.pollCI(watch, pollController.signal)
					: await this.pollAttention(watch, pollController.signal);
			if (watch.state !== "active") return;
			watch.failures = 0;
			if (outcome.degradedError !== undefined)
				watch.lastError = safeError(outcome.degradedError);
			else delete watch.lastError;
			if (outcome.events.length > 0) this.finishMatched(watch, outcome.events);
			else if (this.expired(watch)) this.finishTimeout(watch);
			else this.nextPoll(watch, watch.pollIntervalMs);
		} catch (error) {
			if (watch.state !== "active" || watch.controller.signal.aborted) return;
			const metadata = safeError(error);
			watch.lastError = metadata;
			if (this.expired(watch)) this.finishTimeout(watch);
			else if (!isTransient(error)) this.finishFailure(watch, metadata);
			else {
				watch.failures += 1;
				this.nextPoll(
					watch,
					Math.min(
						watch.pollIntervalMs * 2 ** watch.failures,
						MAX_BACKOFF_MS,
					),
				);
			}
		} finally {
			watch.controller.signal.removeEventListener("abort", abortPoll);
			pollController.abort();
			watch.inFlight = false;
			this.scheduler.schedule();
		}
	}

	private async pollCI(
		watch: ActiveSourceWatch,
		signal: AbortSignal,
	): Promise<PollOutcome> {
		const current = await watch.client!.request<ForgejoPullRequest>(
			watch.currentPath!,
			{ signal },
		);
		const headSha = current.data.head?.sha ?? "";
		if (!headSha) return { events: [] };
		if (headSha !== watch.lastHeadSha) {
			watch.lastHeadSha = headSha;
			watch.runStatuses.clear();
		}
		const runs = await fetchRunPages(
			watch.client!,
			watch.repo!,
			headSha,
			signal,
		);
		const events: SourceWatchEvent[] = [];
		for (const run of runs) {
			const previous = watch.runStatuses.get(run.id);
			if (previous === run.status) continue;
			watch.runStatuses.set(run.id, run.status);
			// A run first observed as terminal started after the baseline and
			// already finished; a known run reports when it becomes terminal.
			const becameTerminal =
				TERMINAL_RUN_STATUSES.has(run.status) &&
				(previous === undefined || !TERMINAL_RUN_STATUSES.has(previous));
			if (becameTerminal) {
				events.push(ciEvent(watch.reference, run));
			}
		}
		return { events };
	}

	private async pollAttention(
		watch: ActiveSourceWatch,
		signal: AbortSignal,
	): Promise<PollOutcome> {
		const servers = watch.targetServers ?? [];
		const settled = await Promise.allSettled(
			servers.map((alias) =>
				queryAttentionItems(
					this.clientFor(alias),
					watch.target!,
					watch.previewLimit,
					signal,
				),
			),
		);
		const events: SourceWatchEvent[] = [];
		let degradedError: unknown;
		let sawDegraded = false;
		let degradedCount = 0;
		settled.forEach((result, index) => {
			const alias = servers[index];
			if (alias === undefined) return;
			if (result.status === "rejected") {
				degradedCount += 1;
				if (!sawDegraded) {
					sawDegraded = true;
					degradedError = result.reason;
				}
				watch.degraded.add(alias);
				return;
			}
			watch.degraded.delete(alias);
			if (watch.unbased.has(alias)) {
				// First success after being unreachable at arm: absorb the
				// server's current items as a silent baseline so recovery
				// cannot flood the agent with pre-arm review requests.
				watch.unbased.delete(alias);
				for (const item of result.value) watch.seenKeys.add(item.key);
				return;
			}
			for (const item of result.value) {
				if (watch.seenKeys.has(item.key)) continue;
				watch.seenKeys.add(item.key);
				events.push(attentionEvent(item));
			}
		});
		if (degradedCount === settled.length) throw degradedError;
		return {
			events,
			...(sawDegraded ? { degradedError } : {}),
		};
	}

	private expired(watch: ActiveSourceWatch): boolean {
		return watch.expiresTime !== undefined && watch.expiresTime <= Date.now();
	}

	private nextPoll(watch: ActiveSourceWatch, delay: number): void {
		const next = Date.now() + delay;
		watch.nextPollTime = next;
		watch.nextPollAt = new Date(next).toISOString();
	}

	private finishMatched(
		watch: ActiveSourceWatch,
		events: SourceWatchEvent[],
	): void {
		watch.state = "matched";
		watch.matchedAt = new Date().toISOString();
		watch.matchedEvents = events.slice(0, MAX_EMITTED_EVENTS);
		watch.matchedTotal = events.length;
		this.finish(watch);
		this.deliver(
			{
				watchId: watch.id,
				source: watch.source,
				reference: watch.reference,
				...(watch.target === undefined ? {} : { target: watch.target }),
				...(watch.targetServers === undefined
					? {}
					: { servers: [...watch.targetServers].sort() }),
				attention: watch.attention,
				...(watch.note === undefined ? {} : { note: watch.note }),
				kind: "matched",
				events: watch.matchedEvents,
				totalCount: events.length,
			},
			watch,
		);
	}

	private finishTimeout(watch: ActiveSourceWatch): void {
		watch.state = "timed-out";
		this.finish(watch);
		this.deliver(
			{
				watchId: watch.id,
				source: watch.source,
				reference: watch.reference,
				...(watch.target === undefined ? {} : { target: watch.target }),
				...(watch.targetServers === undefined
					? {}
					: { servers: [...watch.targetServers].sort() }),
				attention: watch.attention,
				...(watch.note === undefined ? {} : { note: watch.note }),
				kind: "timed-out",
			},
			watch,
		);
	}

	private finishFailure(
		watch: ActiveSourceWatch,
		error: WatchErrorMetadata,
	): void {
		watch.state = "failed";
		watch.lastError = error;
		this.finish(watch);
		this.deliver(
			{
				watchId: watch.id,
				source: watch.source,
				reference: watch.reference,
				...(watch.target === undefined ? {} : { target: watch.target }),
				...(watch.targetServers === undefined
					? {}
					: { servers: [...watch.targetServers].sort() }),
				attention: watch.attention,
				...(watch.note === undefined ? {} : { note: watch.note }),
				kind: "failed",
				error,
			},
			watch,
		);
	}

	private finish(watch: ActiveSourceWatch): void {
		delete watch.nextPollTime;
		delete watch.nextPollAt;
		watch.controller.abort();
		watch.seenKeys.clear();
		watch.runStatuses.clear();
		this.prune();
	}

	private deliver(
		emission: SourceWatchEmission,
		watch: ActiveSourceWatch,
	): void {
		try {
			this.emit(emission);
		} catch {
			watch.deliveryFailed = true;
		}
	}

	private prune(): void {
		const terminal = [...this.watches.values()].filter(
			(watch) => watch.state !== "active",
		);
		for (const watch of terminal.slice(
			0,
			Math.max(0, terminal.length - MAX_HISTORY),
		))
			this.watches.delete(watch.id);
	}

	private publicInfo(watch: ActiveSourceWatch): SourceWatch {
		const {
			id,
			source,
			reference,
			target,
			servers,
			attention,
			note,
			state,
			createdAt,
			pollIntervalMs,
			timeoutMs,
			nextPollAt,
			expiresAt,
			failures,
			lastError,
		deliveryFailed,
		degraded,
			matchedAt,
			matchedEvents,
			matchedTotal,
		} = watch;
		return {
			id,
			source,
			reference,
			attention,
			state,
			createdAt,
			pollIntervalMs,
			failures,
			...(target === undefined ? {} : { target }),
			...(servers === undefined ? {} : { servers: [...servers] }),
			...(note === undefined ? {} : { note }),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			...(nextPollAt === undefined ? {} : { nextPollAt }),
			...(expiresAt === undefined ? {} : { expiresAt }),
			...(lastError === undefined ? {} : { lastError }),
		...(deliveryFailed === undefined ? {} : { deliveryFailed }),
		...(degraded !== undefined && degraded.size > 0
			? { degradedServers: [...degraded].sort() }
			: {}),
			...(matchedAt === undefined ? {} : { matchedAt }),
			...(matchedEvents === undefined
				? {}
				: { matchedEvents: [...matchedEvents] }),
			...(matchedTotal === undefined ? {} : { matchedTotal }),
		};
	}
}
