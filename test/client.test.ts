import { setTimeout } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ForgejoClient,
  ForgejoError,
  paginationComplete,
  USER_AGENT,
} from "../src/client.js";

const SERVER = {
  baseUrl: "https://forgejo.example/internal",
  hostname: "forgejo.example",
  credentialProvider: "env" as const,
  tokenEnv: "FORGEJO_TOKEN",
  remoteHosts: ["forgejo.example"],
};

describe("ForgejoClient", () => {
  it("keeps the HTTP user agent aligned with the package version", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(USER_AGENT).toBe(`omp-forgejo/${packageJson.version}`);
  });

  it("recognizes Link, total-count, and empty-page pagination completion", () => {
    expect(
      paginationComplete(
        {
          data: [1],
          status: 200,
          headers: new Headers({
            link: '<https://forgejo.example?page=2>; rel="next"',
          }),
        },
        1,
      ),
    ).toBe(false);
    expect(
      paginationComplete(
        { data: [1], status: 200, headers: new Headers(), totalCount: 2 },
        1,
      ),
    ).toBe(false);
    expect(
      paginationComplete(
        {
          data: [1],
          status: 200,
          headers: new Headers({
            link: '<https://forgejo.example?page=2>; rel=nextpage',
          }),
        },
        1,
      ),
    ).toBe(true);
    expect(
      paginationComplete({ data: [], status: 200, headers: new Headers() }, 1),
    ).toBe(true);
  });
  it("uses the subpath API URL, authorization header, and pagination metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "https://forgejo.example/internal/api/v1/repos/issues/search?state=open&status-types=unread&status-types=pinned",
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("token secret-value");
      expect(init?.redirect).toBe("manual");
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json", "x-total-count": "42" },
      });
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });
    const result = await client.request<unknown[]>("repos/issues/search", {
      query: { state: "open", "status-types": ["unread", "pinned"] },
    });
    expect(result.data).toEqual([]);
    expect(result.totalCount).toBe(42);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts token values from HTTP errors", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('{"message":"token secret-value was rejected"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });
    await expect(client.request("user")).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(ForgejoError);
      expect((error as ForgejoError).code).toBe("auth");
      expect((error as Error).message).toContain("[REDACTED]");
      expect((error as Error).message).not.toContain("secret-value");
      return true;
    });
  });

  it("never forwards credentials outside the configured API root", async () => {
    for (const location of [
      "https://attacker.example/capture",
      "https://forgejo.example/other-service/capture",
    ]) {
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 302, headers: { location } }),
      );
      const client = new ForgejoClient("work", SERVER, {
        environment: { FORGEJO_TOKEN: "secret-value" },
        fetchImpl: fetchMock,
      });
      await expect(client.request("user")).rejects.toMatchObject({
        code: "redirect",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it("parses default JSON responses even when Content-Type is missing", async () => {
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: vi.fn<typeof fetch>(
        async () => new Response('{"login":"alice"}'),
      ),
    });
    await expect(
      client.request<{ login: string }>("user"),
    ).resolves.toMatchObject({ data: { login: "alice" } });
  });

  it("does not follow redirects for mutations", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 307,
          headers: {
            location: "https://forgejo.example/internal/api/v1/issues/2",
          },
        }),
    );
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });
    await expect(
      client.request("issues/1", {
        method: "PATCH",
        body: { state: "closed" },
      }),
    ).rejects.toMatchObject({
      code: "redirect",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["11.0.0", "unavailable"],
    ["12.0.0", "available"],
    ["development", "unknown"],
  ] as const)(
    "detects Actions runs support for Forgejo %s",
    async (version, expected) => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith("/version")) {
          return new Response(JSON.stringify({ version }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname.endsWith("/user")) {
          return new Response(JSON.stringify({ id: 7, login: "alice" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname.endsWith("/settings/api")) {
          return new Response(JSON.stringify({ default_paging_num: 30 }), {
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected request: ${pathname}`);
      });
      const client = new ForgejoClient("work", SERVER, {
        environment: { FORGEJO_TOKEN: "secret-value" },
        fetchImpl: fetchMock,
      });

      await expect(client.discoverCapabilities()).resolves.toMatchObject({
        version,
        features: { actionsRuns: expected },
      });
    },
  );

  it("applies per-feature Actions version fallbacks when Swagger is unreachable", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith("/version")) {
        return new Response(JSON.stringify({ version: "13.0.1" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname.endsWith("/user")) {
        return new Response(JSON.stringify({ id: 7, login: "alice" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname.endsWith("/settings/api")) {
        return new Response(JSON.stringify({}), {
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname.endsWith("swagger.v1.json")) {
        return new Response("not found", { status: 404 });
      }
      throw new Error(`unexpected request: ${pathname}`);
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });

    // Dispatch shipped in Forgejo v8, run list/get in v12, and cancel plus
    // artifacts (and job logs) only in v16; rerun has no fallback.
    await expect(client.discoverCapabilities()).resolves.toMatchObject({
      features: {
        actionsRuns: "available",
        actionsDispatch: "available",
        actionsCancel: "unavailable",
        actionsRerun: "unknown",
        actionsArtifacts: "unavailable",
      },
    });
  });

  it("discovers individual Actions routes from same-origin Swagger without sending credentials", async () => {
    const paths = {
      "/repos/{owner}/{repo}/actions/runs": {},
      "/repos/{owner}/{repo}/actions/workflows/{workflowfilename}/dispatches":
      {},
      "/repos/{owner}/{repo}/actions/runs/{run_id}/cancel": {},
      "/repos/{owner}/{repo}/actions/artifacts": {},
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/internal/swagger.v1.json") {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        expect(init?.signal).toBeDefined();
        return new Response(JSON.stringify({ paths }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname.endsWith("/version")) {
        return new Response(JSON.stringify({ version: "16.0.2" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname.endsWith("/user")) {
        return new Response(JSON.stringify({ id: 7, login: "alice" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname.endsWith("/settings/api")) {
        return new Response(JSON.stringify({ default_paging_num: 30 }), {
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request: ${pathname}`);
    });
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });

    await expect(client.discoverCapabilities()).resolves.toMatchObject({
      features: {
        actionsRuns: "available",
        actionsDispatch: "available",
        actionsCancel: "available",
        actionsRerun: "unavailable",
        actionsArtifacts: "available",
      },
    });
  });

  it("truncates text responses during streaming at a UTF-8 byte limit", async () => {
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response("ééé", { headers: { "content-type": "text/plain" } }),
      ),
    });
    await expect(
      client.request<string>("repos/acme/app/pulls/1.diff", {
        accept: "text/plain",
        maxResponseBytes: 4,
        truncateResponse: true,
      }),
    ).resolves.toMatchObject({ data: "éé", truncated: true });
    const splitCodePoint = await client.request<string>(
      "repos/acme/app/pulls/1.diff",
      { accept: "text/plain", maxResponseBytes: 3, truncateResponse: true },
    );
    expect(splitCodePoint).toMatchObject({ data: "é", truncated: true });
    expect(Buffer.byteLength(splitCodePoint.data, "utf8")).toBeLessThanOrEqual(
      3,
    );

    const invalidUtf8 = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: vi.fn<typeof fetch>(
        async () =>
          new Response(new Uint8Array([0xff, 0x61]), {
            headers: { "content-type": "text/plain" },
          }),
      ),
    });
    const invalid = await invalidUtf8.request<string>(
      "repos/acme/app/pulls/1.diff",
      {
        accept: "text/plain",
        maxResponseBytes: 1,
        truncateResponse: true,
      },
    );
    expect(Buffer.byteLength(invalid.data, "utf8")).toBeLessThanOrEqual(1);
  });

  it("rejects an unbounded binary response once it crosses the caller limit", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4, 5]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });

    await expect(
      client.request<Uint8Array>("repos/acme/app/archive", {
        accept: "application/octet-stream",
        responseType: "bytes",
        maxResponseBytes: 4,
      }),
    ).rejects.toThrow("response exceeds the 4 byte limit");
  });

  it("retries once with a fresh fgj token after a 401", async () => {
    let cleared = false;
    const provider = {
      kind: "fgj" as const,
      getToken: async () => (cleared ? "fresh-token" : "stale-token"),
      clear: () => {
        cleared = true;
      },
    };
    const tokens: Array<string | null> = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      tokens.push(new Headers(init?.headers).get("authorization"));
      if (!cleared)
        return new Response('{"message":"token was revoked"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return new Response('{"login":"alice"}', {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new ForgejoClient("work", SERVER, {
      credentialProvider: provider,
      fetchImpl: fetchMock,
    });

    await expect(
      client.request<{ login: string }>("user"),
    ).resolves.toMatchObject({ data: { login: "alice" } });
    expect(tokens).toEqual(["token stale-token", "token fresh-token"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry an env-provider 401", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response('{"message":"bad credentials"}', {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new ForgejoClient("work", SERVER, {
      environment: { FORGEJO_TOKEN: "secret-value" },
      fetchImpl: fetchMock,
    });

    await expect(client.request("user")).rejects.toMatchObject({ code: "auth" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("starts the request timeout only after credentials resolve", async () => {
    // AbortSignal.timeout is a native platform timer that fake timers cannot
    // control, so this test deliberately spends a real delay: the credential
    // source must outlast timeoutMs to prove the timer no longer covers it.
    const provider = {
      kind: "env" as const,
      getToken: async () => {
        await setTimeout(150);
        return "secret-value";
      },
      clear: () => undefined,
    };
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(false);
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new ForgejoClient("work", SERVER, {
      credentialProvider: provider,
      fetchImpl: fetchMock,
    });

    await expect(
      client.request("user", { timeoutMs: 100 }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
