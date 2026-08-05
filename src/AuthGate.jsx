import React, { useState, useEffect } from "react";
import { IS_ARTIFACT, deviceStore, setStore, LEDGER_KEY } from "./lib/store.js";
import { health, authApi, remoteStore, getSession, setSession, getSavedMode, saveMode } from "./lib/cloud.js";

/* AuthGate decides which storage backend the book runs on, then mounts it.
   - Artifact: straight in, window.storage already scoped to the user.
   - Cloud available (Redis wired up on Vercel): show the members window
     (sign in / open an account / stay on this device).
   - No backend: straight in on device storage, no fake login. */

async function migrateDeviceBook(remote) {
  /* First sign-in on a device that already has a book: copy it up
     so nothing is lost. Cloud data wins if it already exists. */
  try {
    const existing = await remote.get(LEDGER_KEY);
    const local = await deviceStore.get(LEDGER_KEY);
    if (!existing && local && local.value) {
      await remote.set(LEDGER_KEY, local.value);
      const slips = await deviceStore.list("slip:");
      for (const k of (slips.keys || []).slice(0, 40)) {
        try {
          const s = await deviceStore.get(k);
          if (s && s.value) await remote.set(k, s.value);
        } catch (e) { /* skip oversized slip */ }
      }
      return true;
    }
  } catch (e) { /* migration is best-effort */ }
  return false;
}

export default function AuthGate({ children }) {
  const [phase, setPhase] = useState("checking"); // checking | gate | app
  const [account, setAccount] = useState(null); // email when signed in
  const [cloudReady, setCloudReady] = useState(false);
  const [tab, setTab] = useState("login"); // login | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [migrated, setMigrated] = useState(false);

  useEffect(() => {
    (async () => {
      if (IS_ARTIFACT) { setPhase("app"); return; }
      const h = await health();
      const ready = h.api && h.kv;
      setCloudReady(ready);
      if (!ready) { setPhase("app"); return; } // device mode, no gate to fake
      if (getSession()) {
        try {
          const s = await authApi.session();
          if (s.email) {
            const remote = remoteStore();
            setStore(remote, "cloud");
            setAccount(s.email);
            setPhase("app");
            return;
          }
        } catch (e) { setSession(""); }
      }
      if (getSavedMode() === "device") { setPhase("app"); return; }
      setPhase("gate");
    })();
  }, []);

  async function submit() {
    setErr("");
    setBusy(true);
    try {
      const fn = tab === "signup" ? authApi.signup : authApi.login;
      const r = await fn(email, password);
      setSession(r.token);
      saveMode("");
      const remote = remoteStore();
      const moved = await migrateDeviceBook(remote);
      setMigrated(moved);
      setStore(remote, "cloud");
      setAccount(r.email);
      setPhase("app");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  function useDevice() {
    saveMode("device");
    setPhase("app");
  }

  async function signOut() {
    try { await authApi.logout(); } catch (e) { /* session may already be gone */ }
    setSession("");
    saveMode("");
    window.location.reload(); // clean remount on device storage
  }

  if (phase === "checking") {
    return (
      <div className="gate-root">
        <style>{gateCss}</style>
        <div className="gate-checking">FUTURES BOOK</div>
      </div>
    );
  }

  if (phase === "gate") {
    return (
      <div className="gate-root">
        <style>{gateCss}</style>
        <div className="gate-card">
          <div className="gate-brand">
            <span className="gate-brand-main">FUTURES</span>
            <span className="gate-brand-sub">BOOK</span>
          </div>
          <div className="gate-window-label">Members window</div>
          <div className="gate-tabs">
            <button className={tab === "login" ? "active" : ""} onClick={() => { setTab("login"); setErr(""); }}>Sign in</button>
            <button className={tab === "signup" ? "active" : ""} onClick={() => { setTab("signup"); setErr(""); }}>Open an account</button>
          </div>
          <label className="gate-field">
            <span>Email</span>
            <input type="email" autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </label>
          <label className="gate-field">
            <span>Password</span>
            <input type="password" autoComplete={tab === "signup" ? "new-password" : "current-password"}
              value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !busy) submit(); }}
              placeholder={tab === "signup" ? "8+ characters" : "Your password"} />
          </label>
          {err && <p className="gate-err">{err}</p>}
          <button className="gate-go" onClick={submit} disabled={busy || !email || !password}>
            {busy ? "Working…" : tab === "signup" ? "Open my book" : "Sign in"}
          </button>
          <p className="gate-note">
            {tab === "signup"
              ? "Your book syncs to every device you sign in on. Any tickets already on this device come with you."
              : "Your book follows your account across devices."}
          </p>
          <button className="gate-skip" onClick={useDevice}>Skip: keep my book on this device only</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{gateCss}</style>
      <div className="gate-bar">
        {account ? (
          <>
            <span className="gate-bar-mode">Synced</span>
            <span className="gate-bar-id">{account}</span>
            {migrated && <span className="gate-bar-note">Device tickets imported</span>}
            <button onClick={signOut}>Sign out</button>
          </>
        ) : IS_ARTIFACT ? null : (
          <>
            <span className="gate-bar-mode dim">This device only</span>
            {cloudReady && <button onClick={() => { saveMode(""); setPhase("gate"); }}>Sign in to sync</button>}
          </>
        )}
      </div>
      {children}
    </>
  );
}

