/**
 * The deployed dashboard must never present sample rows as the operator's data (ADR-0374).
 *
 * This guard used to be a regex over import statements, and it was walked round twice: once with
 * the explicit `.ts` extension that `server/store.ts` itself writes, once with a multi-line import
 * (the pattern was `/gm`, so `.` never crossed the newline). Import *syntax* is not the thing that
 * matters, so this asks the only question that does — does a seed row reach the asset the
 * deployment serves? It bundles `src/main.tsx` the way the build does and then checks both the
 * module graph (no template module that carries a seed compiled in) and the emitted JavaScript (no
 * seed row id in the text).
 *
 * The demo rows are template data and live with their template, so this is also the line between
 * the two halves of `templates/`: the screens may read `templates/index.ts` — kinds, words, site
 * copy — and may never reach the modules below, which the config and the server import.
 *
 * `import type` is erased by the compiler and leaves neither behind, so it stays legal. Every value
 * import does, whatever its spelling — and so does a hand-pasted copy of the rows, which no import
 * regex could ever have caught.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type BuildOptions } from "esbuild";
import { describe, expect, it } from "vitest";
import type { Client } from "../seed/clients.ts";
import type { Post } from "../seed/posts.ts";
import { blank } from "../templates/blank.ts";
import { productDesign } from "../templates/product-design.ts";
import { seoGeo } from "../templates/seo-geo.ts";

const src = dirname(fileURLToPath(import.meta.url));
const root = dirname(src);

/** The modules whose contents may never ship. Paths are relative to the blueprint root. */
const FORBIDDEN = ["templates/blank.ts", "templates/seo-geo.ts", "templates/product-design.ts", "templates/active.ts"];

/** Every template's rows, not just the active one's — a switch must not make this guard blind. */
const SEED_IDS = [blank, seoGeo, productDesign].flatMap((template) => [
  ...(template.seed.clients as Client[]).map((client) => client.id),
  ...(template.seed.posts as Post[]).map((post) => post.id),
]);

/**
 * Bundle from the real entry point, or from a snippet resolved as if it were a file in `src/`.
 * `packages: "external"` leaves react and friends alone; every relative import is followed, which
 * is the graph we care about. CSS is dropped — nothing renders here, we only read the JavaScript.
 */
async function bundle(entry: { file: string } | { source: string }) {
  const options: BuildOptions =
    "file" in entry
      ? { entryPoints: [entry.file] }
      : { stdin: { contents: entry.source, resolveDir: src, loader: "ts", sourcefile: "offender.ts" } };
  const result = await build({
    ...options,
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    packages: "external",
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  const js = result.outputFiles.map((file) => file.text).join("\n");
  return {
    inputs: Object.keys(result.metafile.inputs),
    seedModules: Object.keys(result.metafile.inputs).filter((path) => FORBIDDEN.includes(path)),
    seedIds: SEED_IDS.filter((id) => js.includes(id)),
  };
}

describe("no seed row reaches the shipped dashboard bundle", () => {
  it("compiles no seed module and emits no seed row", async () => {
    const { seedModules, seedIds } = await bundle({ file: "src/main.tsx" });
    expect(seedModules).toEqual([]);
    expect(seedIds).toEqual([]);
  });

  it("is actually walking the whole app", async () => {
    // A bundle of nothing satisfies every assertion above and guards nothing.
    const { inputs } = await bundle({ file: "src/main.tsx" });
    expect(inputs.filter((path) => path.startsWith("src/screens/")).length).toBeGreaterThan(8);
    expect(SEED_IDS.length).toBeGreaterThan(8);
  });

  /**
   * The three spellings that matter: the plain one the old regex caught, and the two it did not.
   * Each must be caught by both halves of the check.
   */
  it.each([
    ["plain", 'import { blank } from "../templates/blank";\nexport const rows = blank.seed;'],
    ["explicit .ts extension", 'import { blank } from "../templates/blank.ts";\nexport const rows = blank.seed;'],
    [
      "multi-line",
      'import {\n  blank,\n  type AgencyTemplate,\n} from "../templates/blank";\nexport const rows: AgencyTemplate["seed"] = blank.seed;',
    ],
    ["through the active-template picker", 'import { ACTIVE_TEMPLATE } from "../templates/active";\nexport const rows = ACTIVE_TEMPLATE.seed;'],
  ])("catches a seed import written %s", async (_name, source) => {
    const { seedModules, seedIds } = await bundle({ source });
    expect(seedModules).toContain("templates/blank.ts");
    expect(seedIds.length).toBeGreaterThan(0);
  });

  it("still allows the screens' half of the template, and a type-only import, which is erased", async () => {
    // `templates/index.ts` is what every screen reads: kinds, words, site copy — and no rows.
    const source =
      'import type { Client } from "../seed/clients";\nimport { ACTIVE } from "../templates";\nexport const rows: Client[] = [];\nexport const words = ACTIVE.words;';
    const { seedModules, seedIds } = await bundle({ source });
    expect(seedModules).toEqual([]);
    expect(seedIds).toEqual([]);
  });

  it("catches rows pasted in by hand, with no import at all", async () => {
    const [first] = blank.seed.clients as Client[];
    const source = `export const rows = [{ id: ${JSON.stringify(first?.id)} }];`;
    expect((await bundle({ source })).seedIds).toEqual([first?.id]);
  });
});
