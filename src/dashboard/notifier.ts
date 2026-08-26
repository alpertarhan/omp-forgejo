import { formatResourceRef } from "../refs.js";
import type {
	DashboardItem,
	DashboardSnapshot,
	NotificationLevel,
	ResourceRef,
	ServerHealth,
} from "../types.js";
import type { DashboardStore } from "./store.js";

export type NotifyUser = (
	message: string,
	level: "info" | "warning" | "error",
) => void;

function referenceFor(item: DashboardItem): string {
	if (item.index === undefined || item.resourceKind === "repository")
		return `${item.server}:${item.owner}/${item.repo}`;
	const ref: ResourceRef = {
		server: item.server,
		owner: item.owner,
		repo: item.repo,
		kind: item.resourceKind,
		index: item.index,
	};
	return formatResourceRef(ref);
}

function degraded(health: ServerHealth): boolean {
	return health === "error" || health === "auth-error";
}

export class DashboardNotifier {
	private readonly seen = new Map<string, Set<string>>();
	private initialized = false;
	private lastScope?: string;
	private readonly unsubscribe: () => void;

	constructor(
		store: DashboardStore,
		private readonly level: NotificationLevel,
		private readonly notify: NotifyUser,
	) {
		this.unsubscribe = store.subscribe(() =>
			this.handleChange(store.snapshot()),
		);
	}

	close(): void {
		this.unsubscribe();
	}

	private handleChange(snapshot: DashboardSnapshot): void {
		if (snapshot.refreshing || !snapshot.fetchedAt) return;
		const scopeChanged =
			this.lastScope !== undefined &&
			snapshot.scope !== undefined &&
			this.lastScope !== snapshot.scope;
		if (snapshot.scope !== undefined) this.lastScope = snapshot.scope;
		const candidates = this.candidates(snapshot);
		if (!this.initialized || scopeChanged) {
			for (const alias of Object.keys(snapshot.servers))
				this.seen.set(alias, new Set<string>());
			for (const item of candidates) this.remember(item);
			this.initialized = true;
			return;
		}
		const newItems: DashboardItem[] = [];
		for (const [alias, server] of Object.entries(snapshot.servers)) {
			// A server whose refresh failed keeps its previous keys so recovery
			// does not re-announce items that never actually left the dashboard.
			if (degraded(server.health)) continue;
			const items = candidates.filter((item) => item.server === alias);
			const keys = this.seen.get(alias);
			if (keys === undefined) {
				this.seen.set(alias, new Set(items.map((item) => item.key)));
				continue;
			}
			for (const item of items) if (!keys.has(item.key)) newItems.push(item);
			this.seen.set(alias, new Set(items.map((item) => item.key)));
		}
		if (this.level === "off" || newItems.length === 0) return;
		for (const item of newItems.slice(0, 3)) {
			const label =
				item.kind === "review"
					? "new review request"
					: item.kind === "ci-failed"
						? "failed CI run"
						: "new notification";
			this.notify(
				`Forgejo ${label}: ${referenceFor(item)} - ${item.title}`,
				item.kind === "notification" ? "info" : "warning",
			);
		}
		if (newItems.length > 3)
			this.notify(`Forgejo: ${newItems.length - 3} more new items`, "info");
	}

	private candidates(snapshot: DashboardSnapshot): DashboardItem[] {
		const reviews = Object.values(snapshot.servers).flatMap(
			(server) => server.reviewRequests.items,
		);
		const failedRuns = Object.values(snapshot.servers).flatMap(
			(server) => server.failedRuns.items,
		);
		if (this.level === "off") return [];
		const notifications = Object.values(snapshot.servers).flatMap(
			(server) => server.notifications.items,
		);
		const important = [...reviews, ...failedRuns];
		return this.level === "all"
			? [...important, ...notifications]
			: important;
	}

	private remember(item: DashboardItem): void {
		let keys = this.seen.get(item.server);
		if (keys === undefined) {
			keys = new Set<string>();
			this.seen.set(item.server, keys);
		}
		keys.add(item.key);
	}
}
