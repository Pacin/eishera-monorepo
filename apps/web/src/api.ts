// HTTP client for the server API. Auth flows entirely through httpOnly cookies
// (SPEC §13: no localStorage/sessionStorage) — the browser attaches them on
// same-origin requests automatically. We keep only the CSRF token in memory
// (not storage), refresh it on a 403, and silently rotate the access token on a
// 401 before retrying once.
//
// Refresh is SINGLE-FLIGHT: refresh tokens rotate and reuse is treated as theft
// (the server revokes the whole session). When several requests 401 at once
// (the poll fires /me, /housing, /boss together once the 15-min access token
// expires), they must share ONE rotation — otherwise the second/third present
// the already-rotated token and nuke the session. So all concurrent callers
// await the same in-flight refresh promise.

let csrfToken: string | null = null;

async function ensureCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const res = await fetch('/auth/csrf', { credentials: 'same-origin' });
  const body = (await res.json()) as { csrfToken: string };
  csrfToken = body.csrfToken;
  return csrfToken;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API ${status}`);
  }
}

export async function getJson<T>(path: string, retryAuth = true): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' });
  // On a 401, try a single (shared) refresh and retry once. This is what keeps a
  // page reload logged in: the 15-min access token may be expired, but the
  // 30-day refresh cookie rotates a fresh one. retryAuth=false disables this for
  // callers that want to treat 401 as a definitive "not signed in".
  if (res.status === 401 && retryAuth && (await tryRefresh())) {
    return getJson<T>(path, false);
  }
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  return (await res.json()) as T;
}

export async function postJson<T>(path: string, body?: unknown, retry = true): Promise<T> {
  const token = await ensureCsrf();
  // Only declare a JSON body when there actually is one — Fastify rejects an
  // empty body sent with `content-type: application/json` (bodyless POSTs like
  // /boss/join, /actions/refresh, /housing/cancel, /auth/logout).
  const headers: Record<string, string> = { 'csrf-token': token };
  const init: RequestInit = { method: 'POST', credentials: 'same-origin', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 403 && retry) {
    csrfToken = null; // stale CSRF — refresh and retry once
    return postJson<T>(path, body, false);
  }
  if (res.status === 401 && retry && (await tryRefresh())) {
    return postJson<T>(path, body, false);
  }
  if (!res.ok) throw new ApiError(res.status, await safeJson(res));
  return (await res.json()) as T;
}

/** Rotate the access cookie (single-flight). Exposed so the socket layer can
 *  recover a dropped connection after the 15-min access token expires. */
export function refreshSession(): Promise<boolean> {
  return tryRefresh();
}

// Rotate the access cookie via the refresh cookie. Returns true on success.
// Single-flight: concurrent callers share one rotation (see header note).
let refreshInFlight: Promise<boolean> | null = null;
function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const token = await ensureCsrf();
      const res = await fetch('/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'csrf-token': token },
      });
      return res.ok;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
