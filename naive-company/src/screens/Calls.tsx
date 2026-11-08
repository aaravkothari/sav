import { PageHead } from "../components/sav";
import { AppointmentRequests } from "./Bookings";

/**
 * Calls: what callers asked the shops' receptionists for. Read server-side from the voice server
 * (`server/booking-routes.ts`), first names and masked numbers only. Sales calls with shop owners
 * are on Bookings.
 */
export function Calls() {
  return (
    <div className="pane-in">
      <PageHead
        title="Calls"
        sub="Appointments callers asked the shops' receptionists for. Shops confirm or decline them in their own portal."
      />
      <AppointmentRequests />
    </div>
  );
}
