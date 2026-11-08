import { describe, expect, it } from "vitest";
import { companyBadge, readable, type CompanyState, type Run } from "./screens/Runs";

const clients = [{ id: "cli_8fee861e", slug: "pats-garage", name: "Pat's Garage - Auto Repair In San Francisco" }];

describe("a run, as the Runs screen prints it", () => {
  it("reads a card note as text: no escaped newlines, no cli_ ids, no slugs or seat names", () => {
    const note = "Filed 3 leads:\\n- cli_8fee861e (pats-garage)\\n- cli_unknown1\\nbooking--pats-garage answered ses_abc123";
    const out = readable(note, clients);
    expect(out).toBe("Filed 3 leads:\n- Pat's Garage (Pat's Garage)\n- a shop\nPats Garage receptionist answered");
    expect(out).not.toMatch(/\\n|cli_|ses_|pats-garage/);
  });

  it("puts the badge in agreement with the current run", () => {
    const company: CompanyState = { paused: false, changed_at: "", interrupted: [], deployments: [] };
    const run = (state: Run["state"]): Run => ({ run: "run-202611080130", goal: "g", created_at: "", steps: [], state });
    expect(companyBadge(company, [run("stopped")]).label).toBe("Stopped");
    expect(companyBadge(company, [run("active")]).label).toBe("Running");
    expect(companyBadge(company, []).label).toBe("No run going");
    expect(companyBadge({ ...company, paused: true }, [run("active")]).label).toBe("Paused");
  });
});
