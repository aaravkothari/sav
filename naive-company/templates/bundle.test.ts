/**
 * *** THE TEMPLATE HAS TO REACH THE BUNDLE, AND FOR A LONG TIME IT DID NOT. ***
 *
 * `templates/index.ts` picks `TEMPLATE` from `process.env["NAIVE_TEMPLATE"]`, and that module is
 * the screens' and the public site's as much as the config's. In Node the read works, which is why
 * `naive.config.ts` reported the right template and the catalog row said `blank`. In a client
 * bundle it does not: Vite compiles a bare `process.env` to `{}`, so the screens read `undefined`
 * and fell back to this repository's default. Measured on the published catalog, `blank@0.1.0` and
 * `seo-geo@0.1.0` shipped the SAME dashboard digest and the SAME site digest — two rows, one pair
 * of trees, and an operator installing `blank` got Meridian Search's search agency instead.
 *
 * A unit test on `ACTIVE` cannot see this: it runs in Node, where the read has always worked. Only
 * the emitted bytes can, so this builds them — the one build this blueprint ships, which carries
 * two pages: the public site at `/` and the operator dashboard under `/app`.
 */
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const original = process.env["NAIVE_TEMPLATE"];

/** The build, compiled for one template. Never written: `dist` is what `pnpm build` owns. */
async function bundle(template: string): Promise<Rollup.RollupOutput> {
  process.env["NAIVE_TEMPLATE"] = template;
  return (await build({ configFile: `${root}vite.config.ts`, logLevel: "silent", build: { write: false } })) as Rollup.RollupOutput;
}

const code = (result: Rollup.RollupOutput): string =>
  result.output
    .filter((chunk): chunk is Rollup.OutputChunk => chunk.type === "chunk")
    .map((chunk) => chunk.code)
    .join("\n");

/** Compared as digests, not as text: two 200 kB bundles printed side by side say nothing. */
const digest = (code: string) => createHash("sha256").update(code).digest("hex");

afterAll(() => {
  if (original === undefined) delete process.env["NAIVE_TEMPLATE"];
  else process.env["NAIVE_TEMPLATE"] = original;
});

describe("the built app", () => {
  let blank = "";
  let seoGeo = "";
  let productDesign = "";
  let pages: string[] = [];
  const marks: Record<string, string> = {};
  const mark = (result: Rollup.RollupOutput) =>
    String(result.output.find((asset): asset is Rollup.OutputAsset => asset.type === "asset" && asset.fileName === ".naive-template")?.source);
  const chunks: Record<string, string[]> = {};
  const chunkNames = (result: Rollup.RollupOutput) =>
    result.output.filter((chunk) => chunk.type === "chunk").map((chunk) => chunk.fileName);

  beforeAll(async () => {
    const first = await bundle("blank");
    blank = code(first);
    chunks["blank"] = chunkNames(first);
    marks["blank"] = mark(first);
    pages = first.output.filter((asset) => asset.fileName.endsWith(".html")).map((asset) => asset.fileName).sort();
    const second = await bundle("seo-geo");
    seoGeo = code(second);
    chunks["seo-geo"] = chunkNames(second);
    marks["seo-geo"] = mark(second);
    const third = await bundle("product-design");
    productDesign = code(third);
    chunks["product-design"] = chunkNames(third);
    marks["product-design"] = mark(third);
  }, 180_000);

  it("emits the public site at / and the operator dashboard under /app", () => {
    expect(pages).toEqual(["app/index.html", "index.html"]);
  });

  it("is a different bundle for each template", () => {
    // The whole bug in one line. Before the `define` in the Vite configs these two bundles were
    // byte-identical, and so were the two catalog rows built from them.
    expect(digest(blank)).not.toEqual(digest(seoGeo));
    expect(new Set([digest(blank), digest(seoGeo), digest(productDesign)]).size).toBe(3);
  });

  it("ships the studio's words and its 3D viewer only in the product-design build", () => {
    // The rail's Studio entry and the Home card's link are behind a template literal the bundler folds.
    expect(productDesign).toContain("/studio");
    expect(blank).not.toContain("/studio");
    expect(seoGeo).not.toContain("/studio");
    // `<model-viewer>` brings three.js (~1 MB). It is a lazy chunk of the product-design build and is
    // not emitted at all for the other two, whose bundles carry only the Studio screen's few lines.
    expect(chunks["product-design"]!.some((name) => name.includes("model-viewer"))).toBe(true);
    for (const template of ["blank", "seo-geo"]) {
      expect([template, chunks[template]!.some((name) => name.includes("model-viewer"))]).toEqual([template, false]);
    }
    expect(blank).not.toContain("WebGLRenderer");
    expect(productDesign).toContain("WebGLRenderer");
  });

  it("names its template in dist/.naive-template, which the artifact publisher checks", () => {
    expect(marks).toEqual({ blank: "blank\n", "seo-geo": "seo-geo\n", "product-design": "product-design\n" });
  });

  it("carries the choice as a literal, not as a read the browser cannot make", () => {
    // `{}.NAIVE_TEMPLATE` is what the broken build shipped: the name survives into the bundle
    // precisely because nothing substituted it. Substituted, the name is gone and the value is in.
    expect(blank).not.toContain("NAIVE_TEMPLATE");
    expect(seoGeo).not.toContain("NAIVE_TEMPLATE");
    expect(productDesign).not.toContain("NAIVE_TEMPLATE");
    expect(productDesign).not.toContain("__AGENCY_STUDIO__");
  });
});
