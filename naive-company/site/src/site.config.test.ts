/**
 * The public site is a template, and it once shipped with its Work and Testimonials sections
 * already full: case studies with result metrics, quotes signed by named people. None of it was
 * real, and a customer who ran `naive up` published those as claims about their own business.
 *
 * So the profile carries **no** client outcome and **no** human endorsement: its proof strip states
 * how the agency works, in sentences a visitor can hold it to, and the page renders exactly the
 * sections plan §2.5 names — from the profile it is handed, which is what `GET /api/site` serves.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { launchSafeSite, site, SITE_SECTIONS } from "../site.config.ts";
import { App } from "./App.tsx";
import { loadSite } from "./profile.ts";
import { Pricing, ProofStrip } from "./sections.tsx";

/** Everything a visitor would read, flattened out of a section's element tree. */
function render(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(render).join(" ");
  if (!isValidElement(node)) return String(node);
  const props = node.props as { children?: ReactNode };
  return typeof node.type === "function"
    ? render((node.type as (p: unknown) => ReactNode)(node.props))
    : render(props.children);
}

describe("the site template invents no social proof", () => {
  it("keeps an incomplete or commercially unsafe draft off the public route", () => {
    expect(launchSafeSite(site)).toBe(false);
    const identified = { ...site, company: "Acme Search", contact: { ...site.contact, email: "hello@acme.com" } };
    expect(launchSafeSite(identified)).toBe(true);
    expect(launchSafeSite({ ...identified, whoWeServe: { ...identified.whoWeServe, subtitle: "B2B SaaS companies with $2M–$50M ARR." } })).toBe(true);
    expect(launchSafeSite({ ...identified, pricing: { ...identified.pricing, subtitle: "$2,500 per month" } })).toBe(false);
    expect(launchSafeSite({ ...identified, faq: { ...identified.faq, items: [{ question: "Term?", answer: "Month-to-month after the first quarter." }] } })).toBe(false);
  });
  it("has no case study, testimonial or number in its proof", () => {
    expect(Object.keys(site)).not.toContain("caseStudies");
    expect(Object.keys(site)).not.toContain("testimonials");
    expect(site.proof.facts.length).toBeGreaterThan(0);
    // No result metric anyone could read as an outcome, and no attributed quote.
    expect(render(ProofStrip({ site }))).not.toMatch(/\d|[“”]/);
  });

  it("is actually reading the rendered page", () => {
    // A `render` that returned "" would satisfy the assertion above and prove nothing.
    expect(render(Pricing({ site }))).toContain(site.pricing.tiers[0]?.price ?? "unset");
  });

  it("renders every section of the profile it is handed, in order", () => {
    // The whole page, contact form included, so this goes through react-dom rather than `render`.
    const page = renderToStaticMarkup(createElement(App, { site })).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    const marks = [
      site.hero.title,
      site.proof.facts[0] ?? "",
      site.services[0]?.headline ?? "",
      site.whoWeServe.title,
      site.process.title,
      site.pricing.title,
      site.faq.title,
      site.contact.subtitle,
    ];
    const at = marks.map((mark) => page.indexOf(mark));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("names every section the store lets an agent replace", () => {
    expect([...SITE_SECTIONS].sort()).toEqual(Object.keys(site).sort());
  });

  /**
   * The README's paste-ready personalization prompt used to ask an agent for "2–3 plausible
   * engagements … a concrete result metric". A prompt that asks a model to invent client outcomes
   * puts them on the customer's live site just as surely as shipping them in the config does.
   */
  it("ships no prompt that asks an agent to make client work up", () => {
    const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8");
    expect(readme).not.toMatch(/plausible/i);
    expect(readme).toMatch(/Invent nothing/);
    expect(readme).not.toMatch(/Acme Dental|Priya Shah|Verdant Skincare|Northbeam Legal/);
  });
});

describe("the page reads its copy from /api/site", () => {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("shows what the route serves", async () => {
    const served = { ...site, hero: { ...site.hero, title: "Approved on Tuesday" } };
    const calls: string[] = [];
    const doFetch = ((url: string) => { calls.push(url); return json(served); }) as unknown as typeof fetch;
    expect((await loadSite(doFetch)).hero.title).toBe("Approved on Tuesday");
    expect(calls).toEqual(["/api/site"]);
  });

  it("falls back to the compiled seed when the route is not there", async () => {
    const html = (() => Promise.resolve(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }))) as unknown as typeof fetch;
    const down = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    expect(await loadSite(html)).toEqual(site);
    expect(await loadSite(down)).toEqual(site);
  });

  it("takes a served section only in the seed's shape, and the seed's own for any other", async () => {
    // A tier without a price and a hero that is a string would each throw in a section; both are the seed's.
    const served = {
      ...site,
      hero: "Approved on Tuesday",
      pricing: { ...site.pricing, tiers: [{ name: "Growth" }] },
      contact: { ...site.contact, email: "hello@served.example" },
    };
    const got = await loadSite((() => json(served)) as unknown as typeof fetch);
    expect(got.hero).toEqual(site.hero);
    expect(got.pricing).toEqual(site.pricing);
    expect(got.contact.email).toBe("hello@served.example");
    expect(await loadSite((() => json([1, 2])) as unknown as typeof fetch)).toEqual(site);
    expect(await loadSite((() => json(null)) as unknown as typeof fetch)).toEqual(site);
  });
});
