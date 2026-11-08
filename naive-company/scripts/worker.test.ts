import { describe, expect, it } from "vitest";
import {
  cityFromAddress, demoShop, deriveShopId, findDuplicate, limiter, namesMatch, normalizePhone, parseArgs, parseRpcBody,
  PermanentError, registrableDomain, selectLeads, sharedDomains, shopFactsFromPrompt, withRetry,
  type ExistingShop, type Lead,
} from "./worker.ts";

const lead = (name: string, shop: Partial<Lead["shop_input"]> = {}, priority: Lead["priority"] = "A"): Lead => ({
  name, priority, shop_input: { name, kind: "repair", demo: true, ...shop },
});

describe("normalizePhone", () => {
  it("keeps the last 10 digits", () => {
    expect(normalizePhone("+16505952860")).toBe("6505952860");
    expect(normalizePhone("(650) 595-2860")).toBe("6505952860");
    expect(normalizePhone("1-650-595-2860")).toBe("6505952860");
  });
  it("is null for missing or short numbers", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("595-2860")).toBeNull();
  });
});

describe("deriveShopId", () => {
  it("slugs the registrable website domain", () => {
    expect(registrableDomain("https://jimdavisautomotive.com/")).toBe("jimdavisautomotive.com");
    expect(registrableDomain("http://www.scautosolutions.com/")).toBe("scautosolutions.com");
    expect(registrableDomain("https://precisionautomotivecare.com/?utm_source=google")).toBe("precisionautomotivecare.com");
    expect(registrableDomain("http://kens-auto-repair-san-jose.jany.io/")).toBe("jany.io");
    expect(registrableDomain("https://shop.example.co.uk/x")).toBe("example.co.uk");
    expect(deriveShopId({ name: "Jim Davis", website: "https://jimdavisautomotive.com/" })).toBe("jimdavisautomotive-com");
    expect(deriveShopId({ name: "Jim Davis", website: "jimdavisauto.com" })).toBe("jimdavisauto-com");
  });
  it("uses p-<last10> without a website", () => {
    expect(deriveShopId({ name: "Say Ray", website: null, phone: "+1 (650) 555-0101" })).toBe("p-6505550101");
  });
  it("adds the phone when several leads share a domain", () => {
    const leads = [
      lead("Stress Free RWC", { website: "https://www.stressfree.com/shops/redwood-city", phone: "+16505550001" }),
      lead("Stress Free MV", { website: "https://www.stressfree.com/shops/mountain-view", phone: "+16505550002" }),
      lead("Solo", { website: "https://solo.com/", phone: "+16505550003" }),
    ];
    const shared = sharedDomains(leads);
    expect([...shared]).toEqual(["stressfree.com"]);
    expect(leads.map((l) => deriveShopId(l.shop_input, shared))).toEqual(["stressfree-com-6505550001", "stressfree-com-6505550002", "solo-com"]);
  });
});

