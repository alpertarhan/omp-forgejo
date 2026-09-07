import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { setConfigHostContext } from "./config.js";
import { runForgejoSetup, type SetupStage } from "./setup.js";
import {
  formatRepoRef,
  parseRepoRef,
  parseResourceRef,
  REF_FORMAT_HINT,
  repoWebUrl,
  resourceWebUrl,
} from "./refs.js";
import { createRuntime, type ForgejoRuntime } from "./runtime.js";
import { SourceWatchManager } from "./source-watch.js";
import { registerForgejoTools } from "./tools/index.js";
import type { RepoResolution } from "./types.js";
import { WatchManager } from "./watch.js";
import { sendWatchNotification } from "./watch-notification.js";

export function forgejoToolkitActive(
  serverCount: number,
  status: RepoResolution["status"],
): boolean {
  return serverCount > 0 && status !== "none";
}

function parseHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Forgejo link must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new Error("Forgejo link must use http or https");
  return parsed;
}

export function forgejoWebUrl(url: string, expectedBaseUrl?: string): URL {
  const target = parseHttpUrl(url);
  if (!expectedBaseUrl) return target;
  const base = parseHttpUrl(expectedBaseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  if (
    target.origin !== base.origin ||
    (basePath &&
      target.pathname !== basePath &&
      !target.pathname.startsWith(`${basePath}/`))
  ) {
    throw new Error("Forgejo link leaves the configured server URL");
  }
  return target;
}

export function externalOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  const normalizedUrl = forgejoWebUrl(url).href;
  return platform === "darwin"
    ? { command: "open", args: [normalizedUrl] }
    : platform === "win32"
      ? { command: "explorer.exe", args: [normalizedUrl] }
      : { command: "xdg-open", args: [normalizedUrl] };
}

async function openExternal(
  pi: ExtensionAPI,
  url: string,
  expectedBaseUrl?: string,
): Promise<void> {
  const target = forgejoWebUrl(url, expectedBaseUrl);
  const { command, args } = externalOpenCommand(target.href);
  const result = await pi.exec(command, args, { timeout: 5_000 });
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `failed to open ${url}`);
}

