import { describe, expect, it } from "vitest";
import { AUTOOPS } from "../templates/receptionist.ts";
import { autoopsUrl, callAutoops, callView, mailRow, receptionistView, shopIdOf } from "./shop-routes.ts";

const sse = (payload: unknown) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

describe("the autoops-voice call", () => {
  it("uses the template's URL unless AUTOOPS_MCP_URL overrides it", () => {
    expect(autoopsUrl({})).toBe(AUTOOPS.url);
    expect(autoopsUrl({ AUTOOPS_MCP_URL: "https://new.example/mcp" })).toBe("https://new.example/mcp");
  });

  it("sends the bearer, reads the SSE reply, and surfaces a tool error", async () => {
    const seen: { url: string; auth: string | null; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) });
      const args = (JSON.parse(String(init.body)) as { params: { arguments: { shop_id: string } } }).params.arguments;
      const result = args.shop_id === "missing"
        ? { content: [{ type: "text", text: JSON.stringify({ error: "Shop not found: missing" }) }], isError: true }
        : { content: [{ type: "text", text: JSON.stringify({ shop_name: "Bay Auto", version: 2 }) }] };
      return new Response(sse({ jsonrpc: "2.0", id: 1, result }), { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const env = { AUTOOPS_VOICE_TOKEN: "tok", AUTOOPS_MCP_URL: "https://voice.example/mcp" };
    expect(await callAutoops("get_receptionist", { shop_id: "bay" }, env, fetcher)).toEqual({ shop_name: "Bay Auto", version: 2 });
    expect(seen[0]).toMatchObject({ url: "https://voice.example/mcp", auth: "Bearer tok", body: { method: "tools/call", params: { name: "get_receptionist" } } });
    await expect(callAutoops("get_receptionist", { shop_id: "missing" }, env, fetcher)).rejects.toThrow(/not found/);
    await expect(callAutoops("get_receptionist", {}, {}, fetcher)).rejects.toThrow(/not configured/);
  });
});

describe("what the browser is given", () => {
  it("finds the shop_id in either note shape", () => {
    expect(shopIdOf({ notes: ["RESEARCH: x", "RECEPTIONIST: shop_id pats-garage · demo_url https://x/demo/pats-garage"] })).toBe("pats-garage");
    expect(shopIdOf({ notes: ["Demo receptionist built (voice shop_id expertautocaremv-com).\nDemo page: https://x"] })).toBe("expertautocaremv-com");
    expect(shopIdOf({ notes: ["RESEARCH: x"] })).toBeNull();
  });

  it("keeps the prompt and facts, and drops the assistant id and the owner's portal token", () => {
    const view = receptionistView({
      shop_name: "Bay Auto", version: 3, versions: 3, subscription_status: "prospect", phone_number: null,
      vapi_assistant_id: "c41019b9", system_prompt: "You are…", first_message: "Hi", hours: { mon: "9-5" },
      services: ["brakes"], policies: ["Do not quote prices."], demo_url: "https://x/demo/bay", portal_url: "https://x/portal/bay?t=secret",
    });
    expect(view.live).toBe(false);
    expect(JSON.stringify(view)).not.toMatch(/c41019b9|secret|portal/);
    expect(receptionistView({ subscription_status: "trialing", phone_number: "+14155550100" }).live).toBe(true);
  });

  it("names a call by what happened, and a message by who it was with", () => {
    const call = callView({ id: "c1", started_at: "2026-11-07T23:07:38Z", duration_sec: 89, outcome: "appointment_request", ended_reason: "customer-ended-call", flags: ["appointment_request"] }, new Map([["c1", "Wants brakes Tuesday"]]));
    expect(call).toEqual({ at: "2026-11-07T23:07:38Z", duration_sec: 89, outcome: "appointment_request", summary: "Wants brakes Tuesday", flags: ["appointment_request"], ended_by: "caller" });
    const sent = mailRow({ labels: ["sent"], from: "Aarav from SAV <aarav.sav@agentmail.to>", to: ["pat@patsgarage.com"], subject: "Hi", timestamp: "2026-11-08T04:10:19Z" }, "aarav.sav@agentmail.to");
    expect(sent).toMatchObject({ direction: "sent", counterpart: "pat@patsgarage.com" });
    const got = mailRow({ labels: ["received"], from: "Pat Banks <Pat@PatsGarage.com>", to: ["aarav.sav@agentmail.to"], subject: "Re: Hi", timestamp: "2026-11-08T05:00:00Z" }, "aarav.sav@agentmail.to");
    expect(got).toMatchObject({ direction: "received", counterpart: "pat@patsgarage.com" });
  });
});
