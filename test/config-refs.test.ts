import { ForgejoClient, ForgejoClientPool } from "../src/client.js";
import { CapabilityRegistry } from "../src/capabilities.js";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";
import { ForgejoRuntime } from "../src/runtime.js";
import {
  formatCanonicalRepoRef,
  formatCanonicalRef,
  formatRepoRef,
  formatResourceRef,
  parseRepoRef,
  parseResourceRef,
} from "../src/refs.js";

const BASE_CONFIG = {
  servers: {
    work: {
      baseUrl: "https://forgejo.work.example/",
      tokenEnv: "FORGEJO_WORK_TOKEN",
      remoteHosts: ["forgejo-work"],
    },
  },
};

describe("Forgejo configuration", () => {
  it("normalizes servers and applies safe tool defaults", () => {
    const config = parseConfig(BASE_CONFIG);
    expect(config.servers.work).toEqual({
      baseUrl: "https://forgejo.work.example",
      hostname: "forgejo.work.example",
      credentialProvider: "env",
      tokenEnv: "FORGEJO_WORK_TOKEN",
      remoteHosts: ["forgejo.work.example", "forgejo-work"],
    });
    expect(config.tools).toEqual({ mode: "full" });
  });

  it("parses tools.mode lite and lets trusted projects override it", () => {
    const config = parseConfig(BASE_CONFIG, {
      tools: { mode: "lite" },
    });
    expect(config.tools.mode).toBe("lite");

    expect(() =>
      parseConfig(BASE_CONFIG, { tools: { mode: "turbo" } }),
    ).toThrow(ConfigError);
  });

  it("accepts explicit CLI-independent API tokens through the environment provider", () => {
    const config = parseConfig({
      servers: {
        work: {
          hostname: "forgejo.work.example",
          credentialProvider: "env",
          tokenEnv: "FORGEJO_WORK_TOKEN",
        },
      },
    });

    expect(config.servers.work).toMatchObject({
      baseUrl: "https://forgejo.work.example",
      credentialProvider: "env",
      tokenEnv: "FORGEJO_WORK_TOKEN",
    });
  });

  it("merges project overrides without dropping global servers", () => {
    const config = parseConfig(BASE_CONFIG, {
      servers: {
        community: {
          baseUrl: "https://code.example.org/forgejo",
          tokenEnv: "FORGEJO_COMMUNITY_TOKEN",
        },
      },
    });
    expect(Object.keys(config.servers)).toEqual(["work", "community"]);
    expect(config.tools).toEqual({ mode: "full" });
  });

  it("loads normalized mutation approvals from global config only", () => {
    const config = parseConfig(
      {
        ...BASE_CONFIG,
        allowedMutations: [" pull.merge ", "pull.merge"],
      },
      { allowedMutations: ["issue.close"] },
    );
    expect(config.allowedMutations).toEqual(["pull.merge"]);
    expect(parseConfig(BASE_CONFIG)).not.toHaveProperty("allowedMutations");
    expect(() => parseConfig({ ...BASE_CONFIG, allowedMutations: [""] })).toThrow(
      "allowedMutations entries must be non-empty strings",
    );
    expect(() =>
      parseConfig({ ...BASE_CONFIG, allowedMutations: ["unknown"] }),
    ).toThrow("unsupported allowedMutations key: unknown");
  });

  it("rejects inline secrets and unsafe URLs", () => {
    expect(() =>
      parseConfig({
        servers: {
          work: {
            baseUrl: "https://user:secret@forgejo.example",
            tokenEnv: "TOKEN",
            token: "leak",
          },
        },
      }),
    ).toThrow(ConfigError);
  });

  it("rejects known non-Forgejo hosts as servers", () => {
    expect(() =>
      parseConfig({
        servers: {
          work: {
            baseUrl: "https://github.com",
            tokenEnv: "GITHUB_TOKEN",
          },
        },
      }),
    ).toThrow("github.com is not a Forgejo server");
  });

  it("rejects credential fields belonging to another provider", () => {
    expect(() =>
      parseConfig({
        servers: {
          work: {
            hostname: "forgejo.work.example",
            credentialProvider: "env",
            tokenEnv: "FORGEJO_WORK_TOKEN",
            fgjConfig: "/tmp/fgj.yaml",
          },
        },
      }),
    ).toThrow("fgjConfig cannot be used with credentialProvider 'env'");
    expect(() =>
      parseConfig({
        servers: {
          work: {
            hostname: "forgejo.work.example",
            credentialProvider: "fgj",
            tokenEnv: "FORGEJO_WORK_TOKEN",
          },
        },
      }),
    ).toThrow("tokenEnv cannot be used with credentialProvider 'fgj'");
  });
});

