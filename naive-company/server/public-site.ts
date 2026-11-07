import type { Post } from "../seed/posts.ts";
import type { SiteProfile } from "../site/site.config.ts";

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

export const publishedArticle = (post: Post, today = new Date().toISOString().slice(0, 10)): boolean =>
  post.channel === "blog" && post.status === "posted" && post.kind === "article" &&
  post.scheduledFor <= today && (post.body ?? "").trim() !== "";

export const articlePath = (post: Pick<Post, "id">): string => `/blog/${encodeURIComponent(post.id)}`;

const replaceTag = (html: string, pattern: RegExp, replacement: string): string =>
  pattern.test(html) ? html.replace(pattern, replacement) : html.replace("</head>", `${replacement}\n</head>`);

const metadata = (site: SiteProfile, origin: string, page?: Pick<Post, "id" | "title" | "summary" | "scheduledFor">): string => {
  const canonical = page === undefined ? `${origin}/` : `${origin}${articlePath(page)}`;
  const title = page === undefined ? `${site.company} — ${site.tagline}` : `${page.title} — ${site.company}`;
  const description = page?.summary ?? site.hero.subtitle;
  const graph = page === undefined
    ? {
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "ProfessionalService", "@id": `${origin}/#organization`, name: site.company, url: `${origin}/`, email: site.contact.email, description, slogan: site.tagline, knowsAbout: site.services.map((service) => service.name) },
          { "@type": "FAQPage", "@id": `${origin}/#faq`, mainEntity: site.faq.items.map((item) => ({ "@type": "Question", name: item.question, acceptedAnswer: { "@type": "Answer", text: item.answer } })) },
        ],
      }
    : { "@context": "https://schema.org", "@type": "BlogPosting", headline: page.title, description, datePublished: page.scheduledFor, mainEntityOfPage: canonical, publisher: { "@type": "Organization", name: site.company, url: `${origin}/` } };
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1" />`,
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    `<meta property="og:type" content="${page === undefined ? "website" : "article"}" />`,
    `<meta property="og:site_name" content="${escapeHtml(site.company)}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<script type="application/ld+json">${JSON.stringify(graph).replaceAll("<", "\\u003c")}</script>`,
  ].join("\n    ");
};

export function renderHome(shell: string, site: SiteProfile, origin: string): string {
  let html = replaceTag(shell, /<title>[\s\S]*?<\/title>/i, "");
  html = html.replace(/\s*<meta name="(?:description|robots)"[^>]*>/gi, "");
  return html.replace("</head>", `    ${metadata(site, origin)}\n  </head>`);
}

const inline = (value: string): string => escapeHtml(value)
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');

/** A deliberately small, escaping-first renderer for the headings, lists and paragraphs our writers emit. */
export function articleBody(markdown: string): string {
  const blocks: string[] = [];
  let list: string[] = [];
  const closeList = () => {
    if (list.length > 0) blocks.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of markdown.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ")) { list.push(line.slice(2)); continue; }
    closeList();
    if (line === "") continue;
    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    if (heading) blocks.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
    else blocks.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return blocks.join("\n");
}

export function renderArticle(shell: string, site: SiteProfile, post: Post, origin: string): string {
  const pageMetadata = metadata(site, origin, post);
  const styles = `<style>
    .article-shell{max-width:760px;margin:0 auto;padding:32px 24px 80px;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#111114;line-height:1.7}.article-shell nav{margin-bottom:64px}.article-shell a{color:#1d4ed8}.article-shell h1{font-size:clamp(2rem,6vw,3.5rem);line-height:1.08;letter-spacing:-.04em}.article-shell h2{font-size:1.65rem;line-height:1.2;margin-top:2.5rem}.article-shell h3{font-size:1.25rem;margin-top:2rem}.article-shell p,.article-shell li{font-size:1.05rem}.article-shell .summary{font-size:1.2rem;color:#63605a}.article-shell .date{font-size:.8rem;text-transform:uppercase;letter-spacing:.1em;color:#63605a}.article-shell ul{padding-left:1.4rem}
  </style>`;
  const body = `<main class="article-shell"><nav><a href="/">← ${escapeHtml(site.company)}</a></nav><article><p class="date">${escapeHtml(post.scheduledFor)}</p><h1>${escapeHtml(post.title)}</h1><p class="summary">${escapeHtml(post.summary)}</p>${articleBody(post.body ?? "")}</article></main>`;
  let html = shell
    .replace(/<title>[\s\S]*?<\/title>/i, "")
    .replace(/\s*<meta name="(?:description|robots)"[^>]*>/gi, "")
    .replace(/<script type="module"[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<div id="root"><\/div>/i, body);
  html = html.replace("</head>", `    ${pageMetadata}\n    ${styles}\n  </head>`);
  return html;
}
