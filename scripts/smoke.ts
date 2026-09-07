/**
 * End-to-end smoke test against a real Forgejo instance.
 *
 * Required environment:
 *   SMOKE_FORGEJO_URL    base URL, e.g. http://127.0.0.1:23000
 *   SMOKE_FORGEJO_TOKEN  token of an admin user (scopes: all)
 *
 * Exercises the client, attention queries, timeline scanning, and both watch
 * managers against live Forgejo behavior that the mocked unit suite cannot
 * verify (null bodies, Link headers, timestamp formats, and so on).
 */
import { apiPath, ForgejoClient } from "../src/client.js";
import type { CredentialProvider } from "../src/credentials.js";
import { scanTimeline } from "../src/timeline.js";
import { queryAttentionItems } from "../src/attention.js";
import {
	SourceWatchManager,
	type SourceWatchEmission,
} from "../src/source-watch.js";
import { WatchManager, type WatchEmission } from "../src/watch.js";

type MatchedEmission = Extract<WatchEmission, { kind: "matched" }>;
type MatchedSourceEmission = Extract<SourceWatchEmission, { kind: "matched" }>;
import type {
	ForgejoIssue,
	ForgejoPullRequest,
	ForgejoRepository,
	ResourceRef,
} from "../src/types.js";

const baseUrl = process.env.SMOKE_FORGEJO_URL;
const token = process.env.SMOKE_FORGEJO_TOKEN;
if (!baseUrl || !token) {
	console.error("SMOKE_FORGEJO_URL and SMOKE_FORGEJO_TOKEN are required");
	process.exit(1);
}

const staticToken: CredentialProvider = {
	kind: "env",
	getToken: async () => token,
	clear: () => undefined,
};

const client = new ForgejoClient(
	"smoke",
	{
		baseUrl,
		hostname: new URL(baseUrl).host,
		credentialProvider: "env",
		remoteHosts: [],
	},
	{ credentialProvider: staticToken },
);
const serverUrl = new URL(baseUrl);
const serverHost = serverUrl.host;

