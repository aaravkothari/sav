import "./app.css";
import "./sav.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { Gate } from "./Gate";
import { Shell } from "./Shell";
import { AgencyAgents } from "./screens/AgencyAgents";
import { Approvals } from "./screens/Approvals";
import { BookingDetail, Bookings } from "./screens/Bookings";
import { ClientAgents } from "./screens/ClientAgents";
import { ClientCalendar } from "./screens/ClientCalendar";
import { ClientConnections } from "./screens/ClientConnections";
import { ClientOverview } from "./screens/ClientOverview";
import { ClientPosts } from "./screens/ClientPosts";
import { ClientWorkspace } from "./screens/ClientWorkspace";
import { Clients } from "./screens/Clients";
import { Crm } from "./screens/Crm";
import { Home } from "./screens/Home";
import { Leads } from "./screens/Leads";
import { Overview } from "./screens/Overview";
import { Shop } from "./screens/Shop";
import { LaunchReview } from "./screens/LaunchReview";
import { Runs } from "./screens/Runs";
import { ProductAudit } from "./screens/ProductAudit";
import { Settings } from "./screens/Settings";
import { Studio } from "./screens/Studio";

// The operator dashboard lives under `/app`; `/` is the agency's public site (`site/`). The basename
// keeps every link in the screens as it was written, and the redirect from the old root paths is
// the public bundle's and the servers' (`site/routing.ts`).
const router = createBrowserRouter([
  {
    path: "/",
    Component: Shell,
    children: [
      { index: true, Component: Overview },
      { path: "leads", Component: Leads },
      { path: "leads/:id", Component: Shop },
      { path: "bookings", Component: Bookings },
      { path: "bookings/:id", Component: BookingDetail },
      { path: "bookings/:id/:n", Component: BookingDetail },
      { path: "setup", Component: Home },
      { path: "runs", Component: Runs },
      { path: "launch-review", Component: LaunchReview },
      { path: "product-audit", Component: ProductAudit },
      { path: "crm", Component: Crm },
      { path: "approvals", Component: Approvals },
      // The product-design studio's files; the rail names it only under that template (`Shell.tsx`).
      { path: "studio", Component: Studio },
      { path: "agents", Component: AgencyAgents },
      { path: "clients", Component: Clients },
      {
        path: "clients/:id",
        Component: ClientWorkspace,
        children: [
          { index: true, element: <Navigate to="overview" replace /> },
          { path: "overview", Component: ClientOverview },
          { path: "connections", Component: ClientConnections },
          { path: "calendar", Component: ClientCalendar },
          { path: "agents", Component: ClientAgents },
          { path: "posts", Component: ClientPosts },
        ],
      },
      { path: "settings", Component: Settings },
    ],
  },
], { basename: "/app" });

// The gate is outside the router on purpose: no screen mounts, and so no screen fetches, until
// `/api/session` says the browser is in (`src/Gate.tsx`).
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gate>
      <RouterProvider router={router} />
    </Gate>
  </StrictMode>,
);
