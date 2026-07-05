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
        <div style={styles.dotGrid} />
        <div style={styles.scene}>
          <div style={styles.card}>
            <div style={styles.leftPanel}>
              <div style={styles.skylineBlock1} />
              <div style={styles.skylineBlock2} />
              <div style={styles.skylineBlock3} />
              <div style={styles.diagonalAccent} />
              <div style={styles.leftContent}>
                <img src="/bcim-icon.png" alt="BCIM" style={styles.brandIcon} />
                <div style={styles.brandWordmark}>
                  <span style={{ color: "#de2e16" }}>B</span>CIM
                </div>
                <div style={styles.brandTagline}>Building Better Together</div>
              </div>
            </div>
            <div style={styles.rightPanel}>
              <p style={styles.companyName}>BCIM ENGINEERING PRIVATE LIMITED</p>
              <p style={styles.internalTool}>INTERNAL TOOL</p>
              <div style={styles.titleUnderline} />
              <h1 style={styles.title}>SendDrive</h1>
              <div style={styles.iconBadge}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00a651" strokeWidth="2">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </div>
              <p style={styles.subtitle}>This tool is for BCIM Engineering staff only.</p>
              <button style={styles.btn} onClick={handleSignIn} disabled={signingIn}>
                <span style={styles.btnLeft}>
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
                </span>
                <span style={styles.btnChevron}>›</span>
              </button>
              {error && <p style={styles.error}>{error}</p>}
              <p style={styles.footnote}>
                <span style={styles.lockIcon}>🔒</span> BCIM ENGINEERING PRIVATE LIMITED&nbsp;|&nbsp;Staff access only
              </p>
              <p style={styles.footnoteSmall}>
                Files sent to external recipients still work normally — this sign-in
                only applies to creating new transfers.
              </p>
            </div>
          </div>
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
    padding: 20, position: "relative", overflow: "hidden",
    background: "linear-gradient(135deg, #eef3f9 0%, #f7f9fc 55%, #eef3f9 100%)",
    fontFamily: "'Segoe UI', 'Helvetica Neue', Arial, sans-serif",
  },
  dotGrid: {
    position: "absolute", top: 0, right: 0, width: "45%", height: "55%",
    backgroundImage: "radial-gradient(rgba(0,166,81,0.18) 1.5px, transparent 1.5px)",
    backgroundSize: "14px 14px", pointerEvents: "none",
  },
  scene: { perspective: 1200, position: "relative", zIndex: 1 },
  spinner: {
    width: 32, height: 32, border: "3px solid #d9f2ee", borderTopColor: "#00a651",
    borderRadius: "50%", animation: "sd-spin 0.8s linear infinite",
  },
  card: {
    background: "#fff", borderRadius: 20, boxShadow: "0 24px 64px rgba(20,40,80,.16)",
    width: "100%", maxWidth: 640, display: "flex", overflow: "hidden",
    border: "1px solid rgba(20,40,80,0.05)", position: "relative",
    transformStyle: "preserve-3d", animation: "sd-card-enter 0.7s cubic-bezier(0.16, 1, 0.3, 1) both",
  },
  leftPanel: {
    width: 220, flexShrink: 0, position: "relative", overflow: "hidden",
    background: "#0f2a52",
    clipPath: "polygon(0 0, 100% 0, 78% 100%, 0% 100%)",
  },
  skylineBlock1: { position: "absolute", bottom: 0, left: 8, width: 28, height: 70, background: "rgba(255,255,255,0.05)" },
  skylineBlock2: { position: "absolute", bottom: 0, left: 44, width: 20, height: 110, background: "rgba(255,255,255,0.04)" },
  skylineBlock3: { position: "absolute", bottom: 0, left: 70, width: 34, height: 50, background: "rgba(255,255,255,0.045)" },
  diagonalAccent: {
    position: "absolute", bottom: 26, left: -10, width: "150%", height: 3,
    background: "#00a651", transform: "rotate(-32deg)", transformOrigin: "left center",
  },
  leftContent: {
    position: "relative", zIndex: 1, height: "100%", display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", padding: "32px 20px", textAlign: "center",
  },
  brandIcon: { width: 48, height: "auto", flexShrink: 0, animation: "sd-logo-float 4s ease-in-out infinite" },
  brandWordmark: { marginTop: 14, fontSize: 20, fontWeight: 900, letterSpacing: "0.03em", color: "#fff", fontFamily: "'Arial Black', Arial, sans-serif" },
  brandTagline: { marginTop: 8, fontSize: 10.5, letterSpacing: "0.12em", color: "rgba(255,255,255,0.65)", textTransform: "uppercase" },
  rightPanel: {
    flex: 1, padding: "38px 40px 30px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center",
  },
  companyName: { fontSize: 13, fontWeight: 800, color: "#0f2a52", letterSpacing: "0.02em", margin: 0 },
  internalTool: { fontSize: 10, fontWeight: 600, color: "#9aa5b1", letterSpacing: "0.18em", margin: "4px 0 0" },
  titleUnderline: { width: 32, height: 2.5, background: "#00a651", borderRadius: 2, margin: "12px 0 18px" },
  title: { fontSize: 22, fontWeight: 700, color: "#0f2a52", marginBottom: 16, letterSpacing: "-0.01em" },
  iconBadge: {
    width: 46, height: 46, borderRadius: 12, background: "#eefaf2", border: "1px solid #d8f0e0",
    display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16,
  },
  subtitle: { fontSize: 13, color: "#787878", marginBottom: 24, lineHeight: 1.6, maxWidth: 260 },
  btn: {
    width: "100%", padding: "12px 18px", background: "#fff", color: "#3c3c3c",
    border: "1px solid #d6d6d6", borderRadius: 10, fontSize: 14, fontWeight: 600,
    cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center",
    justifyContent: "space-between", gap: 10, transition: "background 0.15s, border-color 0.15s",
  },
  btnLeft: { display: "flex", alignItems: "center", gap: 10 },
  btnChevron: { fontSize: 18, color: "#b0b0b0" },
  btnSpinner: {
    width: 15, height: 15, border: "2px solid #d6d6d6", borderTopColor: "#3c3c3c",
    borderRadius: "50%", display: "inline-block", animation: "sd-spin 0.7s linear infinite",
  },
  error: {
    marginTop: 14, fontSize: 12.5, color: "#b42318", background: "#fef3f2",
    border: "1px solid #fecdca", borderRadius: 8, padding: "8px 12px", width: "100%",
  },
  footnote: { fontSize: 11, color: "#9aa5b1", lineHeight: 1.5, marginTop: 20, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 },
  footnoteSmall: { fontSize: 10.5, color: "#b0b0b0", lineHeight: 1.5, marginTop: 10 },
  lockIcon: { fontSize: 10 },
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

// Animation keyframes — injected once since this file has no external CSS import.
const styleTag = document.createElement("style");
styleTag.textContent = `
  @keyframes sd-spin { to { transform: rotate(360deg); } }
  @keyframes sd-card-enter {
    from { opacity: 0; transform: translateY(24px) rotateX(-10deg) scale(0.96); }
    to   { opacity: 1; transform: translateY(0) rotateX(0deg) scale(1); }
  }
  @keyframes sd-logo-float {
    0%, 100% { transform: perspective(300px) translateY(0) rotateY(0deg); }
    50%      { transform: perspective(300px) translateY(-3px) rotateY(10deg); }
  }
`;
document.head.appendChild(styleTag);
