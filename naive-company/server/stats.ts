/**
 * `GET /api/stats`: the company's live counts for the public landing page (PlumGlacier).
 *
 * Counts only, never a name, an email, a note or an id, so it is safe to serve to anyone and to
 * cache. Each count is derived from the note prefixes the crew already writes on CRM records
 * (`templates/receptionist.ts`), so a number on the landing page is always something an agent did
 * and filed, not a figure someone typed in.
 *
 * Emails sent counts the crew's `OUTREACH SENT` and `REPLY SENT` notes. Self-improvement proposals
 * live on the CEO's Naïve board, not in this store, so that count is `null`: "not tracked here",
 * which is honest; a 0 would be a claim.
 */
import type { Client } from "../seed/clients.ts";

export interface CompanyStats {
  leads_found: number;
  demos_built: number;
  drafts_written: number;
  free_week_yes: number;
  calls_reviewed: number;
  emails_sent: number;
  /** `BOUNCED:` notes: emails that came back undelivered (the engine's ramp steps down on them). */
  bounces: number;
  /** `REPLY RECEIVED:` notes: replies shops sent us. */
  replies: number;
  self_improvement_proposals: null;
  updated_at: string;
}

const PREFIX = {
  research: "RESEARCH:",
  receptionist: "RECEPTIONIST:",
  drafted: "OUTREACH DRAFTED",
  sent: "OUTREACH SENT",
  replied: "REPLY SENT",
  yes: "SAID YES:",
  call: "CALL:",
  bounced: "BOUNCED:",
  received: "REPLY RECEIVED",
} as const;

const notesOf = (client: Client) => client.notes.map((note) => note.trimStart());
const shopsWith = (clients: readonly Client[], prefix: string) =>
  clients.filter((client) => notesOf(client).some((note) => note.startsWith(prefix))).length;
const notesWith = (clients: readonly Client[], prefix: string) =>
  clients.reduce((total, client) => total + notesOf(client).filter((note) => note.startsWith(prefix)).length, 0);

export function companyStats(clients: readonly Client[], now: Date): CompanyStats {
  return {
    leads_found: shopsWith(clients, PREFIX.research),
    demos_built: shopsWith(clients, PREFIX.receptionist),
    drafts_written: notesWith(clients, PREFIX.drafted),
    free_week_yes: shopsWith(clients, PREFIX.yes),
    calls_reviewed: notesWith(clients, PREFIX.call),
    emails_sent: notesWith(clients, PREFIX.sent) + notesWith(clients, PREFIX.replied),
    bounces: notesWith(clients, PREFIX.bounced),
    replies: notesWith(clients, PREFIX.received),
    self_improvement_proposals: null,
    updated_at: now.toISOString(),
  };
}
