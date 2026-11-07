/**
 * What `deploy_dir` ships is what the host runs, so the three files `build-api.mjs` writes are the
 * whole server contract — and the rewrites are the only thing that puts a path in front of the
 * function. This runs the real script into a temp `dist/` copy of the blueprint's own tree.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
let dist = "";
let work = "";
let blank = "";
let seoGeo = "";

/** One run of the real script, and the function it emitted. `NAIVE_TEMPLATE` is the override. */
function buildApi(template?: string): string {
  const env = template === undefined ? process.env : { ...process.env, NAIVE_TEMPLATE: template };
  execFileSync("node", ["build-api.mjs"], { cwd: work, env });
  return readFileSync(join(dist, "api", "app.js"), "utf8");
}

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "sga-build-"));
  // `templates` too: the server reads the active template's crew, seed and kinds from it; `site`
  // for the site profile the store seeds and the two-door routing the server shares with it.
  for (const entry of ["build-api.mjs", "server", "seed", "site", "templates"]) {
    cpSync(join(root, entry), join(work, entry), { recursive: true });
  }
  // Symlinked, not copied: the script only needs esbuild to resolve from beside itself.
  symlinkSync(join(root, "node_modules"), join(work, "node_modules"), "dir");
  dist = join(work, "dist");
  // The predecessor's function, to prove the build no longer leaves a second one behind.
  mkdirSync(join(dist, "api"), { recursive: true });
  writeFileSync(join(dist, "index.html"), '<!doctype html><html><head><title>Agency services</title><meta name="description" content="generic"></head><body><div id="root"></div><script type="module" src="/assets/site.js"></script></body></html>');
  writeFileSync(join(dist, "api", "mcp.js"), "stale");
  blank = buildApi("blank");
  seoGeo = buildApi("seo-geo");
  // The default build last, so every assertion below reads the tree `pnpm build` leaves behind.
  buildApi();
}, 120_000);

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("build-api.mjs", () => {
  it("emits one function, at the name the host maps to /api/app", () => {
    expect(existsSync(join(dist, "api", "app.js"))).toBe(true);
    expect(existsSync(join(dist, "api", "mcp.js"))).toBe(false);
    // `pg` is installed from the manifest, not inlined: its internals do not survive bundling.
    expect(readFileSync(join(dist, "package.json"), "utf8")).toContain("\"pg\"");
    expect(readFileSync(join(dist, "api", "app.js"), "utf8")).toContain('from "pg"');
  });

  it("writes the public discovery and app rewrites in the order that makes them work", () => {
    const { rewrites } = JSON.parse(readFileSync(join(dist, "vercel.json"), "utf8")) as {
      rewrites: { source: string; destination: string }[];
    };
    expect(rewrites).toEqual([
      { source: "/mcp", destination: "/api/app?__path=/mcp" },
      { source: "/", destination: "/api/app?__path=/" },
      { source: "/blog/:path*", destination: "/api/app?__path=/blog/:path*" },
      { source: "/robots.txt", destination: "/api/app?__path=/robots.txt" },
      { source: "/sitemap.xml", destination: "/api/app?__path=/sitemap.xml" },
      { source: "/llms.txt", destination: "/api/app?__path=/llms.txt" },
      { source: "/api/(.*)", destination: "/api/app?__path=/api/$1" },
      { source: "/app/:path*", destination: "/app/index.html" },
      { source: "/((?!api/).*)", destination: "/site-shell.html" },
    ]);
    // The operator dashboard's fallback comes before the public site's, and the site's — last —
    // must never swallow a function.
    expect(rewrites[8]!.source).toBe("/((?!api/).*)");
    expect(new RegExp(`^${rewrites[8]!.source}$`).test("/api/clients")).toBe(false);
    expect(new RegExp(`^${rewrites[8]!.source}$`).test("/pricing")).toBe(true);
    expect(existsSync(join(dist, "index.html"))).toBe(false);
    expect(existsSync(join(dist, "site-shell.html"))).toBe(true);
  });

  it("compiles the template it was built for, rather than reading it on a host that has none", () => {
    // The server half imports `templates/active.ts` for the crew, the deliverable kinds and the
    // seed. On the deployed host `NAIVE_TEMPLATE` is not in the environment, so a runtime read
    // there answers with this repository's default while the screens beside it show the built one
    // — two halves of one deployment disagreeing about which template is running.
    const digest = (code: string) => createHash("sha256").update(code).digest("hex");
    expect(digest(blank)).not.toEqual(digest(seoGeo));
    expect(blank).not.toContain("NAIVE_TEMPLATE");
  });

  it("compiles the server half for the template the screens' build named in dist/.naive-template", () => {
    const digest = (code: string) => createHash("sha256").update(code).digest("hex");
    const studio = buildApi("product-design");
    writeFileSync(join(dist, ".naive-template"), "product-design\n");
    try {
      // The environment disagrees and loses: the two halves of one dist cannot name two templates.
      expect(digest(buildApi("blank"))).toEqual(digest(studio));
    } finally {
      rmSync(join(dist, ".naive-template"));
      buildApi();
    }
  });

  it("bundles the whole route table, not just /mcp", () => {
    const bundle = readFileSync(join(dist, "api", "app.js"), "utf8");
    for (const path of ["/api/clients", "/api/posts", "/api/leads", "/api/mcp/tokens", "/mcp"]) {
      expect(bundle).toContain(path);
    }
  });
});
