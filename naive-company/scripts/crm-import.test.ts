import { describe, expect, it } from "vitest";
import { filingFor } from "./crm-import.ts";
import type { Lead, WorkerResult } from "./worker.ts";

const result = (status: WorkerResult["status"] = "created"): WorkerResult => ({
  shop_id: "jimdavisautomotive-com", name: "Jim Davis Automotive", demo_url: "https://voice.example/demo/jimdavisautomotive-com",
  portal_url: "https://voice.example/portal/jimdavisautomotive-com?t=secret", status, error: null, at: "2026-11-08T06:00:00.000Z",
});
const lead = (domain: string | null): Lead => ({
  name: "Jim Davis Automotive", priority: "A", domain, note: "Family shop since 1978.",
  shop_input: { name: "Jim Davis Automotive", kind: "repair", demo: true, phone: "+16504930433", address: "3972 El Camino Real, Palo Alto, CA 94306" },
} as Lead);

describe("filingFor", () => {
  it("files the shop by domain with the demo link and never the portal token", () => {
    const f = filingFor(result(), lead("JimDavisAutomotive.com"));
    expect(f?.lead).toEqual({ name: "Jim Davis Automotive", domain: "jimdavisautomotive.com", source: "outreach", note: "Family shop since 1978." });
    expect(f?.note).toContain("Demo page: https://voice.example/demo/jimdavisautomotive-com");
    expect(f?.note).toContain("City: palo alto");
    expect(f?.note).not.toContain("secret");
  });
  it("leaves out a lead with no domain, and anything not created", () => {
    expect(filingFor(result(), lead(null))).toBeNull();
    expect(filingFor(result(), undefined)).toBeNull();
    expect(filingFor(result("skipped"), lead("jimdavisautomotive.com"))).toBeNull();
  });
});
