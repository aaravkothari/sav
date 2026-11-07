/**
 * THE GATE SCREEN: nothing gated renders until `GET /api/session` says this browser is in.
 *
 * Before it, a signed-out operator saw the whole dashboard drawn empty, with "missing or invalid
 * access token" in every card — the routes were gated but the screens were not, and the shape of
 * the app was the only thing telling them so. Now the first and only request on boot is
 * `/api/session`, and until it answers `authenticated`, this is the page.
 *
 * Two doors, in this order:
 *   1. **The studio, automatically.** When the server names the studio that installed this app
 *      (`studio_url`), the browser is sent there ONCE; the studio signs the operator in and hands
 *      the browser back through `/api/enter` with a ticket. Once, because a studio that cannot
 *      hand the browser back (signed out there too, a colleague's browser) would otherwise loop —
 *      the attempt is remembered in `sessionStorage` for the life of the tab.
 *   2. **The password.** A plain `<form method="post">` to `/api/enter`: the browser posts it as a
 *      navigation, the server answers a cookie and a redirect, and the value never passes through
 *      this bundle's JavaScript. Shown only when the server says a password exists.
 *
 * `entry=denied` is how `/api/enter` sends a refused form back here, and it also disables the
 * automatic bounce: a browser that just came back refused should be shown the sentence, not sent
 * around again.
 *
 * FRAMED, the studio shows this dashboard inside its own page. A frame never bounces: a redirect
 * to the studio from inside the studio would be refused or nest it in itself. It gets the form,
 * and the studio link opens in the top window (`target="_top"`) instead.
 *
 * Framed cross-site with third-party storage blocked (an Incognito window, Brave), merely touching
 * `sessionStorage` throws a `SecurityError` while the partitioned cookie keeps working. Every read
 * and write of the flag is therefore guarded, and a store that cannot be read counts as "already
 * attempted": the gate is drawn rather than the page bouncing or coming up blank.
 */
import { useEffect, useState, type ReactNode } from "react";
import { apiGet, apiMessage } from "./api";

export interface Session {
  authenticated: boolean;
  studio_url: string | null;
  password_enabled: boolean;
}

/** Set on the automatic bounce; cleared once a session answers `authenticated`. */
export const ATTEMPTED = "naive.entry.attempted";

const DENIED = "That didn't check out — try again or use your dashboard password.";

/** Whether this tab already bounced once. A storage that throws reads as "yes": nothing may bounce twice. */
function readAttempted(): boolean {
  try {
    return window.sessionStorage.getItem(ATTEMPTED) !== null;
  } catch {
    return true;
  }
}

function markAttempted(): void {
  try {
    window.sessionStorage.setItem(ATTEMPTED, "1");
  } catch {
    // Storage denied: `readAttempted` already answers "attempted" for this tab.
  }
}

function clearAttempted(): void {
  try {
    window.sessionStorage.removeItem(ATTEMPTED);
  } catch {
    // Storage denied: there was nothing stored to clear.
  }
}

type State = { kind: "asking" } | { kind: "answered"; session: Session } | { kind: "failed"; message: string };

export function Gate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "asking" });
  const denied = new URLSearchParams(location.search).get("entry") === "denied";
  const framed = window.self !== window.top;
  const session = state.kind === "answered" ? state.session : null;
  const bouncing = session !== null && !session.authenticated && session.studio_url !== null
    && !framed && !denied && !readAttempted();

  useEffect(() => {
    let live = true;
    void apiGet<Session>("/session")
      .then((answer) => { if (live) setState({ kind: "answered", session: answer }); })
      .catch((err: unknown) => { if (live) setState({ kind: "failed", message: apiMessage(err) }); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (session === null) return;
    if (session.authenticated) return clearAttempted();
    // Re-read the flag here rather than trusting `bouncing`: an effect may run more than once for
    // one render, and the bounce must happen exactly once per tab.
    if (bouncing && session.studio_url !== null && !readAttempted()) {
      markAttempted();
      location.assign(session.studio_url);
    }
  }, [session, bouncing]);

  if (session?.authenticated) return <>{children}</>;
  if (state.kind === "asking" || bouncing) return <Frame />;
  if (state.kind === "failed") {
    return (
      <Frame>
        <p className="text-sm text-fail">{state.message}</p>
      </Frame>
    );
  }
  const { studio_url, password_enabled } = state.session;
  return (
    <Frame>
      {denied ? <p className="text-sm text-fail">{DENIED}</p> : null}
      {studio_url !== null ? (
        <a className="btn btn-primary" href={studio_url} target={framed ? "_top" : undefined}>Open in the Studio</a>
      ) : null}
      {password_enabled ? (
        <form method="post" action="/api/enter" className="mt-2 space-y-3">
          <label className="block">
            <span className="field-label">Dashboard password</span>
            <input className="input" type="password" name="password" autoComplete="current-password" required />
          </label>
          <button type="submit" className={`btn ${studio_url === null ? "btn-primary" : "btn-ghost"}`}>
            Sign in with the password
          </button>
        </form>
      ) : null}
      {studio_url === null && !password_enabled ? (
        <p className="text-sm text-ink-2">This dashboard is opened from the Naive Studio that installed it.</p>
      ) : null}
    </Frame>
  );
}

/** The one full-screen frame every gate state is drawn in; empty while the answer is in flight. */
function Frame({ children }: { children?: ReactNode }) {
  return (
    <main className="flex h-dvh items-center justify-center bg-ground p-6">
      {children === undefined ? null : (
        <section className="panel w-full max-w-sm space-y-4 p-6">
          <div>
            <h1 className="page-title">Sign in to your dashboard</h1>
            <p className="mt-1 text-sm text-ink-2">The CRM, the queue and the crew are behind this door.</p>
          </div>
          {children}
        </section>
      )}
    </main>
  );
}
