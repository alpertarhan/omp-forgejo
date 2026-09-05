export interface SchedulerSlot {
	state: string;
	nextPollTime?: number;
	nextPollAt?: string;
	expiresTime?: number;
	expiryPolled: boolean;
	inFlight: boolean;
}

/**
 * Shared single-timer poll scheduler for watch managers: one unref'd timer
 * covers every active watch's next poll and expiry deadline, and an expiring
 * idle watch gets one final poll whose result decides the outcome.
 */
export class WatchScheduler<T extends SchedulerSlot> {
	private timer: NodeJS.Timeout | undefined;
	private stopped = false;

	constructor(
		private readonly slots: () => Iterable<T>,
		private readonly poll: (watch: T) => Promise<void>,
		private readonly onExpiryAbort: (watch: T) => void,
	) {}

	get closed(): boolean {
		return this.stopped;
	}

	close(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	schedule(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (this.stopped) return;
		let due: number | undefined;
		for (const watch of this.slots()) {
			if (watch.state !== "active") continue;
			if (watch.expiresTime !== undefined && !watch.expiryPolled)
				due = Math.min(due ?? watch.expiresTime, watch.expiresTime);
			if (!watch.inFlight && watch.nextPollTime !== undefined)
				due = Math.min(due ?? watch.nextPollTime, watch.nextPollTime);
		}
		if (due === undefined) return;
		this.timer = setTimeout(() => this.tick(), Math.max(0, due - Date.now()));
		if (typeof this.timer === "object" && "unref" in this.timer)
			this.timer.unref();
	}

	private tick(): void {
		this.timer = undefined;
		const now = Date.now();
		for (const watch of this.slots()) {
			if (watch.state !== "active" || watch.expiryPolled) continue;
			if (watch.expiresTime !== undefined && watch.expiresTime <= now) {
				// A poll still running from before the deadline is aborted,
				// but an idle watch gets one final poll first.
				if (watch.inFlight) {
					this.onExpiryAbort(watch);
					continue;
				}
				watch.expiryPolled = true;
				watch.inFlight = true;
				delete watch.nextPollTime;
				delete watch.nextPollAt;
				void this.poll(watch);
				continue;
			}
			if (
				!watch.inFlight &&
				watch.nextPollTime !== undefined &&
				watch.nextPollTime <= now
			) {
				watch.inFlight = true;
				delete watch.nextPollTime;
				delete watch.nextPollAt;
				void this.poll(watch);
			}
		}
		this.schedule();
	}
}
