// src/AuthGate.jsx — staff-only login gate wrapping the sender/compose UI.
// Recipients opening a /get/<transferId> download link never load this React
// bundle at all (that page is rendered server-side), so this only affects
// people trying to CREATE a transfer — which is the part that should be
// staff-only. Real enforcement is server-side (server/index.js requireStaff);
// this is just the UI for it, and calling the gated APIs without a valid
// session will fail there regardless of what this component does.
import { useState, useEffect, useCallback } from "react";
import { PublicClientApplication } from "@azure/msal-browser";
import { msalConfig, loginRequest } from "./msalConfig";

const msalInstance = new PublicClientApplication(msalConfig);
let msalReady = msalInstance.initialize();

export default function AuthGate({ children }) {
  const [status, setStatus] = useState("checking"); // checking | signedOut | signedIn
  const [staffEmail, setStaffEmail] = useState("");
  const [error, setError] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  const checkSession = useCallback(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { authenticated: false }))
      .then((data) => {
        if (data.authenticated) {
          setStaffEmail(data.email);
          setStatus("signedIn");
        } else {
          setStatus("signedOut");
        }
      })
      .catch(() => setStatus("signedOut"));
  }, []);

  useEffect(() => { checkSession(); }, [checkSession]);

  const handleSignIn = async () => {
    setError("");
    setSigningIn(true);
    try {
      await msalReady;
      const result = await msalInstance.loginPopup(loginRequest);
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: result.idToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sign-in was not accepted");
      setStaffEmail(data.email);
      setStatus("signedIn");
    } catch (e) {
      setError(e.message || "Sign-in failed — please try again");
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setStatus("signedOut");
    setStaffEmail("");
  };

  if (status === "checking") {
    return (
      <div style={styles.wrap}>
        <div style={styles.spinner} />
      </div>
    );
  }

  if (status === "signedOut") {
    return (
      <div style={styles.wrap}>
        <div style={styles.card}>
          <div style={styles.brandRow}>
            <img src="/logo.png" alt="BCIM" style={styles.brandLogo} />
            <span style={styles.brandName}>BCIM Engineering</span>
          </div>
          <h1 style={styles.title}>SendDrive</h1>
          <p style={styles.subtitle}>This tool is for BCIM Engineering staff only.</p>
          <button style={styles.btn} onClick={handleSignIn} disabled={signingIn}>
            {signingIn ? (
              <span style={styles.btnSpinner} />
            ) : (
              <svg width="18" height="18" viewBox="0 0 21 21" style={{ flexShrink: 0 }}>
                <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
              </svg>
            )}
            {signingIn ? "Signing in…" : "Sign in with Microsoft"}
          </button>
          {error && <p style={styles.error}>{error}</p>}
          <div style={styles.divider} />
          <p style={styles.footnote}>
            Files sent to external recipients still work normally — this sign-in
            only applies to creating new transfers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <div style={styles.staffBadge}>
        <span>{staffEmail}</span>
        <button style={styles.signOutBtn} onClick={handleSignOut}>Sign out</button>
      </div>
      {children}
    </div>
  );
}

const styles = {
  wrap: {
    minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
    padding: 20,
    background: "radial-gradient(circle at 20% 15%, #0f3a32 0%, #06110e 45%, #030807 100%)",
    fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  },
  spinner: {
    width: 32, height: 32, border: "3px solid #d9f2ee", borderTopColor: "#00b69b",
    borderRadius: "50%", animation: "sd-spin 0.8s linear infinite",
  },
  card: {
    background: "#fff", borderRadius: 20, boxShadow: "0 24px 64px rgba(0,0,0,.35)",
    width: "100%", maxWidth: 400, padding: "36px 40px 32px", textAlign: "center",
    border: "1px solid rgba(255,255,255,0.06)",
  },
  brandRow: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    marginBottom: 28, paddingBottom: 20, borderBottom: "1px solid #f0f0f0",
  },
  brandLogo: { height: 32, width: "auto", flexShrink: 0 },
  brandName: { fontSize: 14, fontWeight: 700, color: "#3c3c3c", letterSpacing: "-0.01em" },
  title: { fontSize: 21, fontWeight: 700, color: "#161616", marginBottom: 8, letterSpacing: "-0.01em" },
  subtitle: { fontSize: 13.5, color: "#787878", marginBottom: 28, lineHeight: 1.6, maxWidth: 280, margin: "0 auto 28px" },
  btn: {
    width: "100%", padding: "12px 16px", background: "#fff", color: "#3c3c3c",
    border: "1px solid #d6d6d6", borderRadius: 10, fontSize: 14.5, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center",
    justifyContent: "center", gap: 10, transition: "background 0.15s, border-color 0.15s",
  },
  btnSpinner: {
    width: 15, height: 15, border: "2px solid #d6d6d6", borderTopColor: "#3c3c3c",
    borderRadius: "50%", display: "inline-block", animation: "sd-spin 0.7s linear infinite",
  },
  error: {
    marginTop: 14, fontSize: 12.5, color: "#b42318", background: "#fef3f2",
    border: "1px solid #fecdca", borderRadius: 8, padding: "8px 12px",
  },
  divider: { height: 1, background: "#eee", margin: "26px 0 14px" },
  footnote: { fontSize: 11, color: "#b0b0b0", lineHeight: 1.5 },
  staffBadge: {
    position: "fixed", top: 10, right: 12, zIndex: 999, display: "flex", alignItems: "center",
    gap: 10, background: "rgba(255,255,255,0.95)", border: "1px solid #e5e5e5", borderRadius: 20,
    padding: "5px 6px 5px 14px", fontSize: 12, color: "#555",
    boxShadow: "0 4px 14px rgba(0,0,0,.08)", backdropFilter: "blur(6px)",
  },
  signOutBtn: {
    background: "#f5f5f5", border: "1px solid #e0e0e0", borderRadius: 14, padding: "4px 10px",
    fontSize: 11, fontWeight: 600, color: "#777", cursor: "pointer",
  },
};

// Spinner keyframes — injected once since this file has no external CSS import.
const styleTag = document.createElement("style");
styleTag.textContent = "@keyframes sd-spin { to { transform: rotate(360deg); } }";
document.head.appendChild(styleTag);