export default function forgejoExtension(pi: ExtensionAPI): void {
  let runtime: ForgejoRuntime | undefined;
  let toolkitDeactivatedByUs = false;
  let watchManager: WatchManager | undefined;
  let sourceWatchManager: SourceWatchManager | undefined;
  let startupError: Error | undefined;

  const requireRuntime = (): ForgejoRuntime => {
    if (runtime) return runtime;
    if (startupError) throw startupError;
    throw new Error("Forgejo extension is still initializing");
  };

  const cleanup = (): void => {
    watchManager?.close();
    watchManager = undefined;
    sourceWatchManager?.close();
    sourceWatchManager = undefined;
    runtime?.close();
    runtime = undefined;
  };

  pi.registerCommand("fj-setup", {
    description: "Run the guided Forgejo server, credential, and tool setup",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) throw new Error("/fj-setup requires an interactive UI");
      const labels: Record<SetupStage, string> = {
        scope: "Scope",
        servers: "Servers",
        tools: "Tools",
        review: "Review",
      };
      const updateProgress = (
        stage: SetupStage,
        step: number,
        total: number,
      ): void => {
        ctx.ui.setStatus(
          "forgejo-setup",
          `setup ${step}/${total} · ${labels[stage]}`,
        );
        if (ctx.mode === "tui") {
          const stages: SetupStage[] = ["scope", "servers", "tools", "review"];
          ctx.ui.setWidget("forgejo-setup", [
            `Forgejo Setup  ${step}/${total}`,
            stages
              .map(
                (value, index) =>
                  `${value === stage ? "[" : " "}${index + 1} ${labels[value]}${value === stage ? "]" : " "}`,
              )
              .join("  "),
            "Native guided setup; Esc cancels safely. API token values are never written.",
          ]);
        }
      };
      try {
        const result = await runForgejoSetup({
          args,
          cwd: ctx.cwd,
          ui: ctx.ui,
          exec: async (command, commandArgs, options) =>
            pi.exec(command, commandArgs, options),
          onStage: updateProgress,
        });
        if (!result) {
          ctx.ui.notify(
            "Forgejo setup cancelled; no configuration was changed.",
            "info",
          );
          return;
        }
        ctx.ui.notify(`Forgejo config written: ${result.target}`, "info");
        await ctx.reload();
      } finally {
        ctx.ui.setStatus("forgejo-setup", undefined);
        if (ctx.mode === "tui") ctx.ui.setWidget("forgejo-setup", undefined);
      }
    },
  });
  const forgejoTools = registerForgejoTools(pi, requireRuntime, () => {
    if (!watchManager)
      throw new Error("Forgejo watch manager is unavailable before session start");
    return watchManager;
  }, () => {
    if (!sourceWatchManager)
      throw new Error(
        "Forgejo source watch manager is unavailable before session start",
      );
    return sourceWatchManager;
  });

  pi.registerCommand("fj-context", {
    description: "Show the active Forgejo server and repository",
    handler: async (_args, ctx) => {
      const current = requireRuntime();
      const repo = current.currentRepo();
      const reason =
        current.repoResolution.status === "resolved"
          ? "repository context is not selected"
          : current.repoResolution.reason;
      ctx.ui.notify(
        repo ? `Forgejo: ${formatRepoRef(repo)}` : `Forgejo: ${reason}`,
        repo ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("fj-server", {
    description: "Select a Forgejo server for this session",
    handler: async (args, ctx) => {
      const current = requireRuntime();
      let alias = args.trim();
      if (!alias) {
        if (!ctx.hasUI)
          throw new Error("server alias is required without an interactive UI");
        alias =
          (await ctx.ui.select("Forgejo server", current.clients.aliases())) ?? "";
      }
      if (!alias) return;
      const repo = current.selectServer(alias);
      ctx.ui.notify(
        repo
          ? `Selected ${formatRepoRef(repo)}`
          : `Selected ${alias}; repository context remains explicit`,
        "info",
      );
    },
  });

  pi.registerCommand("fj-health", {
    description: "Check every configured Forgejo server and token",
    handler: async (_args, ctx) => {
      const current = requireRuntime();
      const snapshot = await current.capabilities.refresh(undefined, true);
      const lines = current.clients
        .aliases()
        .map((alias) =>
          snapshot.values[alias]
            ? `${alias}: ok (Forgejo ${snapshot.values[alias]?.version})`
            : `${alias}: ${snapshot.errors[alias] ?? "error"}`,
        );
      ctx.ui.notify(
        lines.join("\n"),
        Object.keys(snapshot.errors).length > 0 ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("fj-open", {
    description:
      "Open the active Forgejo repository or a qualified issue/PR reference",
    handler: async (args) => {
      const current = requireRuntime();
      const value = args.trim();
      if (value) {
        const resource = parseResourceRef(value);
        if (resource) {
          const server = current.config.servers[resource.server];
          if (!server) throw new Error(`unknown server '${resource.server}'`);
          await openExternal(pi, resourceWebUrl(resource, server), server.baseUrl);
          return;
        }
        const repo = parseRepoRef(value);
        if (repo) {
          const server = current.config.servers[repo.server];
          if (!server) throw new Error(`unknown server '${repo.server}'`);
          await openExternal(pi, repoWebUrl(repo, server), server.baseUrl);
          return;
        }
        throw new Error(
          `invalid Forgejo reference '${value}' — ${REF_FORMAT_HINT}`,
        );
      }
      const repo = current.currentRepo();
      if (!repo) throw new Error("no active Forgejo repository");
      const server = current.config.servers[repo.server];
      if (!server) throw new Error(`unknown server '${repo.server}'`);
      await openExternal(pi, repoWebUrl(repo, server), server.baseUrl);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // omp-native config location: the active agent directory follows
    // profiles (~/.omp/profiles/<name>/agent) and PI_CODING_AGENT_DIR,
    // the relocation variable omp honors. Resolved from the environment
    // (never a pi-coding-agent import, which would pull optional
    // dependencies into build graphs).
    const profile = process.env.OMP_PROFILE?.trim();
    setConfigHostContext({
      agentDir:
        process.env.PI_CODING_AGENT_DIR?.trim() ||
        (profile
          ? resolve(homedir(), ".omp", "profiles", profile, "agent")
          : resolve(homedir(), ".omp", "agent")),
    });
    forgejoTools.reset();
    cleanup();
    startupError = undefined;
    try {
      runtime = await createRuntime(
        ctx.cwd,
        async (command, args, options) => pi.exec(command, args, options),
        process.env,
        fetch,
        ctx.isProjectTrusted(),
      );
    } catch (error) {
      startupError = error instanceof Error ? error : new Error(String(error));
      if (ctx.hasUI) ctx.ui.notify(startupError.message, "warning");
      return;
    }
    const forgejoActive = forgejoToolkitActive(
      runtime.clients.aliases().length,
      runtime.repoResolution.status,
    );
    if (!forgejoActive) {
      // Outside a Forgejo repository the toolkit stays entirely out of
      // the model context: no tools, no prompts. (Skills ship with the
      // package and are discovered by omp's plugin provider regardless.)
      pi.setActiveTools(
        pi.getActiveTools().filter((name) => !name.startsWith("forgejo_")),
      );
      toolkitDeactivatedByUs = true;
      return;
    }
    if (toolkitDeactivatedByUs) {
      // A resumed session in a Forgejo repository restores the bootstrap
      // tools this extension removed earlier.
      const active = pi.getActiveTools();
      const missing = ["forgejo_context", "forgejo_tools"].filter(
        (name) => !active.includes(name),
      );
      if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
      toolkitDeactivatedByUs = false;
    }
    const currentManager = new WatchManager(
      (server) => requireRuntime().client(server),
      (emission) => {
        if (watchManager === currentManager) sendWatchNotification(pi, emission);
      },
    );
    watchManager = currentManager;
    const currentSourceManager = new SourceWatchManager(
      (server) => requireRuntime().client(server),
      () => runtime?.clients.aliases() ?? [],
      (emission) => {
        if (sourceWatchManager === currentSourceManager)
          sendWatchNotification(pi, emission);
      },
    );
    sourceWatchManager = currentSourceManager;
  });

  pi.on("session_shutdown", async () => {
    cleanup();
  });
}
