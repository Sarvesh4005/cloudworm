import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi } from "./api";
import { safeFileName } from "./download";
import { describeError } from "./errors";
import { formatBytes, formatHoursOption, formatTimeLeft } from "./format";
import { addToHistory, loadHistory, removeFromHistory, shareLink } from "./history";

describe("format", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
  });
  it("formats expiry options and time left", () => {
    expect(formatHoursOption(1)).toBe("1 hour");
    expect(formatHoursOption(24)).toBe("1 day");
    expect(formatHoursOption(168)).toBe("7 days");
    const now = 1_000_000_000_000;
    expect(formatTimeLeft(now / 1000 - 1, now)).toBe("expired");
    expect(formatTimeLeft(now / 1000 + 3 * 3600 + 5, now)).toBe("in 3 hours");
    expect(formatTimeLeft(now / 1000 + 5 * 86400, now)).toBe("in 5 days");
  });
});

describe("api client", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("maps server error envelopes to ApiError", async () => {
    const fetchImpl = vi.fn(async () => json(410, { error: { code: "transfer_expired", message: "gone" } }));
    const api = createApi("https://api.test/", fetchImpl as unknown as typeof fetch);
    await expect(api.getTransfer("x".repeat(22))).rejects.toMatchObject({ status: 410, code: "transfer_expired" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.test/transfers/xxxxxxxxxxxxxxxxxxxxxx", expect.anything());
  });

  it("maps network failures and throttling", async () => {
    const down = createApi("https://api.test", (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch);
    await expect(down.getConfig()).rejects.toMatchObject({ code: "network_error" });
    const busy = createApi("https://api.test", (async () => new Response("Too Many", { status: 429 })) as unknown as typeof fetch);
    await expect(busy.getConfig()).rejects.toMatchObject({ code: "throttled" });
  });

  it("sends the owner token only as a header", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => json(200, { status: "deleted" }));
    const api = createApi("https://api.test", fetchImpl as unknown as typeof fetch);
    await api.deleteTransfer("a".repeat(22), "secret-token");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("secret-token");
    expect((init.headers as Record<string, string>)["x-owner-token"]).toBe("secret-token");
    expect(init.credentials).toBe("omit");
  });

  it("refuses to run without a configured base URL", async () => {
    await expect(createApi("").getConfig()).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("errors", () => {
  it("gives friendly messages for known codes", () => {
    expect(describeError(new ApiError(410, "transfer_expired", "x")).title).toMatch(/expired/);
    expect(describeError(new ApiError(404, "transfer_not_found", "x")).title).toMatch(/not found/);
    expect(describeError(new ApiError(418, "teapot", "short and stout")).detail).toBe("short and stout");
  });
});

describe("history & links", () => {
  it("stores, prunes expired entries and removes", () => {
    localStorage.clear();
    const base = { key: "k", ownerToken: "o", createdAt: 0, fileCount: 1, totalBytes: 1, label: "a" };
    addToHistory({ ...base, transferId: "live", expiresAt: Date.now() / 1000 + 3600 });
    addToHistory({ ...base, transferId: "old", expiresAt: Date.now() / 1000 - 10 });
    expect(loadHistory().map((t) => t.transferId)).toEqual(["live"]);
    removeFromHistory("live");
    expect(loadHistory()).toEqual([]);
  });
  it("puts the key in the fragment, never the path or query", () => {
    expect(shareLink("ID", "KEY", "https://x.test")).toBe("https://x.test/t/ID#KEY");
  });
  it("sanitises untrusted file names", () => {
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName("a\u0000b:c.txt")).toBe("a_b_c.txt");
    expect(safeFileName("...")).toBe("download");
  });
});
