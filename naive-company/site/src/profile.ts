/**
 * The page's copy comes from `GET /api/site` — the `site_profile` the crew edits and the operator
 * approves — so a visitor sees what was approved, not what was compiled. The route is public and
 * same-origin, so this is one fetch with no bearer. When it cannot be read (local preview with no
 * server, a host mid-deploy) the compiled seed stands in: the page never renders blank. Nor does it
 * render a shape the sections were not written for: a section the reply lacks, or has in another
 * shape than the seed's, is the seed's — the store refuses such a write, so this is only ever
 * another server's reply, and the page cannot throw on it.
 */
import { sameShape, site as seed, SITE_SECTIONS, type SiteProfile } from "../site.config.ts";

export interface PublicPost {
  id: string;
  title: string;
  summary: string;
  body?: string;
  postedAt?: string;
  scheduledFor: string;
  path: string;
}

export function validProfile(value: unknown): SiteProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return seed;
  const given = value as Record<string, unknown>;
  const profile = { ...seed };
  for (const key of SITE_SECTIONS) {
    if (sameShape(seed[key], given[key])) (profile as Record<string, unknown>)[key] = given[key];
  }
  return profile;
}

export async function loadSite(doFetch: typeof fetch = fetch): Promise<SiteProfile> {
  try {
    const res = await doFetch("/api/site", { headers: { accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type")?.includes("application/json") ?? false)) return seed;
    return validProfile(await res.json());
  } catch {
    return seed;
  }
}

/** Published articles only. A bad feed hides Insights; it never takes down the landing page. */
export async function loadBlog(doFetch: typeof fetch = fetch): Promise<PublicPost[]> {
  try {
    const res = await doFetch("/api/blog", { headers: { accept: "application/json" } });
    if (!res.ok || !(res.headers.get("content-type")?.includes("application/json") ?? false)) return [];
    const value: unknown = await res.json();
    if (!Array.isArray(value)) return [];
    return value.filter((post): post is PublicPost => {
      if (typeof post !== "object" || post === null || Array.isArray(post)) return false;
      const row = post as Record<string, unknown>;
      return typeof row.id === "string" && typeof row.title === "string" && typeof row.summary === "string" &&
        typeof row.scheduledFor === "string" && typeof row.path === "string" && row.path.startsWith("/blog/") &&
        (row.body === undefined || typeof row.body === "string") &&
        (row.postedAt === undefined || typeof row.postedAt === "string");
    });
  } catch {
    return [];
  }
}
