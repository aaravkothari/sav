import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { isOperatorPath, operatorRedirect } from "./site/routing.ts";
import { TEMPLATE } from "./templates/index.ts";

/**
 * The dev server's half of `site/routing.ts`: a deep link under `/app` is the operator bundle's
 * page (`appType: "mpa"` alone would 404 it), and a pre-`/app` operator path is redirected.
 * `pnpm serve` and the deployed rewrites do the same for the built tree.
 */
const twoDoors = (): Plugin => ({
  name: "agency:two-doors",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const legacy = operatorRedirect(pathname);
      if (legacy !== null) return void res.writeHead(302, { location: legacy }).end();
      if (isOperatorPath(pathname) && !/\.\w+$/.test(pathname)) req.url = "/app/index.html";
      next();
    });
  },
});

const entry = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/**
 * `dist/.naive-template`: the template this build is, for the platform's artifact publisher. It
 * builds every template of this repository (`naive:build`) and refuses a `dist/` that names another,
 * so a stale or default build can never be published under the wrong template's row again.
 */
const templateMark = (): Plugin => ({
  name: "agency:template-mark",
  apply: "build",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: ".naive-template", source: `${TEMPLATE}\n` });
  },
});

const googleSiteVerification = (token: string): Plugin => ({
  name: "agency:google-site-verification",
  transformIndexHtml: {
    order: "pre",
    handler(html, context) {
      if (!/^[A-Za-z0-9_-]+$/.test(token) || context.filename.endsWith("/app/index.html")) return html;
      return html.replace(
        "</head>",
        `    <meta name="google-site-verification" content="${token}" />\n  </head>`,
      );
    },
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const verification = process.env["GOOGLE_SITE_VERIFICATION"] ?? env["GOOGLE_SITE_VERIFICATION"] ?? "";
  return {
  plugins: [react(), tailwindcss(), googleSiteVerification(verification), twoDoors(), templateMark()],
  /**
   * One build, two pages: `index.html` is the public site, served at `/`; `app/index.html` is the
   * operator dashboard, served for `/app` and everything under it. Same origin, so the site's
   * `GET /api/site` and its contact form's `POST /api/leads` need no second host.
   */
  appType: "mpa",
  build: {
    rollupOptions: { input: { site: entry("index.html"), app: entry("app/index.html") } },
    // The one chunk over the default limit is `@google/model-viewer` (three.js, ~1 MB), emitted only
    // in a product-design build and fetched only when the Studio screen shows a mesh.
    chunkSizeWarningLimit: 1_100,
  },
  /**
   * *** THE ONE WAY THE BROWSER LEARNS WHICH TEMPLATE THIS BUILD IS. ***
   *
   * `templates/index.ts` picks `TEMPLATE` from `process.env["NAIVE_TEMPLATE"]`, and that module is
   * imported by the screens as well as by `naive.config.ts`. In Node the read works. In a client
   * bundle it does not: Vite compiles a bare `process.env` to `{}`, so the screens read `undefined`
   * and every build fell back to this repository's default template — measured, the published
   * `blank` and `seo-geo` dashboards were byte-identical, and an operator installing `blank` got
   * the `seo-geo` UI.
   *
   * A `define` is the fix because the template is a BUILD-TIME fact, not a runtime one: one build
   * is one template, the deployed dashboard is static files, and there is no request in which the
   * value could still be chosen. So it is substituted here, where it is known.
   *
   * The public site reads the template's own copy through the same module, and `build-api.mjs`
   * carries the same line for the server half.
   *
   * Unset — every run that is not the platform's artifact publisher — this substitutes `""`, which
   * is falsy, and `templates/index.ts` keeps the default the file itself names. Nothing changes for
   * an operator who switches template by editing that line.
   */
  define: {
    "process.env.NAIVE_TEMPLATE": JSON.stringify(process.env["NAIVE_TEMPLATE"] ?? ""),
    /**
     * Whether this build is the product-design studio — read from `templates/index.ts` itself, so an
     * operator who switched by editing that file's line gets it as surely as the publisher's
     * `NAIVE_TEMPLATE`. A literal, so the bundler drops the `@google/model-viewer` import (three.js,
     * ~1 MB) from every other template's build instead of emitting a chunk nobody fetches.
     */
    __AGENCY_STUDIO__: JSON.stringify(TEMPLATE === "product-design"),
  },
  /**
   * `pnpm dev` keeps its demo without compiling a single seed row into the bundle: the screens
   * read the seeded **file** store through the real routes of a local `pnpm serve` on :8789. With
   * no server running, every screen shows its empty state or the unreachable error — which is
   * exactly what the deployment does, and the point of seeing it here first.
   */
  server: { proxy: { "/api": "http://localhost:8789", "/mcp": "http://localhost:8789" } },
  };
});
