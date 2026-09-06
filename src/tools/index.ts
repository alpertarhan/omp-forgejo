import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RuntimeProvider } from "./common.js";
import { toolResult } from "./common.js";
import { registerActionsTool } from "./actions.js";
import { registerContextTools } from "./context.js";
import { registerIssueTool } from "./issue.js";
import { registerNotificationTool } from "./notifications.js";
import { registerPullTool } from "./pull.js";
import { registerReviewTool } from "./review.js";
import { registerSearchTool } from "./search.js";
import {
	registerWatchTool,
	type SourceWatchManagerProvider,
	type WatchManagerProvider,
} from "./watch.js";

const FORGEJO_TOOL_DOMAINS = [
	"issue",
	"pull",
	"review",
	"actions",
	"notifications",
	"search",
	"dashboard",
	"watch",
] as const;
type ForgejoToolDomain = (typeof FORGEJO_TOOL_DOMAINS)[number];
const MAX_DOMAINS_PER_LOAD = 4;

const LAZY_FORGEJO_TOOL_NAMES = [
	"forgejo_actions",
	"forgejo_dashboard",
	"forgejo_issue",
	"forgejo_pull",
	"forgejo_review",
	"forgejo_notifications",
	"forgejo_search",
	"forgejo_watch",
] as const;

const LAZY_FORGEJO_TOOLS = new Set<string>(LAZY_FORGEJO_TOOL_NAMES);
const DOMAIN_TOOL_NAMES = {
	issue: ["forgejo_issue"],
	pull: ["forgejo_pull"],
	review: ["forgejo_pull", "forgejo_review"],
	actions: ["forgejo_actions"],
	notifications: ["forgejo_notifications"],
	search: ["forgejo_search"],
	dashboard: ["forgejo_dashboard"],
	watch: ["forgejo_watch"],
} as const satisfies Record<ForgejoToolDomain, readonly string[]>;

const DOMAIN_ACTIONS: Record<ForgejoToolDomain, string> = {
	issue:
		"get,list,timeline,updates,create,update,comment,labels,assignees,milestone,due_date,close,reopen; refs[] batches get/update/close/reopen",
	pull:
		"get,list,timeline,updates,files,diff,commits,checks,create,update,labels,assignees,milestone,reviewers,draft,close,reopen,readiness,merge; refs[] batches, prs[] batch create",
	review: "draft,preview,submit against a pull ref",
	actions: "list,get,jobs,job_log,dispatch,cancel,rerun,artifacts,download",
	notifications: "list,get,mark_read,mark_unread,mark_all_read",
	search: "issues,pulls,repositories,users",
	dashboard:
		"get,refresh,get_attention_items,get_assigned_issues,get_authored_pulls,get_review_requests,get_failed_runs",
	watch:
		"start,list,stop; events=timeline filters|[ci]; target=review_requests|notifications",
};

interface ForgejoToolController {
	reset(): void;
}

function toolsForDomains(domains: readonly ForgejoToolDomain[]): string[] {
	const selected = domains.flatMap((domain) => DOMAIN_TOOL_NAMES[domain]);
	return [...new Set(selected)];
}

function liteToolMode(runtimeProvider: RuntimeProvider): boolean {
	try {
		return runtimeProvider().config.tools.mode === "lite";
	} catch {
		// Before session start there is no runtime; default to full behavior.
		return false;
	}
}

export function registerForgejoTools(
	pi: ExtensionAPI,
	runtimeProvider: RuntimeProvider,
	watchManagerProvider: WatchManagerProvider = () => {
		throw new Error(
			"Forgejo watch manager is unavailable before session start",
		);
	},
	sourceWatchManagerProvider: SourceWatchManagerProvider = () => {
		throw new Error(
			"Forgejo source watch manager is unavailable before session start",
		);
	},
): ForgejoToolController {
	registerActionsTool(pi, runtimeProvider);
	registerContextTools(pi, runtimeProvider);
	registerIssueTool(pi, runtimeProvider);
	registerPullTool(pi, runtimeProvider);
	registerReviewTool(pi, runtimeProvider);
	registerNotificationTool(pi, runtimeProvider);
	registerSearchTool(pi, runtimeProvider);
	registerWatchTool(
		pi,
		runtimeProvider,
		watchManagerProvider,
		sourceWatchManagerProvider,
	);

	pi.registerTool({
		name: "forgejo_tools",
		label: "Forgejo Tools",
		description: "Activate needed Forgejo domains.",
		promptGuidelines: [
			"Use forgejo_tools before an unavailable Forgejo operation.",
		],
		parameters: Type.Object({
			domains: Type.Array(StringEnum(FORGEJO_TOOL_DOMAINS), {
				minItems: 1,
				maxItems: MAX_DOMAINS_PER_LOAD,
				uniqueItems: true,
			}),
		}),
		async execute(_toolCallId, params) {
			if (params.domains.length > MAX_DOMAINS_PER_LOAD) {
				throw new Error(
					`forgejo_tools activates at most ${MAX_DOMAINS_PER_LOAD} domains per call; load the next group only when needed`,
				);
			}
			if (
				typeof pi.getActiveTools !== "function" ||
				typeof pi.setActiveTools !== "function"
			) {
				return toolResult(
					"Dynamic Forgejo tool activation is unavailable in this Pi version; registered tools remain unchanged.",
					{
						requested: params.domains,
						selected: [],
						added: [],
					},
				);
			}
			const requested = [...new Set(params.domains)];
			const selected = toolsForDomains(requested);
			const active = pi.getActiveTools();
			const activeSet = new Set(active);
			const added = selected.filter((name) => !activeSet.has(name));
			// Lite mode swaps domains instead of accumulating them so the session
			// context carries at most the latest activation's schemas.
			const removed = liteToolMode(runtimeProvider)
				? active.filter(
						(name) =>
							LAZY_FORGEJO_TOOLS.has(name) && !selected.includes(name),
					)
				: [];
			if (added.length > 0 || removed.length > 0) {
				const removedSet = new Set(removed);
				pi.setActiveTools([
					...active.filter((name) => !removedSet.has(name)),
					...added,
				]);
			}
			const cheatsheet = [...new Set(requested)]
				.map((domain) => `${domain}: ${DOMAIN_ACTIONS[domain]}`)
				.join("\n");
			const summary = [
				added.length > 0
					? `Enabled Forgejo tools: ${added.join(", ")}`
					: `Requested Forgejo tools already active: ${selected.join(", ")}`,
				...(removed.length > 0
					? [`Disabled Forgejo tools (lite mode): ${removed.join(", ")}`]
					: []),
			].join("\n");
			return toolResult(
				`${summary}\n${cheatsheet}`,
				{ requested, selected, added, removed },
			);
		},
	});

	return {
		reset() {
			if (
				typeof pi.getActiveTools !== "function" ||
				typeof pi.setActiveTools !== "function"
			)
				return;
			const active = pi.getActiveTools();
			if (!active.includes("forgejo_tools")) return;
			pi.setActiveTools(active.filter((name) => !LAZY_FORGEJO_TOOLS.has(name)));
		},
	};
}
