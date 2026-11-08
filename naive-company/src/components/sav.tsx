import type { ReactNode } from "react";
import { useMemo } from "react";
import { useApi } from "../api";
import type { Client } from "../data";
import { funnelOf, leadOf, realMail, shopName, STATUS_LABEL, type Lead, type LeadStatus, type MailMessage } from "../leads";

/** The page title block every SAV screen opens with: a serif title, one line of plain context. */
export function PageHead({ title, sub, actions, children }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="sav-head">
      <div className="min-w-0">
        {children}
        <h1 className="page-title">{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function StatusPill({ status }: { status: LeadStatus }) {
  return <span className={`sav-status s-${status}`}>{STATUS_LABEL[status]}</span>;
}

export interface MailReply {
  configured: boolean;
  messages: MailMessage[];
}

/**
 * Every lead with its derived status, from the CRM and the company inbox together. The inbox is
 * optional: without it the statuses come from the notes alone and nothing waits on it.
 */
export function useLeads() {
  const clients = useApi<Client[]>("/clients");
  const mail = useApi<MailReply>("/mail/recent");
  // Our own inbox's self-tests never reach a count, a status or the activity feed.
  const messages = useMemo(() => realMail(mail.data?.messages ?? []), [mail.data]);
  const leads = useMemo<Lead[] | null>(
    () => (clients.data === null ? null : leadRows(clients.data).map((c) => leadOf(c, messages))),
    [clients.data, messages],
  );
  const funnel = useMemo(() => (leads === null ? null : funnelOf(leads)), [leads]);
  return { leads, funnel, messages, clients: clients.data, error: clients.error, mail: mail.data, mailError: mail.error, setClients: clients.setData };
}

/** The CRM rows that are shops (a domain or an address): what every screen counts as a lead. */
export const leadRows = (clients: readonly Client[]): Client[] =>
  clients.filter((c) => c.domain.trim() !== "" || c.contact.email.trim() !== "");

/** A shop's name for the screen, without its listing's SEO tail. */
export const ShopName = ({ client }: { client: Pick<Client, "name"> }) => <span title={client.name}>{shopName(client.name)}</span>;

export const Quiet = ({ children }: { children: ReactNode }) => <p className="sav-fine">{children}</p>;
