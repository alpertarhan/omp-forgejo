import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { Type } from "typebox";
import {
  formatCanonicalRef,
  formatCanonicalRepoRef,
  formatRepoRef,
  formatResourceRef,
  parseRepoRef,
  parseResourceRef,
  REF_FORMAT_HINT,
} from "../refs.js";
import { toolResult, type RuntimeProvider } from "./common.js";

export function registerContextTools(
  pi: ExtensionAPI,
  runtimeProvider: RuntimeProvider,
): void {
  pi.registerTool({
    name: "forgejo_context",
    label: "Forgejo Context",
    description: "Resolve Forgejo context, health, capabilities, or ref.",
    parameters: Type.Object({
      action: Type.Enum([
        "current",
        "servers",
        "select",
        "whoami",
        "health",
        "capabilities",
        "resolve_ref",
      ] as const),
      server: Type.Optional(Type.String()),
      ref: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, signal) {
      const runtime = runtimeProvider();
      if (params.action === "current") {
        const repo = runtime.currentRepo();
        const reason =
          runtime.repoResolution.status === "resolved"
            ? "repository context is not selected"
            : runtime.repoResolution.reason;
        const summary = repo
          ? `Active Forgejo repository: ${formatRepoRef(repo)}`
          : `No active Forgejo repository: ${reason}`;
        return toolResult(summary, {
          repo,
          resolution: runtime.repoResolution,
          server: runtime.currentServer(),
        });
      }
      if (params.action === "servers") {
        const servers = Object.entries(runtime.config.servers).map(
          ([alias, config]) => ({
            alias,
            baseUrl: config.baseUrl,
            hostname: config.hostname,
            credentialProvider: config.credentialProvider,
            tokenEnv: config.tokenEnv,
            selected: runtime.currentServer() === alias,
          }),
        );
        return toolResult(
          `Configured Forgejo servers: ${servers.map((server) => server.alias).join(", ")}`,
          servers,
        );
      }
      if (params.action === "select") {
        if (!params.server) throw new Error("server is required for select");
        const repo = runtime.selectServer(params.server);
        return toolResult(
          repo
            ? `Selected ${formatRepoRef(repo)}`
            : `Selected Forgejo server ${params.server}; provide owner/repo for repository operations`,
          { server: params.server, repo },
        );
      }
      if (params.action === "resolve_ref") {
        if (!params.ref) throw new Error("ref is required for resolve_ref");
        const resource = parseResourceRef(params.ref);
        const repo = resource ?? parseRepoRef(params.ref);
        if (!repo)
          throw new Error(
            `invalid Forgejo reference '${params.ref}' — ${REF_FORMAT_HINT}`,
          );
        runtime.client(repo.server);
        const display = resource
          ? formatResourceRef(resource)
          : formatRepoRef(repo);
        const canonical = resource
          ? formatCanonicalRef(resource)
          : formatCanonicalRepoRef(repo);
        return toolResult(`${display} -> ${canonical}`, {
          ref: repo,
          canonical,
        });
      }

      const forceRefresh = params.action !== "whoami";
      if (params.server)
        await runtime.capabilities.refreshAlias(
          params.server,
          signal,
          forceRefresh,
        );
      else await runtime.capabilities.refresh(signal, forceRefresh);
      const capabilities = runtime.capabilities.snapshot();
      if (params.action === "whoami") {
        const identities = Object.fromEntries(
          Object.entries(capabilities.values)
            .filter(([alias]) => !params.server || alias === params.server)
            .map(([alias, value]) => [alias, value.user]),
        );
        if (params.server && !identities[params.server]) {
          throw new Error(
            capabilities.errors[params.server] ??
            `unknown Forgejo server '${params.server}'`,
          );
        }
        const summary = Object.entries(identities)
          .map(([alias, user]) => `${alias}: ${user.login}`)
          .join(" | ");
        return toolResult(summary || "No Forgejo identities available", identities);
      }
      if (params.action === "capabilities") {
        const values = params.server
          ? capabilities.values[params.server]
            ? { [params.server]: capabilities.values[params.server] }
            : {}
          : capabilities.values;
        return toolResult(
          Object.values(values)
            .filter(
              (value): value is NonNullable<typeof value> => value !== undefined,
            )
            .map((value) => `${value.server}: Forgejo ${value.version}`)
            .join(" | ") || "No capability data available",
          { values, errors: capabilities.errors },
        );
      }
      const health = Object.fromEntries(
        runtime.clients
          .aliases()
          .map((alias) => [
            alias,
            capabilities.values[alias]
              ? { status: "ok", version: capabilities.values[alias]?.version }
              : { status: "error", error: capabilities.errors[alias] },
          ]),
      );
      return toolResult(
        Object.entries(health)
          .map(([alias, value]) => `${alias}: ${value?.status ?? "error"}`)
          .join(" | "),
        health,
      );
    },
  });

}
