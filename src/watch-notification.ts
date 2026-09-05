import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatCanonicalRef, parseResourceRef } from "./refs.js";
import type {
	SourceWatchEmission,
	SourceWatchEvent,
} from "./source-watch.js";
import type { WatchEmission, WatchEventMetadata } from "./watch.js";

const SAFE_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9._:@\/#!-]{1,128}$/;

function safeToken(value: string | undefined, fallback: string): string {
	return value !== undefined && SAFE_TOKEN.test(value) ? value : fallback;
}

function safeTimestamp(value: string | undefined): string | undefined {
	return value !== undefined && Number.isFinite(Date.parse(value))
		? new Date(value).toISOString()
		: undefined;
}

function safeText(
	value: string | undefined,
	limit: number,
): string | undefined {
	if (value === undefined) return undefined;
	return (
		value
			.replace(/[\u0000-\u001f\u007f]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, limit) || undefined
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

function safeWatchEvent(event: WatchEventMetadata): WatchEventMetadata {
	const safe: WatchEventMetadata = {
		source: event.source === "resource" ? "resource" : "timeline",
		type: safeToken(event.type, "unknown"),
	};
	if (
		event.eventId !== undefined &&
		Number.isSafeInteger(event.eventId) &&
		event.eventId > 0
	)
		safe.eventId = event.eventId;
	if (event.actor !== undefined) safe.actor = safeToken(event.actor, "unknown");
	if (
		event.reviewId !== undefined &&
		Number.isSafeInteger(event.reviewId) &&
		event.reviewId > 0
	)
		safe.reviewId = event.reviewId;
	const createdAt = safeTimestamp(event.createdAt);
	const updatedAt = safeTimestamp(event.updatedAt);
	if (createdAt !== undefined) safe.createdAt = createdAt;
	if (updatedAt !== undefined) safe.updatedAt = updatedAt;
	return safe;
}

export function formatWatchNotification(emission: WatchEmission): {
	content: string;
	details: Record<string, unknown>;
} {
	const parsed = parseResourceRef(emission.reference);
	if (!parsed) throw new Error("watch notification has an invalid reference");
	const reference = formatCanonicalRef(parsed);
	const watchId = safeToken(emission.watchId, "unknown");
	const fetchSince =
		safeTimestamp(emission.fetchSince) ?? new Date(0).toISOString();
	const note = emission.note
		?.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 500);
	const details: Record<string, unknown> = {
		kind: emission.kind,
		watchId,
		reference,
		fetchSince,
	};
	const lines = [
		`Forgejo watch ${emission.kind}: ${watchId}`,
		`Ref: ${reference}`,
	];

	if (emission.kind === "matched") {
		const events = emission.events.slice(0, 20).map(safeWatchEvent);
		const totalCount =
			Number.isSafeInteger(emission.totalCount) && emission.totalCount >= 0
				? emission.totalCount
				: events.length;
		details.totalCount = totalCount;
		details.events = events;
		lines.push(`Events: ${totalCount}`);
		for (const event of events) {
			lines.push(
				`- eventId=${event.eventId ?? "none"} type=${event.type} actor=${event.actor ?? "unknown"} reviewId=${event.reviewId ?? "none"} createdAt=${event.createdAt ?? "unknown"} updatedAt=${event.updatedAt ?? "unknown"}`,
			);
		}
		lines.push(
			`Continue watching: forgejo_watch action=start ref=${reference} events=${emission.filters.join(",")} attention=${emission.attention}`,
		);
	} else if (emission.kind === "failed") {
		const code = safeToken(emission.error.code, "internal");
		const status =
			Number.isInteger(emission.error.status) &&
			(emission.error.status ?? 0) >= 100 &&
			(emission.error.status ?? 0) <= 599
				? emission.error.status
				: undefined;
		details.error = { code, ...(status === undefined ? {} : { status }) };
		lines.push(
			`Error: code=${code}${status === undefined ? "" : ` status=${status}`}`,
		);
	}

	if (note) {
		details.note = note;
		lines.push(`Note: ${note}`);
	}
	const tool = parsed.kind === "issue" ? "forgejo_issue" : "forgejo_pull";
	lines.push(
		`Fetch updates: ${tool} action=updates ref=${reference} since=${fetchSince}`,
	);
	return { content: lines.join("\n"), details };
}

function safeSourceEvent(
	event: SourceWatchEvent,
	source: "ci" | "attention",
): SourceWatchEvent {
	const safe: SourceWatchEvent = {
		type: safeToken(event.type, "unknown"),
	};
	if (event.reference !== undefined && SAFE_REFERENCE.test(event.reference))
		safe.reference = event.reference;
	if (
		event.runId !== undefined &&
		Number.isSafeInteger(event.runId) &&
		event.runId > 0
	)
		safe.runId = event.runId;
	if (event.workflow !== undefined) safe.workflow = safeToken(event.workflow, "unknown");
	if (event.status !== undefined) safe.status = safeToken(event.status, "unknown");
	// CI wake messages stay metadata-only; attention items carry a bounded
	// title because the title is the signal.
	const title = source === "ci" ? undefined : safeText(event.title, 120);
	if (title !== undefined) safe.title = title;
	const url = safeUrl(event.url);
	if (url !== undefined) safe.url = url;
	const updatedAt = safeTimestamp(event.updatedAt);
	if (updatedAt !== undefined) safe.updatedAt = updatedAt;
	return safe;
}

function sourceFollowUpHints(events: SourceWatchEvent[]): string[] {
	const hints: string[] = [];
	const seen = new Set<string>();
	for (const event of events) {
		if (event.reference === undefined || seen.has(event.reference)) continue;
		if (
			(event.type === "ci-failure" || event.type === "ci-cancelled") &&
			event.runId !== undefined
		) {
			hints.push(
				`Inspect: forgejo_actions action=jobs ref=${event.reference} run_id=${event.runId}`,
			);
			seen.add(event.reference);
		} else if (event.type === "review-request") {
			hints.push(`Review: forgejo_pull action=get ref=${event.reference}`);
			seen.add(event.reference);
		}
	}
	return hints.slice(0, 5);
}

export function formatSourceWatchNotification(emission: SourceWatchEmission): {
	content: string;
	details: Record<string, unknown>;
} {
	const watchId = safeToken(emission.watchId, "unknown");
	const watching =
		emission.source === "ci"
			? `CI on ${emission.reference}`
			: emission.reference;
	const note = safeText(emission.note, 500);
	const details: Record<string, unknown> = {
		kind: emission.kind,
		source: emission.source,
		watchId,
		reference: emission.reference,
	};
	const lines = [
		`Forgejo watch ${emission.kind}: ${watchId}`,
		`Watching: ${watching}`,
	];

	if (emission.kind === "matched") {
		const events = emission.events
			.slice(0, 20)
			.map((event) => safeSourceEvent(event, emission.source));
		const totalCount =
			Number.isSafeInteger(emission.totalCount) && emission.totalCount >= 0
				? emission.totalCount
				: events.length;
		details.totalCount = totalCount;
		details.events = events;
		lines.push(`Events: ${totalCount}`);
		for (const event of events) {
			const parts = [`type=${event.type}`];
			if (event.reference !== undefined) parts.push(`ref=${event.reference}`);
			if (event.runId !== undefined) parts.push(`runId=${event.runId}`);
			if (event.workflow !== undefined)
				parts.push(`workflow=${event.workflow}`);
			if (event.status !== undefined) parts.push(`status=${event.status}`);
			if (event.title !== undefined) parts.push(`title=${event.title}`);
			if (event.updatedAt !== undefined) parts.push(`at=${event.updatedAt}`);
			lines.push(`- ${parts.join(" ")}`);
			if (event.url !== undefined) lines.push(`  ${event.url}`);
		}
		for (const hint of sourceFollowUpHints(events)) lines.push(hint);
		if (emission.source === "ci")
			lines.push(
				`Continue watching: forgejo_watch action=start ref=${emission.reference} events=ci attention=${emission.attention}`,
			);
		else if (emission.target !== undefined)
			lines.push(
				`Continue watching: forgejo_watch action=start target=${emission.target}${emission.servers === undefined ? "" : ` servers=${emission.servers.join(",")}`} attention=${emission.attention}`,
			);
	} else if (emission.kind === "failed") {
		const code = safeToken(emission.error.code, "internal");
		const status =
			Number.isInteger(emission.error.status) &&
			(emission.error.status ?? 0) >= 100 &&
			(emission.error.status ?? 0) <= 599
				? emission.error.status
				: undefined;
		details.error = { code, ...(status === undefined ? {} : { status }) };
		lines.push(
			`Error: code=${code}${status === undefined ? "" : ` status=${status}`}`,
		);
	}

	if (note) {
		details.note = note;
		lines.push(`Note: ${note}`);
	}
	return { content: lines.join("\n"), details };
}

export function sendWatchNotification(
	pi: ExtensionAPI,
	emission: WatchEmission | SourceWatchEmission,
): void {
	const message =
		"source" in emission
			? formatSourceWatchNotification(emission)
			: formatWatchNotification(emission);
	const options =
		emission.attention === "turn"
			? { triggerTurn: true, deliverAs: "steer" as const }
			: { triggerTurn: false };
	pi.sendMessage(
		{ customType: "forgejo-watch", ...message, display: true },
		options,
	);
}
