/**
 * Every template this blueprint carries, and the one `TEMPLATE` chose — the config's and the
 * server's half of `templates/`.
 *
 * Kept apart from `templates/index.ts` because these modules hold the demo seed, and a seed row
 * that reached the browser bundle would be sample data presented as the operator's own
 * (`src/no-seed.test.ts`). Screens import `./index.ts`; `naive.config.ts`, `server/proxy.ts` and
 * `server/store.ts` import this.
 */
import { blank, type AgencyTemplate } from "./blank.ts";
import { TEMPLATE, type TemplateName } from "./index.ts";
import { productDesign } from "./product-design.ts";
import { seoGeo } from "./seo-geo.ts";

/** All of them, not just the chosen one: `defineProject` refuses a repo that carries only some. */
export const TEMPLATES: Record<TemplateName, AgencyTemplate> = { blank, "seo-geo": seoGeo, "product-design": productDesign };

export const ACTIVE_TEMPLATE: AgencyTemplate = TEMPLATES[TEMPLATE];
