/**
 * What the crew files about a shop's AI receptionist, read back out of its CRM notes. Research
 * writes `RECEPTIONIST:` with the shop_id, demo_url and portal_url autoops-voice returned; the
 * booking seat writes `RECEPTIONIST: live` with its phone number; monitoring writes one `CALL:`
 * note per call (`templates/receptionist.ts`).
 */
export interface ReceptionistLinks {
  shopId: string | null;
  demoUrl: string | null;
  portalUrl: string | null;
  phone: string | null;
  live: boolean;
}

const field = (note: string, key: string, value: RegExp): string | null => {
  const m = new RegExp(`${key}["']?\\s*[:=]?\\s*["']?(${value.source})`, "i").exec(note);
  return m ? m[1]! : null;
};
const URL_VALUE = /https?:\/\/[^\s"',)]+/;

/** The latest value of each link across every `RECEPTIONIST:` note, or null when there is none. */
export function receptionistOf(notes: readonly string[]): ReceptionistLinks | null {
  const mine = notes.map((n) => n.trimStart()).filter((n) => n.startsWith("RECEPTIONIST:"));
  if (mine.length === 0) return null;
  const links: ReceptionistLinks = { shopId: null, demoUrl: null, portalUrl: null, phone: null, live: false };
  for (const note of mine) {
    links.shopId = field(note, "shop_id", /[\w-]+/) ?? links.shopId;
    links.demoUrl = field(note, "demo_url", URL_VALUE) ?? links.demoUrl;
    links.portalUrl = field(note, "portal_url", URL_VALUE) ?? links.portalUrl;
    links.phone = field(note, "phone_number", /\+?[\d\s().-]{7,}\d/) ?? links.phone;
    if (/^RECEPTIONIST:\s*live\b/i.test(note)) links.live = true;
  }
  return links;
}

/** Every `CALL:` note monitoring filed, newest last, as written. */
export const callsOf = (notes: readonly string[]): string[] =>
  notes.map((n) => n.trimStart()).filter((n) => n.startsWith("CALL:"));
