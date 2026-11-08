import { describe, expect, it } from "vitest";
import { bookingRows } from "./bookings";
import type { Client } from "./data";
import { calendarDays } from "./screens/Bookings";

const shop = (id: string, notes: string[]) => ({ id, slug: id, name: id, notes, contact: { name: "", role: "", email: "" } }) as unknown as Client;

describe("the Bookings calendar", () => {
  it("puts a call on its Pacific day, and leaves untimed requests off the grid", () => {
    const now = new Date("2026-11-08T19:00:00Z"); // Sunday, 11 am PT
    const rows = bookingRows([
      shop("kothari", ["CALL BOOKED: 2026-11-09 15:00 PT, no calendar"]),
      shop("vague", ["CALL REQUESTED: sometime this week"]),
    ], now).filter((r) => r.upcoming);
    const days = calendarDays(rows, Date.parse("2026-11-08T20:00:00Z"));
    expect(days).toHaveLength(14);
    expect(days[0]!.key).toBe("2026-11-08");
    const monday = days.find((d) => d.key === "2026-11-09")!;
    expect(monday.rows.map((r) => r.client.id)).toEqual(["kothari"]);
    expect(days.flatMap((d) => d.rows)).toHaveLength(1);
  });
});
