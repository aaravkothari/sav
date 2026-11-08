import { describe, expect, it } from "vitest";
import { firstName, OUTREACH_TEMPLATE, personalizedDetail, renderColdEmail } from "./outreach-template.ts";

const EXPECTED = [
  "Hi Pat,",
  "",
  "I came across Pat's Garage and noticed 557 of 582 Google reviews are five stars.",
  "",
  "The Automotive Service Association reportedly found that nearly 1 in 4 calls to auto repair shops go unanswered when staff are busy. How many potential customers are you losing when nobody picks up or your shop is closed?",
  "",
  "We're building SAV to answer those calls and book appointments 24/7.",
  "",
  "Would you be open to trying it for free?",
  "",
  "Best,",
  "Aarav",
].join("\n");

describe("renderColdEmail", () => {
  it("fills Aarav's template exactly: blank lines as written, nothing after the signature, no links", () => {
    const email = renderColdEmail({ shop_name: "Pat's Garage", contact_name: "Pat Banks", personalized_detail: "557 of 582 Google reviews are five stars." });
    expect(email).toEqual({ subject: "Missed calls at Pat's Garage", text: EXPECTED });
    expect(email!.text.endsWith("Best,\nAarav")).toBe(true);
    expect(email!.text).not.toMatch(/https?:|\{\{|SAV\n*$/);
  });

  it("greets 'there' when the contact has no name, or a mailbox word for one", () => {
    const text = (contact_name: string | null) => renderColdEmail({ shop_name: "X Auto", contact_name, personalized_detail: "a detail here" })!.text.split("\n")[0];
    expect(text(null)).toBe("Hi there,");
    expect(text("")).toBe("Hi there,");
    expect(text("info")).toBe("Hi there,");
    expect(text("Service Department")).toBe("Hi there,");
    expect(text("front desk")).toBe("Hi there,");
    expect(text("pat@x.com")).toBe("Hi there,");
    expect(text("patrick banta")).toBe("Hi Patrick,");
    expect(text("McKenzie Ross")).toBe("Hi McKenzie,");
  });

  it("refuses to render without a detail", () => {
    expect(renderColdEmail({ shop_name: "X Auto", contact_name: "Pat", personalized_detail: " . " })).toBeNull();
  });

  it("is the template the operator wrote", () => {
    expect(OUTREACH_TEMPLATE.split("\n")).toHaveLength(12);
    expect(OUTREACH_TEMPLATE).toContain("noticed {{personalized_detail}}.");
  });
});

describe("personalizedDetail", () => {
  it("takes the opener detail from the RESEARCH note, first letter lowered, no trailing period", () => {
    expect(personalizedDetail("RESEARCH: 4.6★ with 269 Google reviews. Fits: open late. Opener detail: 233 of its 269 reviews are five stars."))
      .toBe("233 of its 269 reviews are five stars");
    expect(personalizedDetail("RESEARCH: x. Opener detail: The shop opens at 7:30 and closes for lunch.\nNext line")).toBe("the shop opens at 7:30 and closes for lunch");
    expect(personalizedDetail("RESEARCH: x. Personalized detail: Google Reserve booking is turned on.")).toBe("Google Reserve booking is turned on");
  });

  it("gives nothing when there is no detail, or the 'detail' is an instruction to the writer", () => {
    expect(personalizedDetail("RESEARCH: 4.9 with 391 reviews. Fits: busy.")).toBeNull();
    expect(personalizedDetail("RESEARCH: x. Opener detail: the Hunter-verified owner contact is pat@patsgarage.com (Pat Banks)")).toBeNull();
    expect(personalizedDetail("RESEARCH: x. Opener detail: their blog post is a natural opener reference.")).toBeNull();
    expect(personalizedDetail("RESEARCH: x. Opener detail: ok")).toBeNull();
    expect(personalizedDetail(null)).toBeNull();
  });
});

describe("firstName", () => {
  it("keeps a real first name and drops the rest", () => {
    expect(firstName("Jim Davis")).toBe("Jim");
    expect(firstName("JIM")).toBe("Jim");
    expect(firstName("Office")).toBe("there");
    expect(firstName("J")).toBe("there");
    expect(firstName("123")).toBe("there");
  });
});
