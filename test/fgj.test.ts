import { describe, expect, it, vi } from "vitest";
import { discoverFgjInstances, parseFgjAuthStatus, suggestServerAlias } from "../src/fgj.js";
import type { CommandExecutor } from "../src/process.js";

describe("fgj instance discovery", () => {
  it("parses authenticated instances from fgj output", () => {
    const output = [
      "Authenticated instances:",
      "",
      "  \u001b[32m•\u001b[0m git.acme.example (user: alice)",
      "  • git.community.example (user: release-bot)",
    ].join("\n");

    expect(parseFgjAuthStatus(output)).toEqual([
      { hostname: "git.acme.example", user: "alice" },
      { hostname: "git.community.example", user: "release-bot" },
    ]);
  });

  it("uses fgj auth status and never requests token output during discovery", async () => {
    const exec = vi.fn<CommandExecutor>(async () => ({
      code: 0,
      stdout: "Authenticated instances:\n\n  • git.example.dev (user: alice)\n",
      stderr: "",
    }));

    await expect(discoverFgjInstances(exec, "/workspace", "/tmp/fgj.yaml")).resolves.toEqual([
      { hostname: "git.example.dev", user: "alice" },
    ]);
    expect(exec).toHaveBeenCalledWith("fgj", ["--config", "/tmp/fgj.yaml", "auth", "status"], {
      cwd: "/workspace",
      timeout: 10_000,
    });
  });

  it("suggests deterministic aliases from hostnames", () => {
    expect(suggestServerAlias("git.acme.example")).toBe("acme");
    expect(suggestServerAlias("code.community.example")).toBe("community");
    expect(suggestServerAlias("forgejo.example")).toBe("forgejo");
    expect(suggestServerAlias("codeberg.org")).toBe("codeberg");
    expect(suggestServerAlias("git.internal.example:3000")).toBe("internal");
    expect(suggestServerAlias("---")).toBe("forgejo");
  });
});
