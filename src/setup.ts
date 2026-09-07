import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { configPaths, parseConfig } from "./config.js";
import {
  readConfigTextIfPresent,
  writeForgejoConfigAtomic,
} from "./config-storage.js";
import { discoverFgjInstances, suggestServerAlias } from "./fgj.js";
import type { MutationApprovalKey } from "./mutation-approvals.js";
import type { CommandExecutor } from "./process.js";
import type {
  ForgejoConfig,
  ForgejoServerConfig,
  ToolsConfig,
  ToolMode,
} from "./types.js";

export type SetupScope = "global" | "project";
export type SetupStage = "scope" | "servers" | "tools" | "review";

type SetupUI = Pick<
  ExtensionUIContext,
  "select" | "confirm" | "input" | "notify"
>;

export interface ForgejoSetupOptions {
  args: string;
  cwd: string;
  ui: SetupUI;
  exec: CommandExecutor;
  environment?: NodeJS.ProcessEnv;
  onStage?: (stage: SetupStage, step: number, total: number) => void;
}

export interface ForgejoSetupResult {
  scope: SetupScope;
  target: string;
  config: ForgejoConfig;
}

interface SetupDraft {
  servers: Record<string, ForgejoServerConfig>;
  tools: ToolsConfig;
  allowedMutations: MutationApprovalKey[];
  // Top-level keys this wizard does not manage; preserved verbatim when
  // updating an existing configuration so nothing is silently dropped.
  extras: Record<string, unknown>;
}

interface PreparedDraft {
  draft: SetupDraft;
  keptExisting: boolean;
}

const SCOPE_GLOBAL = "Global — use this configuration in every project";
const SCOPE_PROJECT =
  "Project — use this configuration only in the current project";
const UPDATE_EXISTING =
  "Update existing configuration — keep current recognized settings";
const REPLACE_EXISTING =
  "Replace existing configuration — start from a clean setup";
const DISCOVER_FGJ = "Discover servers already signed in with fgj";
const ADD_ENV = "Add a server using an API token environment variable";
const EDIT_SERVER = "Reconfigure an existing server";
const REMOVE_SERVER = "Remove a configured server";
const CONTINUE_SERVERS = "Continue to tool activation";
const WRITE_CONFIG = "Write configuration and reload Pi";
const CHANGE_TOOLS = "Change tool activation";
const CHANGE_SERVERS = "Change configured servers";
const CANCEL_SETUP = "Cancel setup";

const PLACEHOLDER_SERVER = {
  hostname: "setup.invalid",
  credentialProvider: "fgj",
} as const;

const DEFAULT_TOOLS = parseConfig({
  servers: { setup: PLACEHOLDER_SERVER },
}).tools;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyDraft(): SetupDraft {
  return {
    servers: {},
    tools: { ...DEFAULT_TOOLS },
    allowedMutations: [],
    extras: {},
  };
}

