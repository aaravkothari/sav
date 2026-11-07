import { describe, expect, it, vi } from "vitest";
import { referralCode, submitLead, toLeadInput, type ContactForm } from "./lead.ts";

const form: ContactForm = {
  company: " Summit Outdoor Co ",
  website: "https://summitoutdoor.example/about",
  name: "Jordan Lee",
  email: "jordan@summitoutdoor.example",
  services: ["SEO"],
  note: "Wants a technical audit first.",
};

describe("toLeadInput", () => {
  it("maps the form to the server's LeadInput, normalizing the domain", () => {
    expect(toLeadInput(form)).toEqual({
      name: "Summit Outdoor Co",
      domain: "summitoutdoor.example",
      contact: { name: "Jordan Lee", email: "jordan@summitoutdoor.example", role: "Site inquiry" },
      services: ["SEO"],
      note: "Wants a technical audit first.",
    });
  });

  it("omits empty services and note", () => {
    const input = toLeadInput({ ...form, services: [], note: "  " });
    expect(input).not.toHaveProperty("services");
    expect(input).not.toHaveProperty("note");
  });
});

describe("submitLead", () => {
  const jsonHeaders = new Headers({ "content-type": "application/json" });

  it("returns sent when the dashboard server accepts the lead", async () => {
    const doFetch = (async (url: unknown, init?: RequestInit) => {
      expect(url).toBe("/api/leads");
      expect(JSON.parse(String(init?.body)).name).toBe("Summit Outdoor Co");
      return { ok: true, headers: jsonHeaders } as Response;
    }) as typeof fetch;
    expect(await submitLead(form, doFetch)).toBe("sent");
  });

  it("degrades to offline on a non-ok response", async () => {
    const doFetch = (async () => ({ ok: false, headers: jsonHeaders }) as Response) as typeof fetch;
    expect(await submitLead(form, doFetch)).toBe("offline");
  });

  it("degrades to offline when the server is unreachable", async () => {
    const doFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await submitLead(form, doFetch)).toBe("offline");
  });
});

describe("a referral link", () => {
  it("sends the link's code with the lead, and nothing when there is none", () => {
    expect(toLeadInput(form, "Ab3dEf6hIj9k").ref).toBe("Ab3dEf6hIj9k");
    expect(toLeadInput(form)).not.toHaveProperty("ref");
  });

  it("remembers the code for the visit, so reading on before writing in still credits the referrer", () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { setItem: (k: string, v: string) => kept.set(k, v), getItem: (k: string) => kept.get(k) ?? null });
    try {
      expect(referralCode("?ref=Ab3dEf6hIj9k")).toBe("Ab3dEf6hIj9k");
      expect(referralCode("")).toBe("Ab3dEf6hIj9k");
      expect(referralCode("?ref=Zz9")).toBe("Zz9");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("still reads the URL when the browser refuses storage", () => {
    vi.stubGlobal("sessionStorage", { setItem: () => { throw new Error("denied"); }, getItem: () => { throw new Error("denied"); } });
    try {
      expect(referralCode("?ref=Ab3dEf6hIj9k")).toBe("Ab3dEf6hIj9k");
      expect(referralCode("")).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
