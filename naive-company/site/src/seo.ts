import type { SiteProfile } from "../site.config.ts";

const ensureMeta = (selector: string, attributes: Record<string, string>): HTMLMetaElement => {
  const found = document.head.querySelector<HTMLMetaElement>(selector);
  const meta = found ?? document.createElement("meta");
  for (const [name, value] of Object.entries(attributes)) meta.setAttribute(name, value);
  if (found === null) document.head.append(meta);
  return meta;
};

const ensureLink = (rel: string, href: string): HTMLLinkElement => {
  const found = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  const link = found ?? document.createElement("link");
  link.rel = rel;
  link.href = href;
  if (found === null) document.head.append(link);
  return link;
};

/** Install this agency's GA4 tag once. Invalid or empty ids never load third-party code. */
export function applyGoogleAnalytics(measurementId: string): void {
  if (!/^G-[A-Z0-9]+$/.test(measurementId)) return;

  if (document.head.querySelector("#agency-google-analytics") === null) {
    const loader = document.createElement("script");
    loader.id = "agency-google-analytics";
    loader.async = true;
    loader.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.append(loader);
  }

  if (document.head.querySelector("#agency-google-analytics-config") === null) {
    const config = document.createElement("script");
    config.id = "agency-google-analytics-config";
    config.textContent = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config',${JSON.stringify(measurementId)});`;
    document.head.append(config);
  }
}

/** Keep the document head aligned with the operator-approved site profile. */
export function applySeo(site: SiteProfile, href = window.location.href): void {
  const canonical = new URL("/", href).toString();
  const title = `${site.company} — ${site.tagline}`;
  const description = site.hero.subtitle;
  document.title = title;
  ensureMeta('meta[name="description"]', { name: "description", content: description });
  ensureMeta('meta[name="robots"]', { name: "robots", content: "index,follow,max-image-preview:large,max-snippet:-1" });
  ensureMeta('meta[property="og:type"]', { property: "og:type", content: "website" });
  ensureMeta('meta[property="og:site_name"]', { property: "og:site_name", content: site.company });
  ensureMeta('meta[property="og:title"]', { property: "og:title", content: title });
  ensureMeta('meta[property="og:description"]', { property: "og:description", content: description });
  ensureMeta('meta[property="og:url"]', { property: "og:url", content: canonical });
  ensureMeta('meta[name="twitter:card"]', { name: "twitter:card", content: "summary" });
  ensureMeta('meta[name="twitter:title"]', { name: "twitter:title", content: title });
  ensureMeta('meta[name="twitter:description"]', { name: "twitter:description", content: description });
  ensureLink("canonical", canonical);

  const prior = document.head.querySelector<HTMLScriptElement>("#agency-structured-data");
  const script = prior ?? document.createElement("script");
  script.id = "agency-structured-data";
  script.type = "application/ld+json";
  script.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ProfessionalService",
        "@id": `${canonical}#organization`,
        name: site.company,
        url: canonical,
        email: site.contact.email,
        description,
        slogan: site.tagline,
        knowsAbout: site.services.map((service) => service.name),
      },
      {
        "@type": "FAQPage",
        "@id": `${canonical}#faq`,
        mainEntity: site.faq.items.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer },
        })),
      },
    ],
  });
  if (prior === null) document.head.append(script);
}
