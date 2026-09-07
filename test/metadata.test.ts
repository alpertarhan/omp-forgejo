import { describe, expect, it, vi } from "vitest";
import type { ForgejoClient, RequestOptions } from "../src/client.js";
import { labelIds, normalizedDueDate } from "../src/tools/metadata.js";
import type { ForgejoLabel } from "../src/types.js";

function labels(start: number, count: number): ForgejoLabel[] {
  return Array.from({ length: count }, (_, index) => ({
    id: start + index,
    name: `label-${start + index}`,
    color: "ffffff",
  }));
}

describe("label metadata pagination", () => {
  it("continues when Forgejo clamps the requested label page size", async () => {
    const request = vi.fn(async (_path: string, options?: RequestOptions) => ({
      data:
        options?.query?.page === 2
          ? [{ id: 101, name: "security", color: "ff0000" }]
          : labels(1, 50),
      status: 200,
      headers: new Headers(),
    }));

    await expect(
      labelIds({ request } as unknown as ForgejoClient, "acme", "app", [
        "security",
        "label-2",
      ]),
    ).resolves.toEqual([101, 2]);
    expect(request.mock.calls.map((call) => call[1]?.query?.page)).toEqual([
      1, 2,
    ]);
  });
});

describe("due date normalization", () => {
  it("keeps whole-second timestamps and floors sub-second input", () => {
    expect(normalizedDueDate("2026-09-10T15:00:00Z")).toBe(
      "2026-09-10T15:00:00.000Z",
    );
    expect(normalizedDueDate("2026-09-10T15:00:00.987Z")).toBe(
      "2026-09-10T15:00:00.000Z",
    );
    expect(normalizedDueDate("2026-09-10T18:00:00.400+03:00")).toBe(
      "2026-09-10T15:00:00.000Z",
    );
  });

  it("rejects timestamps without a timezone or with invalid dates", () => {
    expect(() => normalizedDueDate("2026-09-10T15:00:00")).toThrow(
      "RFC 3339 timestamp with a timezone",
    );
    expect(() => normalizedDueDate("not-a-date")).toThrow(
      "RFC 3339 timestamp with a timezone",
    );
    expect(() => normalizedDueDate("2026-13-40T15:00:00Z")).toThrow(
      "valid RFC 3339",
    );
  });
});
