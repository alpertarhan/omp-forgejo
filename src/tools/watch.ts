import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseResourceRef } from "../refs.js";
import type { SourceWatchManager } from "../source-watch.js";
import type { WatchManager, WatchFilter } from "../watch.js";
import {
	boundModelText,
	DEFAULT_LARGE_MODEL_OUTPUT_BYTES,
	toolResult,
	type RuntimeProvider,
} from "./common.js";

export type WatchManagerProvider = () => WatchManager;
export type SourceWatchManagerProvider = () => SourceWatchManager;

const WATCH_EVENTS = [
	"feedback",
	"comment",
	"review_comment",
	"review",
	"review_request",
	"closed",
	"reopened",
	"merged",
	"push",
	"ci",
	"any",
] as const satisfies readonly (WatchFilter | "ci")[];

const START_FIELDS = [
	"ref",
	"events",
	"target",
	"since",
	"interval_seconds",
	"timeout_minutes",
	"attention",
	"include_self",
	"note",
] as const;

function rejectFields(
	params: Record<string, unknown>,
	fields: readonly string[],
	action: string,
): void {
	const supplied = fields.filter((field) => params[field] !== undefined);
	if (supplied.length > 0)
		throw new Error(
			`${supplied.join(", ")} ${supplied.length === 1 ? "is" : "are"} not valid for ${action}`,
		);
}

function validateInteger(
	value: unknown,
	name: string,
	minimum: number,
	maximum: number,
): void {
	if (
		value !== undefined &&
		(!Number.isInteger(value) ||
			(value as number) < minimum ||
			(value as number) > maximum)
	) {
		throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	}
}

function validateStartParams(params: Record<string, unknown>): void {
	validateInteger(params.interval_seconds, "interval_seconds", 30, 3600);
	validateInteger(params.timeout_minutes, "timeout_minutes", 1, 1440);
	if (
		params.attention !== undefined &&
		params.attention !== "turn" &&
		params.attention !== "context"
	) {
		throw new Error("attention must be turn or context");
	}
	if (
		params.include_self !== undefined &&
		typeof params.include_self !== "boolean"
	) {
		throw new Error("include_self must be a boolean");
	}
	if (params.note !== undefined && typeof params.note !== "string")
		throw new Error("note must be a string");
	if (typeof params.note === "string" && params.note.length > 500)
		throw new Error("note must be at most 500 characters");
}

function validateEventsForKind(
	events: readonly (WatchFilter | "ci")[],
	kind: "issue" | "pull",
): void {
	if (kind === "pull") return;
	const pullOnly = events.filter((event) =>
		[
			"review_comment",
			"review",
			"review_request",
			"merged",
			"push",
			"ci",
		].includes(event),
	);
	if (pullOnly.length > 0) {
		throw new Error(
			`${pullOnly.join(", ")} ${pullOnly.length === 1 ? "is" : "are"} only valid for pull-request watches`,
		);
	}
}

