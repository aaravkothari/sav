import type { ReactNode } from "react";
import { useMemo } from "react";
import { useApi } from "../api";
import type { Client } from "../data";
import { leadOf, STATUS_LABEL, type Lead, type LeadStatus, type MailMessage } from "../leads";

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
  const messages = mail.data?.messages ?? [];
  const leads = useMemo<Lead[] | null>(
    () => (clients.data === null ? null : clients.data.filter((c) => c.domain.trim() !== "" || c.contact.email.trim() !== "").map((c) => leadOf(c, messages))),
    [clients.data, messages],
  );
  return { leads, clients: clients.data, error: clients.error, mail: mail.data, mailError: mail.error, setClients: clients.setData };
}

export const Quiet = ({ children }: { children: ReactNode }) => <p className="sav-fine">{children}</p>;
