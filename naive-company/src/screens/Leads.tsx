import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { PageHead, ShopName, StatusPill, useLeads } from "../components/sav";
import { ago, leadPath, shopName, STATUS_LABEL, STATUSES, type Lead, type LeadStatus } from "../leads";

/**
 * Every shop the crew has found, in one table: where it is, what kind of shop, who to talk to,
 * how far it has got, and when anything last happened. Search, filter by status and by sector,
 * sort by any column; a row opens the shop. The filters live in the address, so the overview's
 * funnel can link straight to "everyone who replied".
 */

type SortKey = "shop" | "city" | "sector" | "contact" | "status" | "last";
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "shop", label: "Shop" },
  { key: "city", label: "City" },
  { key: "sector", label: "Sector" },
  { key: "contact", label: "Contact" },
  { key: "status", label: "Status" },
  { key: "last", label: "Last activity" },
];
const FILTERS: LeadStatus[] = [...STATUSES, "bounced"];

const text = (s: string | null | undefined) => (s ?? "").toLowerCase();

function compare(a: Lead, b: Lead, key: SortKey): number {
  switch (key) {
    case "shop": return shopName(a.client.name).localeCompare(shopName(b.client.name));
    case "city": return (a.city ?? "~").localeCompare(b.city ?? "~");
    case "sector": return a.sector.localeCompare(b.sector);
    case "contact": return (a.client.contact.name || a.client.contact.email || "~").localeCompare(b.client.contact.name || b.client.contact.email || "~");
    case "status": return a.rank - b.rank || (a.status === "bounced" ? -1 : 0) - (b.status === "bounced" ? -1 : 0);
    case "last": return (a.lastAt ?? "").localeCompare(b.lastAt ?? "");
  }
}

