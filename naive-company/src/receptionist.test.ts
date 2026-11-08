import { describe, expect, it } from "vitest";
import { callsOf, receptionistOf } from "./receptionist";

describe("receptionistOf", () => {
  it("reads the demo and portal links research filed, and the live number booking filed", () => {
    const notes = [
      "RESEARCH: 4.8 on 210 reviews",
      "RECEPTIONIST: shop_id meissner-auto, demo_url https://voice.example/demo/meissner-auto, portal_url https://voice.example/portal/meissner-auto, preview",
      "RECEPTIONIST: live shop_id meissner-auto phone_number +1 650 555 0100",
      "CALL: c1 booked, guardrails ok",
    ];
    expect(receptionistOf(notes)).toEqual({
      shopId: "meissner-auto",
      demoUrl: "https://voice.example/demo/meissner-auto",
      portalUrl: "https://voice.example/portal/meissner-auto",
      phone: "+1 650 555 0100",
      live: true,
    });
    expect(callsOf(notes)).toEqual(["CALL: c1 booked, guardrails ok"]);
  });

  it("is null for a shop with no receptionist", () => {
    expect(receptionistOf(["RESEARCH: x"])).toBeNull();
  });
});
