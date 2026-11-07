/**
 * MOCK behaviour for every seat. Deterministic, no network, no money.
 * Each handler is the placeholder you replace when that feature is built for real.
 */
import { planFromPipeline, type CeoBrain, type Handler, type MemberName } from "./runtime.ts";

export interface Lead {
  shop: string;
  city: string;
  phone: string;
  missed_calls_per_week: number;
}

/** The CEO hands out the board `naive up` seeds (`PIPELINE`), then reports when it is all done. */
export const mockCeo: CeoBrain = {
  plan: planFromPipeline,
  report(cards) {
    return ["All cards done. Summary:", ...cards.map((c) => `  • ${c.key} (${c.assignee}): ${c.note}`)].join("\n");
  },
};

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export const mockHandlers: Record<MemberName, Handler> = {
  research: () => {
    const leads: Lead[] = [
      { shop: "Mock Motors", city: "Austin, TX", phone: "+1-555-0101", missed_calls_per_week: 18 },
      { shop: "Example Auto Care", city: "Austin, TX", phone: "+1-555-0102", missed_calls_per_week: 11 },
      { shop: "Placeholder Garage", city: "Austin, TX", phone: "+1-555-0103", missed_calls_per_week: 7 },
    ];
    return { note: `MOCK: qualified ${leads.length} leads`, result: { leads } };
  },

  sales: ({ inputs, tool }) => {
    const { leads } = inputs.research as { leads: Lead[] };
    const drafts = leads.map((l) => ({
      to: l.shop,
      subject: `Never miss a call at ${l.shop}`,
      body: `You miss ~${l.missed_calls_per_week} calls a week. Our AI receptionist answers every one.`,
    }));
    // External action → `ask`. The card parks here until a person decides.
    const { allowed } = tool("email.send", { drafts });
    return allowed
      ? { note: `MOCK: ${drafts.length} emails "sent" (nothing left this machine); 1 reply: ${leads[0]!.shop} said yes`, result: { sent: true, interested: leads[0]! } }
      : { note: `Send denied by operator; ${drafts.length} drafts kept, nothing sent`, result: { sent: false, interested: null } };
  },

  "client-manager": ({ inputs }) => {
    const { interested } = inputs.outreach as { interested: Lead | null };
    if (!interested) return { note: "No shop to onboard (outreach was not sent)", result: { shop: null } };
    const config = {
      shop: interested.shop,
      hours: "Mon–Fri 8:00–18:00",
      services: ["oil change", "brakes", "diagnostics"],
      greeting: `Thanks for calling ${interested.shop}, how can I help?`,
    };
    return { note: `MOCK: onboarded ${interested.shop}; its receptionist is booking--${slug(interested.shop)}`, result: config };
  },

  booking: ({ inputs }) => {
    const shop = (inputs.onboarding as { shop: string | null }).shop;
    if (!shop) return { note: "No onboarded shop; skipped test call", result: { appointments: [] } };
    // In the platform this is the shop's own crew agent, `booking--<slug>`, made at onboarding.
    const appointment = { shop, customer: "Test Caller", service: "brakes", when: "Tue 10:00" };
    return { note: `MOCK: simulated call booked ${appointment.service} for ${appointment.when}`, result: { appointments: [appointment] } };
  },

  monitoring: ({ inputs }) => {
    const { appointments } = inputs["test-call"] as { appointments: unknown[] };
    const health = { calls_answered: appointments.length, bookings: appointments.length, errors: 0 };
    return { note: `MOCK: ${health.calls_answered} call(s), ${health.bookings} booking(s), ${health.errors} errors`, result: health };
  },

  "self-improvement": ({ inputs }) => {
    const health = inputs.monitoring as { bookings: number };
    const suggestions =
      health.bookings > 0
        ? ["Ask for the car's make/model during booking", "Send outreach Tue–Thu mornings"]
        : ["Outreach was not sent — review the approval step"];
    return { note: `MOCK: ${suggestions.length} suggestion(s) for the CEO`, result: { suggestions } };
  },
};