const gateCss = `
body { background: #0c231c; margin: 0; }
.gate-root {
  min-height: 100vh;
  background:
    radial-gradient(1200px 500px at 50% -10%, rgba(217,164,65,0.07), transparent 60%),
    #0c231c;
  display: flex; align-items: center; justify-content: center;
  padding: 24px 16px;
  font-family: 'Barlow', system-ui, sans-serif;
}
.gate-checking {
  color: #d9a441; font-family: 'Barlow Condensed', sans-serif;
  font-weight: 700; font-size: 28px; letter-spacing: 6px;
  animation: gatePulse 1.2s ease-in-out infinite alternate;
}
@keyframes gatePulse { from { opacity: 0.5; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .gate-checking { animation: none; } }

.gate-card {
  width: 100%; max-width: 380px;
  background: #f5f1e4; color: #1d1f1b;
  border-radius: 10px; padding: 26px 24px 20px;
  box-shadow: 0 18px 50px rgba(0,0,0,0.45);
  position: relative;
}
.gate-card::before {
  content: ""; position: absolute; left: 14px; right: 14px; top: 0;
  height: 4px; background: repeating-linear-gradient(90deg, #d9a441 0 14px, transparent 14px 22px);
  border-radius: 0 0 3px 3px;
}
.gate-brand { line-height: 0.9; margin-bottom: 4px; }
.gate-brand-main { display: block; font-family: 'Barlow Condensed'; font-weight: 700; font-size: 38px; letter-spacing: 2px; }
.gate-brand-sub { display: block; font-family: 'Barlow Condensed'; font-weight: 600; font-size: 17px; letter-spacing: 9px; color: #b3402f; }
.gate-window-label {
  font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase;
  color: #5a5c52; margin: 14px 0 10px;
  display: flex; align-items: center; gap: 10px;
}
.gate-window-label::before, .gate-window-label::after { content: ""; height: 1px; background: rgba(29,31,27,0.2); flex: 1; }
.gate-tabs { display: flex; gap: 6px; margin-bottom: 16px; }
.gate-tabs button {
  flex: 1; padding: 8px 4px; border: 1px solid rgba(29,31,27,0.25); background: transparent;
  border-radius: 6px; font-family: inherit; font-weight: 600; font-size: 13px; color: #5a5c52; cursor: pointer;
}
.gate-tabs button.active { background: #1d1f1b; color: #f5f1e4; border-color: #1d1f1b; }
.gate-field { display: block; margin-bottom: 12px; }
.gate-field span { display: block; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: #5a5c52; margin-bottom: 4px; }
.gate-field input {
  width: 100%; padding: 10px 12px; border: 1px solid rgba(29,31,27,0.3); border-radius: 6px;
  background: #fffdf6; font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: #1d1f1b;
}
.gate-field input:focus-visible { outline: 2px solid #d9a441; outline-offset: 1px; }
.gate-err { color: #b3402f; font-size: 13px; margin: 2px 0 10px; }
.gate-go {
  width: 100%; padding: 12px; border: none; border-radius: 6px; cursor: pointer;
  background: #0f7b45; color: #f5f1e4; font-family: 'Barlow Condensed'; font-weight: 700;
  font-size: 18px; letter-spacing: 2px; text-transform: uppercase;
}
.gate-go:disabled { opacity: 0.5; cursor: default; }
.gate-go:focus-visible { outline: 2px solid #d9a441; outline-offset: 2px; }
.gate-note { font-size: 12px; color: #5a5c52; margin: 12px 0 4px; line-height: 1.5; }
.gate-skip {
  width: 100%; margin-top: 8px; padding: 8px; background: none; border: none; cursor: pointer;
  color: #5a5c52; font-size: 12px; text-decoration: underline; font-family: inherit;
}

.gate-bar {
  max-width: 860px; margin: 0 auto; padding: 8px 16px 0;
  display: flex; align-items: center; justify-content: flex-end; gap: 10px;
  font-family: 'Barlow', system-ui, sans-serif; font-size: 12px; color: rgba(245,241,228,0.75);
  background: transparent;
}
.gate-bar-mode { color: #d9a441; letter-spacing: 1.5px; text-transform: uppercase; font-size: 10px; font-weight: 600; }
.gate-bar-mode.dim { color: rgba(245,241,228,0.45); }
.gate-bar-id { font-family: 'IBM Plex Mono', monospace; }
.gate-bar-note { color: #2e9e64; }
.gate-bar button {
  background: none; border: 1px solid rgba(245,241,228,0.3); color: rgba(245,241,228,0.8);
  border-radius: 5px; padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit;
}
.gate-bar button:focus-visible { outline: 2px solid #d9a441; outline-offset: 2px; }
`;
