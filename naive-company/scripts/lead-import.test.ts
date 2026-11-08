import { describe, expect, it } from "vitest";
import { leadArgs, receptionistNote } from "./lead-import.ts";

describe("lead-import", () => {
  it("skips a row with no email: a lead without an email is not a lead", () => {
    expect(leadArgs({ name: "Shop", domain: "shop.com", note: "RESEARCH: x" })).toBeNull();
    expect(leadArgs({ name: "Shop", email: "not-an-email", note: "RESEARCH: x" })).toBeNull();
  });

  it("files the email, domain, phone and research note", () => {
    expect(leadArgs({ name: " Shop ", domain: "WWW.Shop.com", email: "Info@Shop.com", phone: "+14155550100", note: "rated 4.8", sector: "auto repair" })).toEqual({
      name: "Shop",
      domain: "shop.com",
      contact_email: "info@shop.com",
      phone: "+14155550100",
      source: "outreach",
      note: "RESEARCH: rated 4.8\nSector: auto repair",
    });
  });

  it("files the demo as a path, never a host", () => {
    expect(receptionistNote("shop-com")).toContain("demo_url /demo/shop-com");
    expect(receptionistNote("shop-com")).not.toMatch(/https?:/);
  });
});