function parseExistingDraft(
  text: string,
  target: string,
  preserveAllowedMutations: boolean,
): SetupDraft {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${target}: ${errorMessage(error)}`);
  }
  if (!isObject(value)) throw new Error(`${target} must contain a JSON object`);
  if (value.servers !== undefined && !isObject(value.servers))
    throw new Error(`${target} field 'servers' must be an object`);
  const rawServers = isObject(value.servers) ? value.servers : {};
  const aliases = Object.keys(rawServers);
  const parsed = parseConfig({
    servers: aliases.length > 0 ? rawServers : { setup: PLACEHOLDER_SERVER },
    tools: value.tools,
    allowedMutations: preserveAllowedMutations
      ? value.allowedMutations
      : undefined,
  });
  return {
    servers: aliases.length > 0 ? { ...parsed.servers } : {},
    tools: { ...parsed.tools },
    allowedMutations: [...(parsed.allowedMutations ?? [])],
    extras: Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          key !== "servers" && key !== "tools" && key !== "allowedMutations",
      ),
    ),
  };
}

async function selectScope(
  args: string,
  ui: SetupUI,
): Promise<SetupScope | undefined> {
  const requested = args.trim().toLowerCase();
  if (requested === "global" || requested === "project") return requested;
  if (requested) throw new Error("usage: /fj-setup [global|project]");
  const choice = await ui.select(
    "Forgejo setup · 1/4 · Configuration scope\nChoose where Pi should load these Forgejo settings.",
    [SCOPE_GLOBAL, SCOPE_PROJECT],
  );
  if (choice === SCOPE_GLOBAL) return "global";
  if (choice === SCOPE_PROJECT) return "project";
  return undefined;
}

async function prepareDraft(
  ui: SetupUI,
  target: string,
  originalText: string | undefined,
  preserveAllowedMutations: boolean,
): Promise<PreparedDraft | undefined> {
  if (originalText === undefined)
    return { draft: emptyDraft(), keptExisting: false };

  let existing: SetupDraft | undefined;
  let invalidReason: string | undefined;
  try {
    existing = parseExistingDraft(originalText, target, preserveAllowedMutations);
  } catch (error) {
    invalidReason = errorMessage(error);
  }

  if (existing) {
    const choice = await ui.select(
      `Forgejo setup · Existing configuration\n${target}\n\nChoose how this wizard should handle it.`,
      [UPDATE_EXISTING, REPLACE_EXISTING, CANCEL_SETUP],
    );
    if (choice === UPDATE_EXISTING)
      return { draft: existing, keptExisting: true };
    if (choice !== REPLACE_EXISTING) return undefined;
  } else {
    const choice = await ui.select(
      `Forgejo setup · Existing configuration needs attention\n${invalidReason ?? "The file cannot be read as Forgejo configuration."}`,
      ["Replace the invalid configuration", CANCEL_SETUP],
    );
    if (choice !== "Replace the invalid configuration") return undefined;
  }

  const confirmed = await ui.confirm(
    "Replace Forgejo configuration?",
    `This will replace the contents of:\n${target}\n\nNo API token value will be written.`,
  );
  return confirmed ? { draft: emptyDraft(), keptExisting: false } : undefined;
}

function normalizeServer(
  alias: string,
  value: Record<string, unknown>,
): ForgejoServerConfig {
  const server = parseConfig({ servers: { [alias]: value } }).servers[alias];
  if (!server) throw new Error(`failed to normalize Forgejo server '${alias}'`);
  return server;
}

function aliasValidation(
  alias: string,
  servers: Record<string, ForgejoServerConfig>,
  editing?: string,
): string | undefined {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(alias)) {
    return "Alias must contain lowercase letters, numbers, or hyphens and cannot begin or end with a hyphen.";
  }
  if (alias !== editing && servers[alias])
    return `Alias '${alias}' is already configured. Choose another alias.`;
  return undefined;
}

async function promptValue(
  ui: SetupUI,
  title: string,
  placeholder: string,
  defaultValue: string | undefined,
  validate: (value: string) => string | undefined,
): Promise<string | undefined> {
  for (; ;) {
    const response = await ui.input(title, placeholder);
    if (response === undefined) return undefined;
    const value = response.trim() || defaultValue || "";
    if (!value) {
      ui.notify("A value is required. Press Esc to go back.", "warning");
      continue;
    }
    const problem = validate(value);
    if (!problem) return value;
    ui.notify(problem, "warning");
  }
}

function uniqueSuggestedAlias(
  hostname: string,
  servers: Record<string, ForgejoServerConfig>,
): string {
  const base = suggestServerAlias(hostname);
  let alias = base;
  let suffix = 2;
  while (servers[alias]) {
    alias = `${base}-${suffix}`;
    suffix += 1;
  }
  return alias;
}

async function promptAlias(
  ui: SetupUI,
  hostname: string,
  servers: Record<string, ForgejoServerConfig>,
  editing?: string,
): Promise<string | undefined> {
  const fallback = editing ?? uniqueSuggestedAlias(hostname, servers);
  return promptValue(
    ui,
    `Forgejo setup · Server alias\nUsed in references such as ${fallback}:owner/repo#123. Press Enter to use '${fallback}'.`,
    fallback,
    fallback,
    (value) => aliasValidation(value, servers, editing),
  );
}

function automaticRemoteHosts(server: ForgejoServerConfig): Set<string> {
  let url: URL;
  try {
    url = new URL(server.baseUrl);
  } catch {
    return new Set([server.hostname.toLowerCase()]);
  }
  return new Set([
    url.host.toLowerCase(),
    url.hostname.toLowerCase(),
    server.hostname.toLowerCase(),
  ]);
}

function extraRemoteHosts(server: ForgejoServerConfig): string[] {
  const automatic = automaticRemoteHosts(server);
  return server.remoteHosts.filter((host) => !automatic.has(host.toLowerCase()));
}