export function Leads() {
  const { leads, funnel, error, mail } = useLeads();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get("q") ?? "";
  const status = (params.get("status") ?? "") as LeadStatus | "";
  const sector = params.get("sector") ?? "";
  // "reached" is the overview funnel's link: every shop at that step or past it.
  const reached = STATUSES.indexOf((params.get("reached") ?? "") as (typeof STATUSES)[number]);
  const sort = (params.get("sort") ?? "last") as SortKey;
  const dir = params.get("dir") === "asc" ? 1 : -1;

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };
  const sortBy = (key: SortKey) => {
    const next = new URLSearchParams(params);
    const flip = sort === key ? (dir === 1 ? "desc" : "asc") : key === "last" || key === "status" ? "desc" : "asc";
    next.set("sort", key);
    next.set("dir", flip);
    setParams(next, { replace: true });
  };

  const sectors = useMemo(() => [...new Set((leads ?? []).map((l) => l.sector))].sort(), [leads]);
  const counts = useMemo(() => {
    const out = new Map<LeadStatus, number>();
    for (const l of leads ?? []) out.set(l.status, (out.get(l.status) ?? 0) + 1);
    return out;
  }, [leads]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (leads ?? [])
      .filter((l) => status === "" || l.status === status)
      .filter((l) => reached < 0 || l.rank >= reached)
      .filter((l) => sector === "" || l.sector === sector)
      .filter((l) => needle === "" || [l.client.name, l.client.domain, l.city, l.client.contact.name, l.client.contact.email, l.sector]
        .some((v) => text(v).includes(needle)))
      .sort((a, b) => dir * compare(a, b, sort) || a.client.name.localeCompare(b.client.name));
  }, [leads, q, status, sector, sort, dir, reached]);

  const sortValue = `${sort}:${dir === 1 ? "asc" : "desc"}`;
  const pickSort = (value: string) => {
    const [key, d] = value.split(":");
    const next = new URLSearchParams(params);
    next.set("sort", key!);
    next.set("dir", d!);
    setParams(next, { replace: true });
  };

  return (
    <div className="pane-in">
      <PageHead
        title="Leads"
        sub={funnel === null
          ? "Every shop the crew has found and written to."
          : `${funnel.shops} shops found, ${funnel.emailed} emailed${funnel.bounced > 0 ? ` (${funnel.bounced} bounced)` : ""}, ${funnel.replied} replied. The chips count where each shop is now.`}
      />

      <div className="sav-filters">
        <label className="sav-search">
          <Search size={16} strokeWidth={1.6} aria-hidden="true" />
          <input type="search" placeholder="Search shops, cities, contacts" value={q} onChange={(e) => set("q", e.target.value)} aria-label="Search leads" />
        </label>
        <select className="sav-select" value={sector} onChange={(e) => set("sector", e.target.value)} aria-label="Sector">
          <option value="">All sectors</option>
          {sectors.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {/* The table's headers sort on a laptop; a phone has no headers, so it gets this. */}
        <select className="sav-select sav-sort-phone" value={sortValue} onChange={(e) => pickSort(e.target.value)} aria-label="Sort">
          <option value="last:desc">Newest activity</option>
          <option value="last:asc">Oldest activity</option>
          <option value="status:desc">Furthest along</option>
          <option value="shop:asc">Shop, A to Z</option>
          <option value="city:asc">City, A to Z</option>
        </select>
      </div>
      <div className="sav-chips" role="group" aria-label="Status">
        <button type="button" className="sav-chip" aria-pressed={status === ""} onClick={() => set("status", "")}>
          All<span className="n">{leads?.length ?? ""}</span>
        </button>
        {FILTERS.filter((s) => s !== "bounced" || counts.has("bounced")).map((s) => (
          <button key={s} type="button" className="sav-chip" aria-pressed={status === s} onClick={() => set("status", status === s ? "" : s)}>
            {STATUS_LABEL[s]}<span className="n">{counts.get(s) ?? 0}</span>
          </button>
        ))}
      </div>

      {reached >= 0 ? (
        <p className="mb-3 text-[14px] text-ink-2">
          Showing every shop that has reached <strong className="font-bold">{STATUS_LABEL[STATUSES[reached]!].toLowerCase()}</strong> or gone further.{" "}
          <button type="button" className="sav-more p-0" onClick={() => set("reached", "")}>Show all</button>
        </p>
      ) : null}
      <section className="sav-card flush">
        {leads === null ? (
          <p className="p-6 sav-sub">{error ? `The CRM could not be read: ${error}.` : "Reading the CRM…"}</p>
        ) : rows.length === 0 ? (
          <p className="p-6 sav-sub">{leads.length === 0 ? "No shops yet. Research files them here as it finds them." : "No shop matches these filters."}</p>
        ) : (
          <>
            <div className="sav-table-wrap overflow-x-auto">
              <table className="sav-table">
                <thead>
                  <tr>
                    {COLUMNS.map((c) => (
                      <th key={c.key} aria-sort={sort === c.key ? (dir === 1 ? "ascending" : "descending") : "none"}>
                        <button type="button" className={sort === c.key ? "on" : ""} onClick={() => sortBy(c.key)}>
                          {c.label}
                          {sort === c.key ? (dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : null}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.client.id} onClick={() => navigate(leadPath(l.client))}>
                      <td className="shop">
                        <Link to={leadPath(l.client)} onClick={(e) => e.stopPropagation()}><ShopName client={l.client} /></Link>
                        {/[a-z0-9]{20,}/i.test(l.client.domain) ? null : <small>{l.client.domain}</small>}
                      </td>
                      <td className="muted nowrap">{l.city ?? "—"}</td>
                      <td className="muted nowrap">{l.sector}</td>
                      <td>
                        {l.client.contact.name ? <div>{l.client.contact.name}</div> : null}
                        <div className="muted text-[13px]">{l.client.contact.email || "No email yet"}</div>
                      </td>
                      <td className="nowrap">
                        <StatusPill status={l.status} />
                        {l.demoReady && l.rank < 3 ? <span className="sav-tag plain ml-1.5">demo ready</span> : null}
                      </td>
                      <td className="muted last">
                        {l.lastAt ? <div className="nowrap">{ago(l.lastAt)}</div> : null}
                        {l.lastEvent ? <div className="text-[13px] text-ink-3 line-clamp-1 max-w-[16rem]">{l.lastEvent}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sav-rows">
              {rows.map((l) => (
                <Link key={l.client.id} to={leadPath(l.client)}>
                  <div className="top">
                    <span className="name">{shopName(l.client.name)}</span>
                    <StatusPill status={l.status} />
                  </div>
                  <div className="mt-1 text-[13.5px] text-ink-2">
                    {[l.city, l.sector].filter(Boolean).join(" · ")}
                    {l.client.contact.email ? ` · ${l.client.contact.name || l.client.contact.email}` : ""}
                  </div>
                  {l.lastEvent ? <div className="mt-1 text-[13px] text-ink-3">{l.lastEvent}{l.lastAt ? `, ${ago(l.lastAt)}` : ""}</div> : null}
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
      {mail && !mail.configured ? (
        <p className="mt-3 sav-fine">The company inbox is not connected here, so statuses come from the crew's notes alone.</p>
      ) : null}
    </div>
  );
}