function step(message: string): void {
	console.log(`smoke: ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		console.error(`smoke: FAILED: ${message}`);
		process.exit(1);
	}
	console.log(`smoke: ok: ${message}`);
}

async function main(): Promise<void> {
	const suffix = Date.now().toString(36);
	const owner = "smoke";
	const repoName = `smoke-${suffix}`;
	const resourceRef: ResourceRef = {
		server: "smoke",
		owner,
		repo: repoName,
		kind: "issue",
		index: 1,
	};

	step("checking server version");
	const version = await client.request<{ version: string }>("version");
	assert(version.data.version.length > 0, "server version reported");

	step(`creating repository ${owner}/${repoName}`);
	await client.request<ForgejoRepository>(apiPath("user", "repos"), {
		method: "POST",
		body: { name: repoName, private: true, auto_init: true },
	});
	const repo = await client.request<ForgejoRepository>(
		apiPath("repos", owner, repoName),
	);
	const defaultBranch = repo.data.default_branch || "main";
	assert(defaultBranch.length > 0, `repository created (default ${defaultBranch})`);

	step("creating a branch and file via the contents API");
	await client.request(
		apiPath("repos", owner, repoName, "contents", "smoke.txt"),
		{
			method: "POST",
			body: {
				branch: defaultBranch,
				new_branch: "smoke-branch",
				message: "smoke: add file",
				content: Buffer.from("smoke payload\n").toString("base64"),
			},
		},
	);

	step("creating a pull request");
	const pull = await client.request<ForgejoPullRequest>(
		apiPath("repos", owner, repoName, "pulls"),
		{
			method: "POST",
			body: {
				head: "smoke-branch",
				base: defaultBranch,
				title: "smoke: pull request",
				body: "created by scripts/smoke.ts",
			},
		},
	);
	assert(pull.data.number > 0, `pull request #${pull.data.number} created`);

	step("creating an issue and arming a timeline watch");
	const issue = await client.request<ForgejoIssue>(
		apiPath("repos", owner, repoName, "issues"),
		{
			method: "POST",
			body: { title: "smoke: issue", body: "smoke issue body" },
		},
	);
	resourceRef.index = issue.data.number;

	let resolveMatch: ((emission: MatchedEmission) => void) | undefined;
	const matched = new Promise<MatchedEmission>((resolve) => {
		resolveMatch = resolve;
	});
	const watchManager = new WatchManager(
		() => client,
		(emission) => {
			if (emission.kind === "matched") resolveMatch?.(emission);
		},
	);
	const armed = await watchManager.arm({
		ref: resourceRef,
		filters: ["comment"],
		includeSelf: true,
		pollIntervalMs: 1_000,
		timeoutMs: 30_000,
	});
	assert(armed.state === "active", "timeline watch armed");

	step("commenting on the issue");
	await client.request(
		apiPath("repos", owner, repoName, "issues", resourceRef.index, "comments"),
		{ method: "POST", body: { body: "smoke comment from the watch test" } },
	);

	const emission = await Promise.race([
		matched,
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("timeline watch did not match in time")),
				30_000,
			),
		),
	]);
	assert(
		emission.events.some(
			(event) => event.type === "comment" && event.actor === "smoke",
		),
		"timeline watch matched the comment",
	);

	step("scanning the issue timeline directly");
	const scan = await scanTimeline(
		client,
		apiPath("repos", owner, repoName, "issues", resourceRef.index, "timeline"),
		new Date(Date.now() - 5 * 60_000).toISOString(),
		new Date().toISOString(),
		50,
		5,
	);
	assert(
		scan.complete && scan.events.length > 0,
		`timeline scan returned ${scan.events.length} events`,
	);

	step("arming attention queries");
	const sourceManager = new SourceWatchManager(
		() => client,
		() => ["smoke"],
		() => undefined,
	);
	const attention = await sourceManager.arm({
		target: "review_requests",
		pollIntervalMs: 60_000,
		timeoutMs: 60_000,
	});
	assert(attention.state === "active", "attention watch armed");

	const reviewRequests = await queryAttentionItems(
		client,
		"review_requests",
		25,
	);
	const notifications = await queryAttentionItems(
		client,
		"notifications",
		25,
	);
	assert(Array.isArray(reviewRequests), "review request query returned a list");
	assert(Array.isArray(notifications), "notification query returned a list");
	sourceManager.close();

	step("waking from a healthy server while a peer server is degraded");
	// A second Forgejo user supplies the incoming notification; a ghost alias
	// on a dead port proves that one degraded server cannot withhold another
	// server's wake.
	await client.request(apiPath("admin", "users"), {
		method: "POST",
		body: {
			username: `peer-${suffix}`,
			email: `peer-${suffix}@example.com`,
			password: "peer-pass-1234",
			must_change_password: false,
		},
	});
	const peerName = `peer-${suffix}`;
	const peerToken = await client.request<{ sha1: string }>(
		apiPath("admin", "users", peerName, "tokens"),
		{
			method: "POST",
			body: { name: `smoke-${suffix}`, scopes: ["write:repository", "write:issue"] },
		},
	);
	const peerStaticToken: CredentialProvider = {
		kind: "env",
		getToken: async () => peerToken.data.sha1,
		clear: () => undefined,
	};
	const peerClient = new ForgejoClient(
		"peer",
		{
			baseUrl: serverUrl.href,
			hostname: serverHost,
			credentialProvider: "env",
			remoteHosts: [],
		},
		{ credentialProvider: peerStaticToken },
	);
	const ghostClient = new ForgejoClient(
		"ghost",
		{
			baseUrl: "http://127.0.0.1:9",
			hostname: "127.0.0.1:9",
			credentialProvider: "env",
			remoteHosts: [],
		},
		{ credentialProvider: staticToken },
	);
	await client.request(
		apiPath("repos", owner, repoName, "collaborators", peerName),
		{ method: "PUT", body: { permission: "write" } },
	);

	let resolveAttention:
		| ((emission: MatchedSourceEmission) => void)
		| undefined;
	const attentionMatched = new Promise<MatchedSourceEmission>((resolve) => {
		resolveAttention = resolve;
	});
	const degradedManager = new SourceWatchManager(
		(alias) =>
			alias === "ghost" ? ghostClient : alias === "peer" ? peerClient : client,
		() => ["smoke", "ghost"],
		(emission) => {
			if (emission.kind === "matched") resolveAttention?.(emission);
		},
	);
	const degradedWatch = await degradedManager.arm({
		target: "notifications",
		servers: ["smoke", "ghost"],
		pollIntervalMs: 2_000,
		timeoutMs: 45_000,
	});
	assert(degradedWatch.state === "active", "attention watch armed");
	assert(
		(degradedWatch.degradedServers ?? []).includes("ghost"),
		"arm tolerated the degraded ghost server",
	);

	await peerClient.request(
		apiPath("repos", owner, repoName, "issues", resourceRef.index, "comments"),
		{ method: "POST", body: { body: "peer comment for the degraded watch" } },
	);
	const attentionEmission = await Promise.race([
		attentionMatched,
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error("degraded attention watch did not wake in time")),
				45_000,
			),
		),
	]);
	assert(
		attentionEmission.events.some(
			(event) => event.type === "notification" && event.reference !== undefined,
		),
		"healthy server woke the watch despite the degraded peer",
	);
	const degradedListed = degradedManager.list()[0];
	assert(
		(degradedListed?.degradedServers ?? []).includes("ghost"),
		"list reports the degraded server",
	);
	degradedManager.close();
	watchManager.close();

	step("deleting the smoke repository");
	await client.request(apiPath("repos", owner, repoName), {
		method: "DELETE",
	});

	console.log("smoke: PASS");
}

main().catch((error: unknown) => {
	console.error("smoke: FAILED:", error instanceof Error ? error.message : error);
	process.exit(1);
});