describe("findDuplicate", () => {
  const existing: ExistingShop[] = [
    { shop_id: "jim-davis-automotive", name: "Jim Davis Automotive", phone: null, city: null },
    { shop_id: "specialized-auto-care-palo-alto", name: "Specialized Auto Care", phone: null, city: null },
    { shop_id: "belmount-auto", name: "Belmount Auto Repair", phone: "6508028027", city: "san carlos" },
    { shop_id: "demo-shop", name: "Demo Auto Works", phone: "4085550100", city: "san jose" },
  ];
  it("matches by shop id", () => {
    expect(findDuplicate(lead("Anything"), "belmount-auto", existing)?.reason).toBe("shop_id");
  });
  it("matches by phone whatever the name", () => {
    const l = lead("Belmount Auto Repair Shop LLC", { phone: "(650) 802-8027", address: "1 Elm St, Belmont, CA 94002" });
    expect(findDuplicate(l, "p-6508028027", existing)).toEqual({ shop_id: "belmount-auto", reason: "phone" });
  });
  it("matches by name and city, including taglines and longer names", () => {
    const jim = lead("Jim Davis Automotive - Auto Repair Shop In Palo Alto", { address: "3972 El Camino Real, Palo Alto, CA 94306" });
    expect(findDuplicate(jim, "jimdavisautomotive-com", existing)?.shop_id).toBe("jim-davis-automotive");
    const spec = lead("Specialized Auto Care Center", { address: "1963 El Camino Real, Palo Alto, CA 94306" });
    expect(findDuplicate(spec, "specializedautorepair-com", existing)?.shop_id).toBe("specialized-auto-care-palo-alto");
    const demo = lead("Demo Auto Works Inc.", { address: "9 Main St, San Jose, CA 95112" });
    expect(findDuplicate(demo, "x", existing)).toEqual({ shop_id: "demo-shop", reason: "name+city" });
  });
  it("lets the same name in another city through, and new shops through", () => {
    const demo = lead("Demo Auto Works", { address: "9 Main St, Oakland, CA 94607", phone: "+15105550000" });
    expect(findDuplicate(demo, "p-5105550000", existing)).toBeNull();
    expect(findDuplicate(lead("Metric Motors", { phone: "+16505551234", address: "1 A St, Palo Alto, CA 94301" }), "p-6505551234", existing)).toBeNull();
  });
  it("does not match on one shared word", () => {
    expect(namesMatch("Jim's", "Jim Davis Automotive")).toBe(false);
    expect(namesMatch("Auto Care", "Auto Care Plus")).toBe(true);
    expect(namesMatch("Palo Alto Auto", "Palo Alto Bimmer")).toBe(false);
  });
  it("reads city and phone back out of a receptionist prompt", () => {
    expect(cityFromAddress("1700 El Camino Real, San Carlos, CA 94070")).toBe("san carlos");
    expect(cityFromAddress("Suite 5, 1383 Laurel St, San Carlos, CA")).toBe("san carlos");
    expect(cityFromAddress(null)).toBeNull();
    const prompt = "## Shop facts\n- Name: Belmount Auto Repair\n- Address: 1383 Laurel St #5011, San Carlos, CA 94070\n- Phone: +16508028027\n";
    expect(shopFactsFromPrompt(prompt)).toEqual({ phone: "6508028027", city: "san carlos" });
    expect(shopFactsFromPrompt("- Address: not provided\n- Phone: not provided")).toEqual({ phone: null, city: null });
  });
});

describe("limiter", () => {
  it("never runs more than n at once, and runs them all", async () => {
    const limit = limiter(4);
    let active = 0;
    let peak = 0;
    const done = await Promise.all(Array.from({ length: 20 }, (_, i) => limit(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5 + (i % 3)));
      active--;
      return i;
    })));
    expect(peak).toBe(4);
    expect(done).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
  it("keeps going after a task fails", async () => {
    const limit = limiter(1);
    const failed = limit(() => Promise.reject(new Error("boom")));
    const after = limit(() => Promise.resolve("ok"));
    await expect(failed).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });
});

describe("withRetry", () => {
  it("retries twice with doubling backoff, then gives up", async () => {
    const waits: number[] = [];
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error("down"); }, 2, 100, async (ms) => { waits.push(ms); })).rejects.toThrow("down");
    expect(calls).toBe(3);
    expect(waits).toEqual([100, 200]);
  });
  it("returns once a retry succeeds, and does not retry a permanent error", async () => {
    let calls = 0;
    await expect(withRetry(async () => (++calls < 2 ? Promise.reject(new Error("blip")) : "ok"), 2, 0, async () => {})).resolves.toBe("ok");
    calls = 0;
    await expect(withRetry(async () => { calls++; throw new PermanentError("401"); }, 2, 0, async () => {})).rejects.toThrow("401");
    expect(calls).toBe(1);
  });
});

describe("the rest", () => {
  it("forces demo, drops notify_phone and nulls", () => {
    expect(demoShop({ name: "X", demo: false, website: null, notify_phone: "+15555550100", phone: "+16505550000" }))
      .toEqual({ name: "X", demo: true, phone: "+16505550000" });
  });
  it("puts priority A first and applies the limit", () => {
    const leads = [lead("b1", {}, "B"), lead("a1"), lead("c1", {}, "C"), lead("a2")];
    expect(selectLeads(leads, { limit: 3 }).map((l) => l.name)).toEqual(["a1", "a2", "b1"]);
    expect(selectLeads(leads, { limit: 43, priority: "C" }).map((l) => l.name)).toEqual(["c1"]);
  });
  it("is a dry run unless --execute", () => {
    expect(parseArgs([])).toEqual({ execute: false, limit: 43 });
    expect(parseArgs(["--execute", "--limit", "5", "--priority=a"])).toEqual({ execute: true, limit: 5, priority: "A" });
    expect(() => parseArgs(["--limit", "0"])).toThrow();
    expect(() => parseArgs(["--dry-run", "--execute"])).toThrow();
  });
  it("parses JSON and SSE replies", () => {
    expect(parseRpcBody('{"result":1}')).toEqual({ result: 1 });
    expect(parseRpcBody('event: message\ndata: {"result":2}\n\n')).toEqual({ result: 2 });
  });
});
