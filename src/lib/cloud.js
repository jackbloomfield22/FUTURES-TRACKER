/* Client for the /api serverless functions on Vercel.
   Session token lives in localStorage; every data call carries it. */

const SESSION_KEY = "fb-session";
const MODE_KEY = "fb-mode"; // "device" once the user opts out of accounts

export function getSession() {
  try { return localStorage.getItem(SESSION_KEY) || ""; } catch (e) { return ""; }
}
export function setSession(t) {
  try { t ? localStorage.setItem(SESSION_KEY, t) : localStorage.removeItem(SESSION_KEY); } catch (e) { /* private mode */ }
}
export function getSavedMode() {
  try { return localStorage.getItem(MODE_KEY) || ""; } catch (e) { return ""; }
}
export function saveMode(m) {
  try { m ? localStorage.setItem(MODE_KEY, m) : localStorage.removeItem(MODE_KEY); } catch (e) { /* private mode */ }
}

async function call(path, body) {
  const headers = { "Content-Type": "application/json" };
  const token = getSession();
  if (token) headers["x-fb-session"] = token;
  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
  return data;
}

/* Reports which server features are wired up: { api, kv, odds } */
export async function health() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return { api: false };
    const data = await res.json().catch(() => null);
    if (!data || typeof data.kv === "undefined") return { api: false }; // dev server echoing index.html
    return { api: true, kv: !!data.kv, odds: !!data.odds };
  } catch (e) {
    return { api: false };
  }
}

export const authApi = {
  signup: (email, password) => call("/api/auth", { action: "signup", email, password }),
  login: (email, password) => call("/api/auth", { action: "login", email, password }),
  logout: () => call("/api/auth", { action: "logout" }),
  session: () => call("/api/auth", { action: "session" }),
};

/* A store backend with the same shape as window.storage / deviceStore,
   but persisted per-account in the Vercel Redis database. */
export function remoteStore() {
  return {
    get: (key) => call("/api/data", { op: "get", key }).then((r) => r.result),
    set: (key, value) => call("/api/data", { op: "set", key, value }).then((r) => r.result),
    delete: (key) => call("/api/data", { op: "delete", key }).then((r) => r.result),
    list: (prefix) => call("/api/data", { op: "list", prefix }).then((r) => r.result),
  };
}
