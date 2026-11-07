/**
 * The screens' only door to the dashboard server (`server/routes.ts`).
 *
 * It does not hide failure (ADR-0374). The previous version answered a caller-supplied fallback on
 * any non-JSON response, and the fallbacks passed in were the seed rows compiled into this bundle,
 * so a dashboard whose `/api/*` routes were entirely absent presented fabricated rows as the
 * operator's real data. Now a failed call throws, the screen says what happened, and an empty
 * screen means an empty store — which is the truth about a new deployment.
 */
import { useEffect, useState } from "react";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** Said when the request never reached a server, or reached something that is not this one. */
const UNREACHABLE = "the dashboard server is unreachable";

/**
 * NOTHING HERE HOLDS A CREDENTIAL, AND THAT IS THE POINT.
 *
 * This module used to keep the app's `DASHBOARD_TOKEN` in `sessionStorage` and `prompt()` for it on
 * the first 401. That was the only way in while the token was something an operator invented — and
 * it stopped being one: the platform generates it (`canonical-spec §29.7`) and no route returns it,
 * so there is no value for a person to be asked for. What replaced the box is one click in the
 * studio, which posts a short-lived ticket to `/api/enter`; the server answers with an `HttpOnly`
 * cookie the browser then attaches to every same-origin call below on its own.
 *
 * So no `authorization` header is sent, and a 401 is not a prompt any more — it is the honest
 * sentence the server wrote, rendered by whichever screen asked. A signed-out browser should not
 * reach one at all: `src/Gate.tsx` asks `GET /api/session` before any screen mounts, and draws
 * the sign-in page (the studio's handoff, or the dashboard password as a plain HTML form) instead.
 */

async function call<T>(path: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiError(0, UNREACHABLE);
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(await res.text());
  } catch {
    // A 404 served as the SPA's index.html lands here: not JSON, so not this server's answer.
  }
  if (!res.ok) throw new ApiError(res.status, (parsed as { error?: string } | null)?.error ?? UNREACHABLE);
  if (parsed === null) throw new ApiError(res.status, UNREACHABLE);
  return parsed as T;
}

export const apiGet = <T>(path: string): Promise<T> => call<T>(path, { headers: { accept: "application/json" } });

export const apiSend = <T>(method: string, path: string, body?: unknown): Promise<T> =>
  call<T>(path, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The sentence a screen shows for a failed call, whatever was thrown. */
export const apiMessage = (error: unknown): string => (error instanceof ApiError ? error.message : UNREACHABLE);

/**
 * One GET, held the way every screen holds it: `null` while it is in flight (the screen shows its
 * skeleton), a sentence when it failed (the screen shows that), an array when it worked — empty
 * included, which renders the screen's empty state.
 */
export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void apiGet<T>(path)
      .then((rows) => { if (live) setData(rows); })
      .catch((err: unknown) => { if (live) setError(apiMessage(err)); });
    return () => { live = false; };
  }, [path]);
  return { data, error, setData, setError };
}
