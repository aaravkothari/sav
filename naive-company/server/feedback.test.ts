/**
 * The after-the-call adapter, with the platform mocked: nothing here wakes a real agent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../seed/clients.ts";
import { CLIENT_MANAGER_ID, feedbackMessage, requestMeetingScript, resetScriptRequests, scriptMessage, submitCallFeedback } from "./feedback.ts";
import type { ProxyConfig } from "./proxy.ts";

const config: ProxyConfig = { baseUrl: "https://platform.test", apiKey: "k_test", identityId: null, project: "p" };

const shop = (): Client => ({
  id: "cli_pat",
  slug: "pats-garage",
  name: "Pat's Garage - Auto Repair in San Mateo",
  domain: "patsgarage.com",
  stage: "proposal",
  services: [],
  contact: { name: "Pat Banks", email: "pat@patsgarage.com", role: "Owner" },
  notes: ["RECEPTIONIST: shop_id pats-garage-sm · demo_url https://x.example/demo/pats-garage-sm · preview", "CALL BOOKED: 2026-11-09 10:00 PT, no calendar"],
});

function platform(status = 201) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: "ses_1" }), { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function store(client: Client) {
  const notes: { id: string; note: string; next?: string }[] = [];
  return {
    notes,
    addNote: (id: string, note: string, next?: string) => {
      if (id !== client.id) return null;
      notes.push({ id, note, next });
      client.notes.push(note);
      return client;
    },
  };
}

const now = new Date("2026-11-09T19:00:00Z");

describe("submitCallFeedback", () => {
  it("(a) files a MEETING FEEDBACK note with readable lines, (b) wakes client-manager, (c) leaves the voice slot unconnected", async () => {
    const c = shop();
    const s = store(c);
    const p = platform();
    const result = await submitCallFeedback(c, { hours: "Sat 9-1", greeting: "Pat's Garage, this is the front desk", fixes: "Do not say we do tires" }, { addNote: s.addNote, config, fetchImpl: p.fetchImpl, now });

    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]!.note).toBe([
      "MEETING FEEDBACK: onboarding call with Pat's Garage, filed 2026-11-09T19:00Z",
      "Hours: Sat 9-1",
      "Greeting: Pat's Garage, this is the front desk",
      "What the receptionist should say differently: Do not say we do tires",
    ].join("\n"));
    expect(s.notes[0]!.next).toMatch(/Onboarding turns the call notes/);

    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.url).toBe("https://platform.test/v1/sessions");
    expect(p.calls[0]!.init.method).toBe("POST");
    expect((p.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer k_test");
    const body = JSON.parse(String(p.calls[0]!.init.body)) as { agent_id: string; message: string };
    expect(body.agent_id).toBe(CLIENT_MANAGER_ID);
    expect(body.message.split("\n").slice(0, 3)).toEqual(["MEETING FEEDBACK: Pat's Garage", "client_id: cli_pat", "shop_id: pats-garage-sm"]);
    expect(body.message).toMatch(/one "RECEPTIONIST CONFIG:" note/);
    expect(body.message).toMatch(/keys hours, services, greeting, booking_rules, handoff/);
    expect(body.message).toContain("Hours: Sat 9-1");
    // Never the owner's contact details.
    expect(body.message).not.toMatch(/pat@patsgarage\.com|Pat Banks/);

    expect(result).toMatchObject({ onboarding: { woke: true }, voice: "not_connected" });
    expect(result!.client.notes.at(-1)).toMatch(/^MEETING FEEDBACK:/);
  });

  it("still files the note when the platform is missing, paused or failing, and says why nothing woke", async () => {
    for (const [deps, reason] of [
      [{ config: null }, /not connected/],
      [{ config, paused: true }, /paused/],
      [{ config, fetchImpl: platform(500).fetchImpl }, /answered 500/],
      [{ config, fetchImpl: (async () => { throw new Error("down"); }) as unknown as typeof fetch }, /could not be reached/],
    ] as const) {
      const c = shop();
      const s = store(c);
      const result = await submitCallFeedback(c, { notes: "x" }, { addNote: s.addNote, now, ...deps });
      expect(s.notes).toHaveLength(1);
      expect(result!.onboarding.woke).toBe(false);
      expect(result!.onboarding.reason).toMatch(reason);
    }
  });

  it("does not wake anyone for a shop the store does not have", async () => {
    const p = platform();
    const result = await submitCallFeedback({ ...shop(), id: "cli_gone" }, { notes: "x" }, { addNote: () => null, config, fetchImpl: p.fetchImpl, now });
    expect(result).toBeNull();
    expect(p.calls).toHaveLength(0);
  });

  it("writes messages that start with their event word and the client_id", () => {
    expect(feedbackMessage(shop(), { notes: "x" }).split("\n")[0]).toBe("MEETING FEEDBACK: Pat's Garage");
    expect(scriptMessage(shop()).split("\n").slice(0, 2)).toEqual(["WRITE MEETING SCRIPT: Pat's Garage", "client_id: cli_pat"]);
    expect(scriptMessage(shop())).toMatch(/exactly one "MEETING SCRIPT:" note/);
  });
});

describe("requestMeetingScript", () => {
  beforeEach(() => resetScriptRequests());

  it("wakes client-manager once, and a second click inside ten minutes starts nothing", async () => {
    const p = platform();
    expect(await requestMeetingScript(shop(), { config, fetchImpl: p.fetchImpl, now })).toEqual({ woke: true });
    expect(await requestMeetingScript(shop(), { config, fetchImpl: p.fetchImpl, now: new Date(now.getTime() + 60_000) })).toEqual({ woke: true, already: true });
    expect(p.calls).toHaveLength(1);
    expect(JSON.parse(String(p.calls[0]!.init.body)).message).toMatch(/^WRITE MEETING SCRIPT: /);
    await requestMeetingScript(shop(), { config, fetchImpl: p.fetchImpl, now: new Date(now.getTime() + 11 * 60_000) });
    expect(p.calls).toHaveLength(2);
  });

  it("a failed wake can be retried at once", async () => {
    const bad = platform(503);
    expect((await requestMeetingScript(shop(), { config, fetchImpl: bad.fetchImpl, now })).woke).toBe(false);
    const good = platform();
    expect((await requestMeetingScript(shop(), { config, fetchImpl: good.fetchImpl, now })).woke).toBe(true);
  });
});
