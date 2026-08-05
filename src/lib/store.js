/* One seam for all persistence. Three backends, picked at runtime:
   - artifact: window.storage inside a Claude artifact
   - cloud:    /api/data serverless functions with a signed-in account
   - device:   localStorage on this browser only
   FuturesBook talks to `store` and never cares which one is live. */

export const LEDGER_KEY = "futures-ledger-v1";

export const IS_ARTIFACT = typeof window !== "undefined" && !!window.storage;

export const deviceStore = {
  async get(k) { const v = localStorage.getItem(k); return v === null ? null : { key: k, value: v }; },
  async set(k, v) { localStorage.setItem(k, v); return { key: k, value: v }; },
  async delete(k) { localStorage.removeItem(k); return { key: k, deleted: true }; },
  async list(prefix) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!prefix || (k && k.startsWith(prefix))) keys.push(k);
    }
    return { keys };
  },
};

let active = IS_ARTIFACT ? window.storage : (typeof window !== "undefined" ? deviceStore : null);
let mode = IS_ARTIFACT ? "artifact" : "device";

/* Stable facade: existing code keeps a reference to `store`,
   AuthGate swaps the backend underneath it. */
export const store = {
  get: (...a) => active.get(...a),
  set: (...a) => active.set(...a),
  delete: (...a) => active.delete(...a),
  list: (...a) => active.list(...a),
};

export function setStore(nextBackend, nextMode) {
  active = nextBackend;
  mode = nextMode;
}

export function storeMode() {
  return mode;
}
