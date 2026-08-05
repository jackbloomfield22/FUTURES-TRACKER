/* Minimal Redis client over the Upstash REST protocol. Zero dependencies.
   Vercel Marketplace Redis (Upstash) injects these env vars on connect. */

function baseUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
}
function token() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
}

export function kvConfigured() {
  return !!(baseUrl() && token());
}

async function cmd(...args) {
  const res = await fetch(baseUrl(), {
    method: "POST",
    headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error((data && data.error) || "Redis error " + res.status);
  }
  return data ? data.result : null;
}

export const kv = {
  get: (k) => cmd("GET", k),
  set: (k, v) => cmd("SET", k, v),
  setex: (k, ttlSeconds, v) => cmd("SET", k, v, "EX", ttlSeconds),
  del: (k) => cmd("DEL", k),
  keys: (pattern) => cmd("KEYS", pattern),
};
