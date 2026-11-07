// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { site } from "../site.config.ts";
import { applyGoogleAnalytics, applySeo } from "./seo.ts";

describe("public-site SEO metadata", () => {
  it("writes canonical, social and structured metadata from the approved profile", () => {
    const profile = {
      ...site,
      company: "Founder Frame",
      tagline: "Be the answer",
      contact: { ...site.contact, email: "hello@founderframehq.com" },
    };
    applySeo(profile, "https://founderframehq.com/anything");

    expect(document.title).toBe("Founder Frame — Be the answer");
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://founderframehq.com/");
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(document.title);
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(profile.hero.subtitle);
    expect(document.querySelector("#agency-structured-data")?.textContent).toContain("hello@founderframehq.com");
    expect(document.querySelector("#agency-structured-data")?.textContent).toContain("FAQPage");
  });

  it("installs a configured GA4 tag once and ignores invalid ids", () => {
    applyGoogleAnalytics("");
    applyGoogleAnalytics("not-a-measurement-id");
    expect(document.querySelector("#agency-google-analytics")).toBeNull();

    applyGoogleAnalytics("G-D7MTBP2XEP");
    applyGoogleAnalytics("G-D7MTBP2XEP");
    const loaders = document.querySelectorAll<HTMLScriptElement>("#agency-google-analytics");
    expect(loaders).toHaveLength(1);
    expect(loaders[0]?.src).toBe("https://www.googletagmanager.com/gtag/js?id=G-D7MTBP2XEP");
    expect(document.querySelector("#agency-google-analytics-config")?.textContent).toContain("G-D7MTBP2XEP");
  });
});
