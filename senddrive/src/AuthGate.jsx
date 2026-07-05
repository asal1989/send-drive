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
          <div style={styles.logoCircle}>SD</div>
          <h1 style={styles.title}>SendDrive</h1>
          <p style={styles.subtitle}>This tool is for BCIM Engineering staff only.</p>
          <button style={styles.btn} onClick={handleSignIn} disabled={signingIn}>
            {signingIn ? "Signing in…" : "Sign in with Microsoft"}
          </button>
          {error && <p style={styles.error}>{error}</p>}
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
    background: "#f0f2f5", fontFamily: "'Helvetica Neue', Arial, sans-serif",
  },
  spinner: {
    width: 32, height: 32, border: "3px solid #d9f2ee", borderTopColor: "#00b69b",
    borderRadius: "50%", animation: "sd-spin 0.8s linear infinite",
  },
  card: {
    background: "#fff", borderRadius: 14, boxShadow: "0 4px 32px rgba(0,0,0,.10)",
    width: "100%", maxWidth: 380, padding: "40px 36px", textAlign: "center",
  },
  logoCircle: {
    width: 56, height: 56, borderRadius: 14, background: "#00b69b", color: "#fff",
    display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800,
    fontSize: 18, margin: "0 auto 18px",
  },
  title: { fontSize: 20, fontWeight: 800, color: "#111", marginBottom: 6 },
  subtitle: { fontSize: 13, color: "#888", marginBottom: 24, lineHeight: 1.5 },
  btn: {
    width: "100%", padding: "13px", background: "#00b69b", color: "#fff", border: "none",
    borderRadius: 8, fontSize: 15, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  },
  error: { marginTop: 12, fontSize: 13, color: "#c00" },
  footnote: { marginTop: 20, fontSize: 11, color: "#bbb", lineHeight: 1.5 },
  staffBadge: {
    position: "fixed", top: 10, right: 12, zIndex: 999, display: "flex", alignItems: "center",
    gap: 10, background: "rgba(255,255,255,0.92)", border: "1px solid #e5e5e5", borderRadius: 20,
    padding: "5px 6px 5px 14px", fontSize: 12, color: "#555", boxShadow: "0 2px 10px rgba(0,0,0,.06)",
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
