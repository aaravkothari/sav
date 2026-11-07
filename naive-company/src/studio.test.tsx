// @vitest-environment jsdom
/**
 * The product-design studio's screen, rendered: a deliverable is files, and the operator decides on
 * the files — the still as an image, the concept mesh in `<model-viewer>`, a part's STEP and STL as
 * downloads. And the rail offers the screen only to the template that files such deliverables.
 *
 * The template is a build-time constant (`vite.config.ts`'s `define`), read once at import, so each
 * case imports the screens fresh under the `NAIVE_TEMPLATE` it is about.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";

// three.js has no WebGL in jsdom; the element's registration is not what is under test.
vi.mock("@google/model-viewer", () => ({}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const original = process.env["NAIVE_TEMPLATE"];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = "";
  if (original === undefined) delete process.env["NAIVE_TEMPLATE"];
  else process.env["NAIVE_TEMPLATE"] = original;
});

type Reply = { status?: number; body: unknown };

async function render(template: string, at: string, route: (path: string, init?: RequestInit) => Reply) {
  process.env["NAIVE_TEMPLATE"] = template;
  vi.resetModules();
  const { Shell } = (await import("./Shell")) as { Shell: ComponentType };
  const { Studio } = (await import("./screens/Studio")) as { Studio: ComponentType };
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal("fetch", ((url: string, init?: RequestInit) => {
    calls.push({ path: String(url), init });
    const { status = 200, body } = route(String(url), init);
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch);
  const host = document.createElement("div");
  document.body.append(host);
  const routes = [{ path: "/", Component: Shell, children: [{ path: "studio", Component: Studio }] }];
  await act(async () => {
    createRoot(host).render(<RouterProvider router={createMemoryRouter(routes, { initialEntries: [at] })} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const text = () => (host.textContent ?? "").replace(/\s+/g, " ").trim();
  const press = async (label: string) => {
    const target = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
    if (!target) throw new Error(`no button ${label} in: ${text()}`);
    await act(async () => { target.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  };
  return { host, text, press, calls };
}

const concept = {
  id: "post_c1", clientId: "cli_1", title: "Carafe — concept", summary: "Sand ceramic carafe, walnut lid.", kind: "concept",
  channel: "studio", status: "pending", agent: "visualizer", scheduledFor: "2026-10-30", hue: 10, files: ["fil_glb1", "fil_png1"],
};
const part = {
  id: "post_p1", clientId: "cli_1", title: "Rod bracket", summary: "bbox_mm 60 × 40 × 35.2, volume_cm3 21.4", kind: "part",
  channel: "studio", status: "pending", agent: "engineer", scheduledFor: "2026-10-30", hue: 20, files: ["fil_step1", "fil_stl1"],
};
const blog = { ...concept, id: "post_b1", channel: "blog", kind: "article", title: "Not a studio row", files: undefined };
const META: Record<string, { name: string; content_type: string }> = {
  fil_glb1: { name: "carafe.glb", content_type: "model/gltf-binary" },
  fil_png1: { name: "carafe-still.png", content_type: "image/png" },
  fil_step1: { name: "bracket.step", content_type: "application/step" },
  fil_stl1: { name: "bracket.stl", content_type: "model/stl" },
};

const studioApi = (path: string, init?: RequestInit): Reply => {
  const meta = /^\/api\/files\/(fil_\w+)\/meta$/.exec(path);
  if (meta) return { body: { id: meta[1], size_bytes: 10, ...META[meta[1]!]! } };
  if (path === "/api/posts" && !init?.method) return { body: [blog, concept, part] };
  if (path === "/api/posts/post_c1" && init?.method === "PATCH") return { body: { ...concept, status: JSON.parse(String(init.body)).status } };
  if (path === "/api/clients") return { body: [{ id: "cli_1", slug: "acme", name: "Acme Homeware", domain: "acme.example", stage: "active", services: [], contact: { name: "", email: "", role: "" }, notes: [] }] };
  return { body: { data: [] } };
};

describe("the Studio screen", () => {
  it("shows each studio deliverable newest first, with every file in the form it can be judged in", async () => {
    const screen = await render("product-design", "/studio", studioApi);
    const titles = [...screen.host.querySelectorAll("article h2")].map((h) => h.textContent);
    expect(titles).toEqual(["Rod bracket", "Carafe — concept"]);
    expect(screen.text()).not.toContain("Not a studio row");
    expect(screen.text()).toContain("Acme Homeware");
    // The still is an image, the mesh a model-viewer, the part's files downloads — all through the proxy.
    expect(screen.host.querySelector("img")?.getAttribute("src")).toBe("/api/files/fil_png1");
    const viewer = screen.host.querySelector("model-viewer");
    expect(viewer?.getAttribute("src")).toBe("/api/files/fil_glb1");
    expect(viewer?.hasAttribute("camera-controls")).toBe(true);
    const downloads = [...screen.host.querySelectorAll("a[download]")].map((a) => [a.getAttribute("href"), a.getAttribute("download")]);
    expect(downloads).toEqual(expect.arrayContaining([
      ["/api/files/fil_step1", "bracket.step"],
      ["/api/files/fil_stl1", "bracket.stl"],
    ]));
    // A STEP is not drawn as an image or a mesh.
    expect(screen.host.querySelectorAll("img")).toHaveLength(1);
    expect(screen.host.querySelectorAll("model-viewer")).toHaveLength(1);
  });

  it("approves with the queue's own PATCH, and posts nothing", async () => {
    const screen = await render("product-design", "/studio", studioApi);
    const approve = [...screen.host.querySelectorAll("article")].find((a) => a.textContent?.includes("Carafe"))!.querySelector("button.btn-primary")!;
    await act(async () => { (approve as HTMLButtonElement).click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    const writes = screen.calls.filter((c) => c.init?.method !== undefined);
    expect(writes.map((c) => [c.init?.method, c.path, JSON.parse(String(c.init?.body))])).toEqual([["PATCH", "/api/posts/post_c1", { status: "approved" }]]);
    expect(screen.calls.some((c) => c.path.includes("post-now") || c.path.includes("/social/"))).toBe(false);
    expect(screen.text()).toContain("Approved");
    // An approved studio file is done: nothing publishes it, so it never reads "pending publish".
    expect(screen.text()).not.toContain("pending publish");
  });

  it("says a file could not be read rather than drawing a broken one", async () => {
    const screen = await render("product-design", "/studio", (path, init) =>
      path.endsWith("/meta") ? { status: 503, body: { error: "not configured — set NAIVE_API_KEY" } } : studioApi(path, init));
    expect(screen.text()).toContain("Could not read fil_glb1: not configured — set NAIVE_API_KEY");
    expect(screen.host.querySelector("model-viewer")).toBeNull();
  });
});

describe("the rail", () => {
  const navLabels = (host: HTMLElement) => [...host.querySelectorAll("nav a")].map((a) => (a.textContent ?? "").trim());

  it("offers Studio under product-design", async () => {
    const screen = await render("product-design", "/studio", studioApi);
    expect(navLabels(screen.host)).toContain("Studio");
  });

  it.each(["blank", "seo-geo"])("offers no Studio under %s", async (template) => {
    const screen = await render(template, "/studio", studioApi);
    expect(navLabels(screen.host)).not.toContain("Studio");
  });
});
