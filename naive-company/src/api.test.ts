import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiGet, apiMessage, apiSend } from "./api";

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("failure is reported, never replaced", () => {
  it("throws the server's own sentence, with its status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "not configured — set NAIVE_API_KEY" }, 503)));
    // The old contract answered a caller-supplied fallback here — and the fallbacks were the seed
    // rows, so an unwired dashboard showed a fictional agency as the operator's own CRM.
    await expect(apiGet("/agents")).rejects.toThrow("not configured — set NAIVE_API_KEY");
    await expect(apiGet("/agents")).rejects.toMatchObject({ status: 503 });
  });

  it("says the server is unreachable when the fetch fails or the answer is not this server's", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no server")));
    await expect(apiGet("/clients")).rejects.toThrow("the dashboard server is unreachable");

    // The SPA fallback serving index.html for a missing function is the exact production shape.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>", { status: 200 })));
    await expect(apiGet("/clients")).rejects.toThrow("the dashboard server is unreachable");
  });

  it("throws on a send too, so a screen never shows a move the server refused", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "no such post" }, 404)));
    await expect(apiSend("PATCH", "/posts/post_1", { status: "approved" })).rejects.toMatchObject({
      status: 404,
      message: "no such post",
    });
  });

  it("apiMessage reads an ApiError and anything else alike", () => {
    expect(apiMessage(new ApiError(404, "no such route"))).toBe("no such route");
    expect(apiMessage(new TypeError("boom"))).toBe("the dashboard server is unreachable");
  });
});

describe("the happy path", () => {
  it("apiGet returns the server's JSON, and an empty list stays empty", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([{ id: "cli_1" }])));
    expect(await apiGet("/clients")).toEqual([{ id: "cli_1" }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json([])));
    expect(await apiGet("/clients")).toEqual([]);
  });

  it("apiSend posts the body and returns the server's JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: "post_1", status: "approved" }));
    vi.stubGlobal("fetch", fetchImpl);
    expect(await apiSend("PATCH", "/posts/post_1", { status: "approved" })).toEqual({ id: "post_1", status: "approved" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/posts/post_1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ status: "approved" }),
    }));
  });
});

/**
 * `/api/*` is gated by the app's `DASHBOARD_TOKEN` — without it the deployed dashboard hands the
 * CRM, the agent roster and the content queue to anyone who finds the URL.
 */
/**
 * THE OPERATOR IS NEVER ASKED FOR A CREDENTIAL, BECAUSE THERE IS NO LONGER ONE TO ASK FOR.
 *
 * This module used to keep `DASHBOARD_TOKEN` in `sessionStorage` and prompt for it on a 401. The
 * platform now generates that value (`canonical-spec §29.7`) and no route returns it, so the box
 * was asking a person for something nobody can read: the studio's one click posts a ticket to
 * `/api/enter` and the server answers with an `HttpOnly` cookie the browser sends by itself.
 */
describe("no credential passes through the browser", () => {
  it("never asks for a token and never sends an authorization header", async () => {
    const ask = vi.fn();
    vi.stubGlobal("prompt", ask);
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(json([])));
    vi.stubGlobal("fetch", fetchMock);

    await apiGet("/clients");
    await apiSend("POST", "/clients", { name: "Acme" });

    expect(ask).not.toHaveBeenCalled();
    for (const call of fetchMock.mock.calls) {
      const headers = (call[1] as { headers?: Record<string, string> }).headers ?? {};
      expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("authorization");
    }
  });

  it("surfaces a 401 as the server's own sentence rather than a second prompt", async () => {
    const ask = vi.fn();
    vi.stubGlobal("prompt", ask);
    const fetchMock = vi.fn().mockResolvedValue(json({ error: "missing or invalid access token" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiGet("/clients")).rejects.toMatchObject({ status: 401 });
    // One call, not two: there is no stale token to forget and no retry to make.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ask).not.toHaveBeenCalled();
  });
});