export function registerWatchTool(
	pi: ExtensionAPI,
	runtimeProvider: RuntimeProvider,
	watchManagerProvider: WatchManagerProvider,
	sourceWatchManagerProvider: SourceWatchManagerProvider = () => {
		throw new Error(
			"Forgejo source watch manager is unavailable before session start",
		);
	},
): void {
	pi.registerTool({
		name: "forgejo_watch",
		label: "Forgejo Watch",
		description:
			"Start/list/stop one-shot watches for issue/PR events, PR CI, review requests, or notifications.",
		parameters: Type.Object({
			action: StringEnum(["start", "list", "stop"] as const),
			ref: Type.Optional(Type.String()),
			events: Type.Optional(
				Type.Array(StringEnum(WATCH_EVENTS), {
					minItems: 1,
					uniqueItems: true,
					description: "Timeline events or [ci]",
				}),
			),
			target: Type.Optional(
				StringEnum(["review_requests", "notifications"] as const, {
					description: "Cross-server source instead of ref",
				}),
			),
			since: Type.Optional(Type.String({ format: "date-time" })),
			interval_seconds: Type.Optional(
				Type.Integer({ minimum: 30, maximum: 3600, default: 60 }),
			),
			timeout_minutes: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 1440, default: 120 }),
			),
			attention: Type.Optional(
				StringEnum(["turn", "context"] as const, { default: "turn" }),
			),
			include_self: Type.Optional(Type.Boolean({ default: false })),
			note: Type.Optional(
				Type.String({ maxLength: 500 }),
			),
			id: Type.Optional(Type.String({ minLength: 1 })),
			all: Type.Optional(Type.Boolean()),
		}),
		async execute(_toolCallId, params, signal) {
			const runtime = runtimeProvider();
			const manager = watchManagerProvider();
			const sourceManager = sourceWatchManagerProvider();
			if (params.action === "list") {
				rejectFields(params, [...START_FIELDS, "id", "all"], "list");
				const watches = [
					...manager.list().map((watch) => ({ source: "timeline", ...watch })),
					...sourceManager.list(),
				];
				const summaryWatches = watches.map(
					({ matchedEvents: _events, ...watch }) => watch,
				);
				const summary = boundModelText(
					JSON.stringify({ watches: summaryWatches }),
					DEFAULT_LARGE_MODEL_OUTPUT_BYTES,
				);
				return toolResult(summary.text, { watches });
			}

			if (params.action === "stop") {
				rejectFields(params, START_FIELDS, "stop");
				if (params.all === false)
					throw new Error("all must be true when provided");
				const stopAll = params.all === true;
				if ((params.id !== undefined) === stopAll) {
					throw new Error("stop requires exactly one of id or all=true");
				}
				if (stopAll) {
					const timelineIds = manager
						.list()
						.filter(
							(watch) => watch.state === "active" && manager.stop(watch.id),
						)
						.map((watch) => watch.id);
					const sourceIds = sourceManager
						.list()
						.filter(
							(watch) =>
								watch.state === "active" && sourceManager.stop(watch.id),
						)
						.map((watch) => watch.id);
					const ids = [...timelineIds, ...sourceIds];
					return toolResult(JSON.stringify({ stopped: ids.length, ids }), {
						stopped: ids.length,
						ids,
					});
				}
				const stopped =
					manager.stop(params.id as string) ||
					sourceManager.stop(params.id as string);
				return toolResult(JSON.stringify({ id: params.id, stopped }), {
					id: params.id,
					stopped,
				});
			}

			rejectFields(params, ["id", "all"], "start");
			validateStartParams(params);

			if (params.target !== undefined) {
				rejectFields(
					params,
					["ref", "events", "since", "include_self"],
					"target start",
				);
				const existingIds = new Set(
					sourceManager.list().map((watch) => watch.id),
				);
				const watch = await sourceManager.arm({
					target: params.target,
					pollIntervalMs: (params.interval_seconds ?? 60) * 1_000,
					timeoutMs: (params.timeout_minutes ?? 120) * 60_000,
					attention: params.attention ?? "turn",
					...(params.note === undefined ? {} : { note: params.note }),
					...(signal === undefined ? {} : { signal }),
				});
				const outcome = existingIds.has(watch.id)
					? "deduplicated"
					: "created";
				const data = { outcome, watch };
				return toolResult(JSON.stringify(data), data);
			}

			if (!params.ref) throw new Error("ref or target is required for start");
			if (params.events !== undefined && params.events.length === 0)
				throw new Error("events must contain at least one event");
			const parsed = parseResourceRef(params.ref);
			if (!parsed) throw new Error(`invalid Forgejo reference '${params.ref}'`);
			const events = params.events ?? ["feedback"];
			validateEventsForKind(events, parsed.kind);
			const ref = runtime.resolveResource({ ref: params.ref }, parsed.kind);

			if (events.includes("ci")) {
				if (events.length > 1)
					throw new Error(
						"ci cannot be combined with other events; start a separate timeline watch alongside it",
					);
				const existingIds = new Set(
					sourceManager.list().map((watch) => watch.id),
				);
				const watch = await sourceManager.arm({
					ref,
					pollIntervalMs: (params.interval_seconds ?? 60) * 1_000,
					timeoutMs: (params.timeout_minutes ?? 120) * 60_000,
					attention: params.attention ?? "turn",
					...(params.note === undefined ? {} : { note: params.note }),
					...(signal === undefined ? {} : { signal }),
				});
				const outcome = existingIds.has(watch.id)
					? "deduplicated"
					: "created";
				const data = { outcome, watch };
				return toolResult(JSON.stringify(data), data);
			}

			const existingIds = new Set(manager.list().map((watch) => watch.id));
			const watch = await manager.arm({
				ref,
				// "ci" watches returned to the source manager above.
				filters: events as WatchFilter[],
				pollIntervalMs: (params.interval_seconds ?? 60) * 1_000,
				timeoutMs: (params.timeout_minutes ?? 120) * 60_000,
				attention: params.attention ?? "turn",
				includeSelf: params.include_self ?? false,
				...(params.since === undefined ? {} : { since: params.since }),
				...(params.note === undefined ? {} : { note: params.note }),
				...(signal === undefined ? {} : { signal }),
			});
			const outcome =
				watch.state === "matched"
					? "already-matched"
					: existingIds.has(watch.id)
						? "deduplicated"
						: "created";
			const data = { outcome, watch };
			return toolResult(JSON.stringify(data), data);
		},
	});
}
