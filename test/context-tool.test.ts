import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { forgejoToolkitActive } from "../src/extension.js";
import type { ForgejoRuntime } from "../src/runtime.js";
import { registerContextTools } from "../src/tools/context.js";
import type { ForgejoCapabilities } from "../src/types.js";

interface CapturedTool {
  name: string;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: undefined,
    context: ExtensionContext,
  ): Promise<unknown>;
}

describe("forgejo toolkit activation gating", () => {
  it("activates only inside Forgejo repositories with configured servers", () => {
    expect(forgejoToolkitActive(2, "resolved")).toBe(true);
    expect(forgejoToolkitActive(1, "ambiguous")).toBe(true);
    expect(forgejoToolkitActive(3, "none")).toBe(false);
    expect(forgejoToolkitActive(0, "resolved")).toBe(false);
  });
});

describe("forgejo context tool", () => {
  it("reuses cached identity but forces explicit capability rediscovery", async () => {
    const tools: CapturedTool[] = [];
    const api = {
      registerTool(tool: CapturedTool) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;
    const capability: ForgejoCapabilities = {
      server: "work",
      version: "16.0.2",
      user: { id: 1, login: "alice" },
      paging: {},
      features: {
        dashboardSearch: true,
        notifications: true,
        reviews: true,
        actionsRuns: "available",
        actionsDispatch: "available",
        actionsCancel: "available",
        actionsRerun: "available",
        actionsArtifacts: "available",
      },
    };
    const refreshAlias = async () => capability;
    const refreshCalls: Array<[string, AbortSignal, boolean]> = [];
    const runtime = {
      capabilities: {
        refreshAlias: (alias: string, signal: AbortSignal, force: boolean) => {
          refreshCalls.push([alias, signal, force]);
          return refreshAlias();
        },
        snapshot: () => ({ values: { work: capability }, errors: {} }),
      },
    } as unknown as ForgejoRuntime;
    registerContextTools(api, () => runtime);
    const context = tools.find((tool) => tool.name === "forgejo_context");
    if (!context) throw new Error("context tool was not registered");
    const signal = new AbortController().signal;

    await context.execute(
      "whoami",
      { action: "whoami", server: "work" },
      signal,
      undefined,
      { hasUI: false } as ExtensionContext,
    );
    expect(refreshCalls.at(-1)).toEqual(["work", signal, false]);

    await context.execute(
      "capabilities",
      { action: "capabilities", server: "work" },
      signal,
      undefined,
      { hasUI: false } as ExtensionContext,
    );
    expect(refreshCalls.at(-1)).toEqual(["work", signal, true]);
  });

  it("resolves repository refs alongside issue and pull references", async () => {
    const tools: CapturedTool[] = [];
    const api = {
      registerTool(tool: CapturedTool) {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;
    const clients = {
      aliases: () => ["work"],
      get: (alias: string) => {
        if (alias !== "work") throw new Error(`unknown server '${alias}'`);
      },
    };
    const runtime = {
      clients,
      client: (alias: string) => {
        if (alias !== "work") throw new Error(`unknown server '${alias}'`);
      },
    } as unknown as ForgejoRuntime;
    registerContextTools(api, () => runtime);
    const context = tools.find((tool) => tool.name === "forgejo_context");
    if (!context) throw new Error("context tool was not registered");
    const signal = new AbortController().signal;
    const ctx = { hasUI: false } as ExtensionContext;
    const repo = (await context.execute(
      "resolve-repo",
      { action: "resolve_ref", ref: "work:platform/api" },
      signal,
      undefined,
      ctx,
    )) as { content: Array<{ text: string }> };
    expect(repo.content[0]?.text).toBe(
      "work:platform/api -> fj://work/platform/api",
    );

    const pull = (await context.execute(
      "resolve-pull",
      { action: "resolve_ref", ref: "work:platform/api!9" },
      signal,
      undefined,
      ctx,
    )) as { content: Array<{ text: string }> };
    expect(pull.content[0]?.text).toBe(
      "work:platform/api!9 -> fj://work/platform/api/pulls/9",
    );

    await expect(
      context.execute(
        "resolve-tag",
        { action: "resolve_ref", ref: "v1.2.3" },
        signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("invalid Forgejo reference 'v1.2.3'");
  });
});