describe("Forgejo references", () => {
  it("round-trips qualified issue and pull references", () => {
    const issue = parseResourceRef("work:platform/api#184");
    const pull = parseResourceRef("community:forge/runner!77");
    expect(issue).toEqual({
      server: "work",
      owner: "platform",
      repo: "api",
      kind: "issue",
      index: 184,
    });
    expect(pull).toEqual({
      server: "community",
      owner: "forge",
      repo: "runner",
      kind: "pull",
      index: 77,
    });
    expect(formatResourceRef(issue!)).toBe("work:platform/api#184");
    expect(formatCanonicalRef(pull!)).toBe(
      "fj://community/forge/runner/pulls/77",
    );
  });

  it("parses canonical refs but rejects unqualified numbers", () => {
    expect(parseResourceRef("fj://work/platform/api/issues/12")).toEqual({
      server: "work",
      owner: "platform",
      repo: "api",
      kind: "issue",
      index: 12,
    });
    expect(parseResourceRef("#12")).toBeUndefined();
    expect(parseResourceRef("work:platform/api!0")).toBeUndefined();
    expect(
      parseResourceRef("work:platform/api!9007199254740993"),
    ).toBeUndefined();
    expect(
      parseResourceRef("fj://work/platform/api/pulls/9007199254740993"),
    ).toBeUndefined();
    expect(parseResourceRef("fj://work/%E0%A4%A/api/issues/12")).toBeUndefined();
  });

  it("parses the bare repository form the error hints advertise", () => {
    const repo = parseRepoRef("work:platform/api");
    expect(repo).toEqual({ server: "work", owner: "platform", repo: "api" });
    expect(formatRepoRef(repo!)).toBe("work:platform/api");
    expect(formatCanonicalRepoRef(repo!)).toBe("fj://work/platform/api");
    expect(parseRepoRef("fj://work/platform/api")).toEqual(repo);
    expect(parseRepoRef("work:platform/api#12")).toBeUndefined();
    expect(parseRepoRef("work:platform/api!9")).toBeUndefined();
    expect(parseRepoRef("work:platform")).toBeUndefined();
    expect(parseRepoRef("#12")).toBeUndefined();
    expect(parseRepoRef("fj://work/platform/api/issues/12")).toBeUndefined();
  });
});

describe("runtime repository resolution", () => {
  it("accepts the bare repository ref that the error hints advertise", () => {
    const config = parseConfig(BASE_CONFIG);
    const clients = new ForgejoClientPool({
      work: new ForgejoClient("work", config.servers.work!, {
        environment: {},
      }),
    });
    const runtime = new ForgejoRuntime(
      process.cwd(),
      config,
      clients,
      new CapabilityRegistry(clients),
      { status: "none", reason: "test harness" },
    );

    expect(runtime.resolveRepo({ ref: "work:platform/api" })).toEqual({
      server: "work",
      owner: "platform",
      repo: "api",
    });
    expect(
      runtime.resolveRepo({ ref: "work:platform/api#184" }),
    ).toMatchObject({ owner: "platform", repo: "api" });
    expect(() =>
      runtime.resolveResource({ ref: "work:platform/api" }, "issue"),
    ).toThrow("#N or !N index is required");
    expect(() =>
      runtime.resolveResource({ ref: "work:platform/api#1" }, "pull"),
    ).toThrow("is not a pull");
    expect(() => runtime.resolveRepo({ ref: "v1.2.3" })).toThrow(
      "invalid Forgejo reference 'v1.2.3'",
    );
  });
});

