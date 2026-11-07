/**
 * The contact form's one job: turn the form into the dashboard server's
 * `LeadInput` and POST it to `/api/leads`. When the server isn't running
 * (static deploy, local preview) it degrades to "offline" and the form shows
 * the direct-email fallback instead of an error.
 */

export interface ContactForm {
  company: string;
  website: string;
  name: string;
  email: string;
  services: string[];
  note: string;
}

export interface LeadInput {
  name: string;
  domain: string;
  contact: { name: string; email: string; role: string };
  services?: string[];
  note?: string;
  /** A referral link's code; the server alone decides whether it names a client. */
  ref?: string;
}

/**
 * The code a visitor arrived with (`/?ref=…`), kept for the browser session so a visitor who reads
 * on before writing in is still credited to the client who sent them. Storage can be refused
 * (private windows), and then only the current URL counts.
 */
export function referralCode(search: string = globalThis.location?.search ?? ""): string | undefined {
  const fromUrl = new URLSearchParams(search).get("ref") || undefined;
  try {
    if (fromUrl) sessionStorage.setItem("ref", fromUrl);
    return fromUrl ?? sessionStorage.getItem("ref") ?? undefined;
  } catch {
    return fromUrl;
  }
}

export function toLeadInput(form: ContactForm, ref?: string): LeadInput {
  const domain = form.website
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return {
    name: form.company.trim(),
    domain,
    contact: { name: form.name.trim(), email: form.email.trim(), role: "Site inquiry" },
    ...(form.services.length > 0 ? { services: form.services } : {}),
    ...(form.note.trim() === "" ? {} : { note: form.note.trim() }),
    ...(ref ? { ref } : {}),
  };
}

export type SubmitResult = "sent" | "offline";

export async function submitLead(form: ContactForm, doFetch: typeof fetch = fetch, ref: string | undefined = referralCode()): Promise<SubmitResult> {
  try {
    const res = await doFetch("/api/leads", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(toLeadInput(form, ref)),
    });
    return res.ok && (res.headers.get("content-type")?.includes("application/json") ?? false) ? "sent" : "offline";
  } catch {
    return "offline";
  }
}
