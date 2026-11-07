import "@fontsource-variable/inter";
import "./site.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { operatorRedirect } from "../routing.ts";
import type { SiteProfile } from "../site.config.ts";
import { App } from "./App.tsx";
import { loadBlog, loadSite, type PublicPost } from "./profile.ts";
import { applyGoogleAnalytics, applySeo } from "./seo.ts";

// A pre-`/app` operator bookmark lands on the public site on a static deploy; send it on before paint.
const legacy = operatorRedirect(location.pathname);
if (legacy !== null) location.replace(`${legacy}${location.search}`);

// The palette is profile, not CSS: recolouring the whole site is an `update_site`. Applied before
// the page renders so nothing flashes.
function paint(site: SiteProfile) {
  const { palette } = site;
  for (const [key, value] of Object.entries({
    "--accent": palette.accent,
    "--accent-ink": palette.accentInk,
    "--ground": palette.ground,
    "--ink": palette.ink,
    "--muted": palette.muted,
  })) {
    document.documentElement.style.setProperty(key, value);
  }
  applySeo(site);
  applyGoogleAnalytics(site.analytics.googleMeasurementId);
}

function Site() {
  const [site, setSite] = useState<SiteProfile | null>(null);
  const [blog, setBlog] = useState<PublicPost[]>([]);
  useEffect(() => {
    void Promise.all([loadSite(), loadBlog()]).then(([profile, posts]) => {
      paint(profile);
      setSite(profile);
      setBlog(posts);
    });
  }, []);
  return site === null ? null : <App site={site} blog={blog} />;
}

if (legacy === null) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Site />
    </StrictMode>,
  );
}