async function promptRemoteHosts(
  ui: SetupUI,
  server: ForgejoServerConfig,
): Promise<string[] | undefined> {
  const current = extraRemoteHosts(server);
  const keep =
    current.length > 0
      ? `Keep current SSH aliases — ${current.join(", ")}`
      : undefined;
  const detected = "Use the detected server hostname only — recommended";
  const custom = "Add or replace SSH host aliases used by Git remotes";
  const options = [...(keep ? [keep] : []), detected, custom, "Back"];
  const choice = await ui.select(
    `Forgejo setup · Git remote matching\nPi already recognizes ${server.hostname}. Add aliases only when Git remotes use names such as 'forgejo-work'.`,
    options,
  );
  if (keep && choice === keep) return current;
  if (choice === detected) return [];
  if (choice !== custom) return undefined;
  const response = await ui.input(
    "Forgejo setup · SSH host aliases\nEnter comma-separated aliases. Leave empty to use only the detected hostname.",
    current.join(", ") || "forgejo-work, work-git",
  );
  if (response === undefined) return undefined;
  return [
    ...new Set(
      response
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

async function chooseFgjConfig(
  ui: SetupUI,
  current?: string,
): Promise<string | null | undefined> {
  const keep = current
    ? `Keep current custom fgj config — ${current}`
    : undefined;
  const useDefault = "Use the default fgj configuration";
  const useCustom = current
    ? "Choose a different fgj configuration file"
    : "Use a custom fgj configuration file";
  const choice = await ui.select(
    "Forgejo setup · fgj credential store\nThe wizard only reads fgj auth status; it never requests or writes token values.",
    [...(keep ? [keep] : []), useDefault, useCustom, "Back"],
  );
  if (keep && choice === keep) return current;
  if (choice === useDefault) return null;
  if (choice !== useCustom) return undefined;
  const path = await promptValue(
    ui,
    "Forgejo setup · fgj config path",
    "/absolute/path/to/fgj/config.yaml",
    undefined,
    () => undefined,
  );
  return path;
}

async function discoverServers(
  ui: SetupUI,
  exec: CommandExecutor,
  cwd: string,
  servers: Record<string, ForgejoServerConfig>,
): Promise<void> {
  const configPath = await chooseFgjConfig(ui);
  if (configPath === undefined) return;

  let instances;
  try {
    instances = await discoverFgjInstances(exec, cwd, configPath ?? undefined);
  } catch (error) {
    ui.notify(
      `${errorMessage(error)}. Sign in with 'fgj auth login' or choose the API-token option.`,
      "warning",
    );
    return;
  }

  let added = 0;
  for (const instance of instances) {
    const existing = Object.entries(servers).find(
      ([, server]) => server.hostname === instance.hostname,
    );
    if (existing) {
      const [alias, server] = existing;
      const replace = `Use discovered fgj credentials for '${alias}'`;
      const choice = await ui.select(
        `Forgejo setup · Discovered ${instance.hostname}\nSigned in as ${instance.user}. This host is already configured with '${server.credentialProvider}'.`,
        [`Keep existing '${alias}'`, replace, "Stop discovery"],
      );
      if (choice === "Stop discovery" || choice === undefined) break;
      if (choice !== replace) continue;
      const customHosts = extraRemoteHosts(server);
      const raw: Record<string, unknown> = {
        baseUrl: server.baseUrl,
        hostname: instance.hostname,
        credentialProvider: "fgj",
        remoteHosts: customHosts,
      };
      if (configPath) raw.fgjConfig = configPath;
      servers[alias] = normalizeServer(alias, raw);
      added += 1;
      continue;
    }

    const add = "Add this Forgejo server";
    const choice = await ui.select(
      `Forgejo setup · Discovered ${instance.hostname}\nSigned in as ${instance.user}. Add this instance to Pi?`,
      [add, "Skip this server", "Stop discovery"],
    );
    if (choice === "Stop discovery" || choice === undefined) break;
    if (choice !== add) continue;

    const alias = await promptAlias(ui, instance.hostname, servers);
    if (!alias) continue;
    const initialRaw: Record<string, unknown> = {
      hostname: instance.hostname,
      credentialProvider: "fgj",
    };
    if (configPath) initialRaw.fgjConfig = configPath;
    const initial = normalizeServer(alias, initialRaw);
    const remoteHosts = await promptRemoteHosts(ui, initial);
    if (remoteHosts === undefined) continue;
    servers[alias] = normalizeServer(alias, { ...initialRaw, remoteHosts });
    added += 1;
  }
  ui.notify(
    added > 0
      ? `Added or updated ${added} fgj-backed Forgejo server${added === 1 ? "" : "s"}.`
      : "No discovered servers were added.",
    added > 0 ? "info" : "warning",
  );
}

function validateBaseUrl(value: string): string | undefined {
  try {
    normalizeServer("setup", {
      baseUrl: value,
      credentialProvider: "env",
      tokenEnv: "FORGEJO_SETUP_TOKEN",
    });
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function validateTokenEnv(value: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    ? undefined
    : "Environment variable must begin with a letter or underscore and contain only letters, numbers, or underscores.";
}

async function acceptMissingTokenVariable(
  ui: SetupUI,
  variable: string,
): Promise<"keep" | "change" | "back"> {
  const keep = `Keep '${variable}' — I will export it before restarting Pi`;
  const change = "Choose a different environment variable";
  const choice = await ui.select(
    `Forgejo setup · Token variable is not set\n${variable} is not available in this Pi process. The token itself will never be saved in JSON.`,
    [keep, change, "Back"],
  );
  if (choice === keep) return "keep";
  if (choice === change) return "change";
  return "back";
}

async function promptTokenEnv(
  ui: SetupUI,
  alias: string,
  environment: NodeJS.ProcessEnv,
  current?: string,
): Promise<string | undefined> {
  const fallback =
    current ?? `FORGEJO_${alias.toUpperCase().replace(/-/g, "_")}_TOKEN`;
  for (; ;) {
    const variable = await promptValue(
      ui,
      `Forgejo setup · API token environment variable\nPress Enter to use '${fallback}'. Only this variable name is written to JSON.`,
      fallback,
      fallback,
      validateTokenEnv,
    );
    if (!variable) return undefined;
    if (environment[variable]?.trim()) return variable;
    const decision = await acceptMissingTokenVariable(ui, variable);
    if (decision === "keep") return variable;
    if (decision === "back") return undefined;
  }
}

async function addEnvironmentServer(
  ui: SetupUI,
  environment: NodeJS.ProcessEnv,
  servers: Record<string, ForgejoServerConfig>,
): Promise<void> {
  const baseUrl = await promptValue(
    ui,
    "Forgejo setup · Server URL\nEnter the Forgejo web URL, including any installation subpath.",
    "https://forgejo.example.com",
    undefined,
    validateBaseUrl,
  );
  if (!baseUrl) return;
  let normalizedUrl: URL;
  try {
    normalizedUrl = new URL(baseUrl);
  } catch {
    ui.notify("Enter a valid absolute Forgejo URL.", "warning");
    return;
  }
  const alias = await promptAlias(ui, normalizedUrl.host, servers);
  if (!alias) return;
  const tokenEnv = await promptTokenEnv(ui, alias, environment);
  if (!tokenEnv) return;
  const initialRaw = { baseUrl, credentialProvider: "env", tokenEnv } as const;
  const initial = normalizeServer(alias, initialRaw);
  const remoteHosts = await promptRemoteHosts(ui, initial);
  if (remoteHosts === undefined) return;
  servers[alias] = normalizeServer(alias, { ...initialRaw, remoteHosts });
  ui.notify(`Added '${alias}' using token variable ${tokenEnv}.`, "info");
}

async function editEnvironmentServer(
  ui: SetupUI,
  environment: NodeJS.ProcessEnv,
  alias: string,
  current: ForgejoServerConfig,
): Promise<ForgejoServerConfig | undefined> {
  const baseUrl = await promptValue(
    ui,
    `Forgejo setup · ${alias} · Server URL\nPress Enter to keep '${current.baseUrl}'.`,
    current.baseUrl,
    current.baseUrl,
    validateBaseUrl,
  );
  if (!baseUrl) return undefined;
  const tokenEnv = await promptTokenEnv(
    ui,
    alias,
    environment,
    current.tokenEnv,
  );
  if (!tokenEnv) return undefined;
  const raw = { baseUrl, credentialProvider: "env", tokenEnv } as const;
  const initial = normalizeServer(alias, {
    ...raw,
    remoteHosts: extraRemoteHosts(current),
  });
  const remoteHosts = await promptRemoteHosts(ui, initial);
  return remoteHosts === undefined
    ? undefined
    : normalizeServer(alias, { ...raw, remoteHosts });
}

async function editFgjServer(
  ui: SetupUI,
  alias: string,
  current: ForgejoServerConfig,
): Promise<ForgejoServerConfig | undefined> {
  const baseUrl = await promptValue(
    ui,
    `Forgejo setup · ${alias} · Server URL\nPress Enter to keep '${current.baseUrl}'.`,
    current.baseUrl,
    current.baseUrl,
    validateBaseUrl,
  );
  if (!baseUrl) return undefined;
  const hostname = await promptValue(
    ui,
    `Forgejo setup · ${alias} · fgj hostname\nPress Enter to keep '${current.hostname}'.`,
    current.hostname,
    current.hostname,
    (value) => {
      try {
        normalizeServer(alias, {
          baseUrl,
          hostname: value,
          credentialProvider: "fgj",
        });
        return undefined;
      } catch (error) {
        return errorMessage(error);
      }
    },
  );
  if (!hostname) return undefined;
  const fgjConfig = await chooseFgjConfig(ui, current.fgjConfig);
  if (fgjConfig === undefined) return undefined;
  const raw: Record<string, unknown> = {
    baseUrl,
    hostname,
    credentialProvider: "fgj",
  };
  if (fgjConfig) raw.fgjConfig = fgjConfig;
  const initial = normalizeServer(alias, {
    ...raw,
    remoteHosts: extraRemoteHosts(current),
  });
  const remoteHosts = await promptRemoteHosts(ui, initial);
  return remoteHosts === undefined
    ? undefined
    : normalizeServer(alias, { ...raw, remoteHosts });
}

function serverOption(alias: string, server: ForgejoServerConfig): string {
  const credentials =
    server.credentialProvider === "env"
      ? `token env ${server.tokenEnv}`
      : "fgj credential store";
  return `${alias} — ${server.baseUrl} — ${credentials}`;
}

async function selectServer(
  ui: SetupUI,
  title: string,
  servers: Record<string, ForgejoServerConfig>,
): Promise<string | undefined> {
  const entries = Object.entries(servers);
  const options = entries.map(([alias, server]) => serverOption(alias, server));
  const selected = await ui.select(title, options);
  const index = selected === undefined ? -1 : options.indexOf(selected);
  return index >= 0 ? entries[index]?.[0] : undefined;
}

async function editServer(
  ui: SetupUI,
  environment: NodeJS.ProcessEnv,
  servers: Record<string, ForgejoServerConfig>,
): Promise<void> {
  const alias = await selectServer(
    ui,
    "Forgejo setup · Choose a server to reconfigure",
    servers,
  );
  if (!alias) return;
  const current = servers[alias];
  if (!current) return;
  const updated =
    current.credentialProvider === "env"
      ? await editEnvironmentServer(ui, environment, alias, current)
      : await editFgjServer(ui, alias, current);
  if (!updated) return;
  servers[alias] = updated;
  ui.notify(`Updated Forgejo server '${alias}'.`, "info");
}

async function removeServer(
  ui: SetupUI,
  servers: Record<string, ForgejoServerConfig>,
): Promise<void> {
  const alias = await selectServer(
    ui,
    "Forgejo setup · Choose a server to remove",
    servers,
  );
  if (!alias) return;
  const confirmed = await ui.confirm(
    "Remove Forgejo server?",
    `Remove '${alias}' from this configuration?\nNo remote data or token is deleted.`,
  );
  if (!confirmed) return;
  delete servers[alias];
  ui.notify(`Removed Forgejo server '${alias}' from the draft.`, "info");
}

function serverMenuSummary(
  servers: Record<string, ForgejoServerConfig>,
): string {
  const entries = Object.entries(servers);
  if (entries.length === 0) return "No servers configured yet.";
  return entries
    .map(([alias, server]) => `• ${serverOption(alias, server)}`)
    .join("\n");
}

async function configureServers(
  ui: SetupUI,
  exec: CommandExecutor,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  servers: Record<string, ForgejoServerConfig>,
): Promise<boolean> {
  for (; ;) {
    const count = Object.keys(servers).length;
    const options = [
      ...(count > 0 ? [CONTINUE_SERVERS] : []),
      DISCOVER_FGJ,
      ADD_ENV,
      ...(count > 0 ? [EDIT_SERVER, REMOVE_SERVER] : []),
      CANCEL_SETUP,
    ];
    const choice = await ui.select(
      `Forgejo setup · 2/4 · Servers\n${serverMenuSummary(servers)}\n\nConfigure every Forgejo instance Pi should recognize.`,
      options,
    );
    if (choice === CONTINUE_SERVERS) return true;
    if (choice === DISCOVER_FGJ) await discoverServers(ui, exec, cwd, servers);
    else if (choice === ADD_ENV)
      await addEnvironmentServer(ui, environment, servers);
    else if (choice === EDIT_SERVER) await editServer(ui, environment, servers);
    else if (choice === REMOVE_SERVER) await removeServer(ui, servers);
    else return false;
  }
}

async function configureToolMode(
  ui: SetupUI,
  current: ToolsConfig,
  allowKeep: boolean,
): Promise<ToolsConfig | undefined> {
  const keep = `Keep current — ${current.mode}`;
  const full = "Full — activated domains stay for the session";
  const lite =
    "Lite — each activation swaps out other Forgejo domains (smaller model context)";
  const choice = await ui.select(
    "Forgejo setup · Tool activation\nChoose how the forgejo_tools loader activates Forgejo tool domains.",
    [...(allowKeep ? [keep] : []), full, lite],
  );
  if (choice === full) return { mode: "full" as ToolMode };
  if (choice === lite) return { mode: "lite" as ToolMode };
  if (allowKeep && choice === keep) return { ...current };
  return undefined;
}

function setupSummary(
  target: string,
  draft: SetupDraft,
  environment: NodeJS.ProcessEnv,
): string {
  const servers = Object.entries(draft.servers).map(([alias, server]) => {
    const credential =
      server.credentialProvider === "fgj"
        ? `fgj${server.fgjConfig ? ` (${server.fgjConfig})` : ""}`
        : `${server.tokenEnv} ${server.tokenEnv && environment[server.tokenEnv]?.trim() ? "is set" : "must be exported"}`;
    const extras = extraRemoteHosts(server);
    return `• ${alias}: ${server.baseUrl} · ${credential}${extras.length > 0 ? ` · SSH aliases ${extras.join(", ")}` : ""}`;
  });
  return [
    "Forgejo setup · 4/4 · Review",
    `Path: ${target}`,
    "",
    `Servers (${servers.length}):`,
    ...servers,
    "",
    `Tools: ${draft.tools.mode} activation`,
    ...(draft.allowedMutations.length > 0
      ? [`Saved mutation approvals: ${draft.allowedMutations.length}`]
      : []),
    "",
    "Security: token values are never written; only environment variable names are saved.",
  ].join("\n");
}

export { writeForgejoConfigAtomic } from "./config-storage.js";

export async function runForgejoSetup(
  options: ForgejoSetupOptions,
): Promise<ForgejoSetupResult | undefined> {
  const { args, cwd, ui, exec } = options;
  const environment = options.environment ?? process.env;
  options.onStage?.("scope", 1, 4);
  const scope = await selectScope(args, ui);
  if (!scope) return undefined;
  const paths = configPaths(cwd, environment);
  const target = scope === "project" ? paths.project : paths.global;
  const originalText = await readConfigTextIfPresent(target);
  const prepared = await prepareDraft(
    ui,
    target,
    originalText,
    scope === "global",
  );
  if (!prepared) return undefined;
  const draft = prepared.draft;

  for (; ;) {
    options.onStage?.("servers", 2, 4);
    const proceed = await configureServers(
      ui,
      exec,
      cwd,
      environment,
      draft.servers,
    );
    if (!proceed) return undefined;

    options.onStage?.("tools", 3, 4);
    const tools = await configureToolMode(ui, draft.tools, prepared.keptExisting);
    if (!tools) continue;
    draft.tools = tools;

    for (; ;) {
      options.onStage?.("review", 4, 4);
      const choice = await ui.select(setupSummary(target, draft, environment), [
        WRITE_CONFIG,
        CHANGE_TOOLS,
        CHANGE_SERVERS,
        CANCEL_SETUP,
      ]);
      if (choice === CHANGE_TOOLS) {
        options.onStage?.("tools", 3, 4);
        const changed = await configureToolMode(ui, draft.tools, true);
        if (changed) draft.tools = changed;
        continue;
      }
      const validated = parseConfig({
        servers: draft.servers,
        tools: draft.tools,
        ...(scope === "global" && draft.allowedMutations.length > 0
          ? { allowedMutations: draft.allowedMutations }
          : {}),
      });
      await writeForgejoConfigAtomic(
        target,
        { ...draft.extras, ...validated },
        originalText,
      );
      return { scope, target, config: validated };
    }
  }
}
