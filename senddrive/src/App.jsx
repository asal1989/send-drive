import { useState, useCallback, useRef, useEffect } from "react";
import { createTransfer, uploadFile } from "./oneDriveService";
import "./App.css";

const MAX_RECIPIENTS = 10;
const MAX_FILE_SIZE = 250 * 1024 * 1024 * 1024; // 250 GB

const BG_IMAGES = [
  "https://images.unsplash.com/photo-1504307651254-35680f356dfd?w=1920&q=80",
  "https://images.unsplash.com/photo-1541888946425-d81bb19240f5?w=1920&q=80",
  "https://images.unsplash.com/photo-1486325212027-8081e485255e?w=1920&q=80",
  "https://images.unsplash.com/photo-1590598015718-a1a04a3a0394?w=1920&q=80",
  "https://images.unsplash.com/photo-1523217582562-09d0def993a6?w=1920&q=80",
  "https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=1920&q=80",
];

const bgImage = BG_IMAGES[Math.floor(Math.random() * BG_IMAGES.length)];

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function getExt(name) {
  const p = name.lastIndexOf(".");
  return p > -1 ? name.slice(p + 1).toUpperCase().slice(0, 4) : "FILE";
}

function loadSavedEmails() {
  try { return JSON.parse(localStorage.getItem("sd_recent_emails") || "[]"); } catch { return []; }
}

function persistEmails(emails) {
  localStorage.setItem("sd_recent_emails", JSON.stringify(emails));
}

// ── Identity handed off from the ERP's floating launcher ────────────────────
// No login here (see "My Transfers" note below) — this just pre-fills the
// sender email when opened via ?from=<email> from inside the ERP, so people
// don't have to re-type who they are every time. Purely a convenience value:
// nothing prevents someone from typing over it or omitting it entirely.
function erpHandoffEmail() {
  try {
    const email = new URLSearchParams(window.location.search).get("from");
    return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
  } catch { return ""; }
}

// ── "My Transfers" — sender-side history + self-service recall ──────────────
// There's no login system, so history lives in this browser's localStorage
// (same trust model as the uploadToken itself: whoever holds it owns the
// transfer). A transfer sent from a different device/browser won't show up
// here — that's the accepted tradeoff for not building real accounts.
const MY_TRANSFERS_KEY = "sd_my_transfers";

function loadMyTransfers() {
  try { return JSON.parse(localStorage.getItem(MY_TRANSFERS_KEY) || "[]"); } catch { return []; }
}

function persistMyTransfers(list) {
  localStorage.setItem(MY_TRANSFERS_KEY, JSON.stringify(list.slice(0, 50)));
}

function addMyTransfer(entry) {
  const list = [entry, ...loadMyTransfers().filter((t) => t.transferId !== entry.transferId)];
  persistMyTransfers(list);
}

function removeMyTransfer(transferId) {
  persistMyTransfers(loadMyTransfers().filter((t) => t.transferId !== transferId));
}

function computeETA(progress, files, startTime) {
  if (!startTime || !files.length) return "";
  const elapsed = (Date.now() - startTime) / 1000;
  if (elapsed < 3) return "";
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  const doneBytes = files.reduce((s, f, i) => s + f.size * (progress[i] || 0) / 100, 0);
  if (doneBytes === 0) return "";
  const remaining = (totalBytes - doneBytes) / (doneBytes / elapsed);
  if (remaining < 10) return "";
  if (remaining < 60) return `~${Math.ceil(remaining)}s left`;
  return `~${Math.ceil(remaining / 60)}m left`;
}

function MyTransfersPanel({ onClose }) {
  const [transfers, setTransfers] = useState(loadMyTransfers);
  const [statuses, setStatuses] = useState({}); // transferId -> status | 'gone' | 'loading'
  const [cancelling, setCancelling] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  useEffect(() => {
    transfers.forEach(async (t) => {
      setStatuses((prev) => ({ ...prev, [t.transferId]: "loading" }));
      try {
        const res = await fetch(`/api/transfer/${t.transferId}/status?token=${encodeURIComponent(t.uploadToken)}`);
        if (!res.ok) { setStatuses((prev) => ({ ...prev, [t.transferId]: "gone" })); return; }
        const data = await res.json();
        setStatuses((prev) => ({ ...prev, [t.transferId]: data }));
      } catch {
        setStatuses((prev) => ({ ...prev, [t.transferId]: "gone" }));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once when the panel opens — cancel/remove update state locally, no re-fetch needed

  const cancelTransfer = async (t) => {
    if (!window.confirm(`Cancel "${t.title}"? Recipients won't be able to download it anymore.`)) return;
    setCancelling(t.transferId);
    try {
      await fetch(`/api/transfer/${t.transferId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadToken: t.uploadToken }),
      });
    } catch { /* best-effort — remove locally regardless */ }
    removeMyTransfer(t.transferId);
    setTransfers(loadMyTransfers());
    setCancelling(null);
  };

  const copyLink = (t) => {
    navigator.clipboard?.writeText(t.downloadPageUrl).then(() => {
      setCopiedId(t.transferId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  };

  return (
    <div className="wt-modal-overlay" onClick={onClose}>
      <div className="wt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wt-modal-head">
          <h3>My Transfers</h3>
          <button className="wt-modal-close" onClick={onClose}><XIcon /></button>
        </div>
        <div className="wt-modal-body">
          {transfers.length === 0 ? (
            <p className="wt-modal-empty">Transfers you send from this browser will show up here.</p>
          ) : (
            transfers.map((t) => {
              const status = statuses[t.transferId];
              const isGone = status === "gone" || (status && status.expired);
              return (
                <div key={t.transferId} className={`wt-mt-row${isGone ? " gone" : ""}`}>
                  <div className="wt-mt-info">
                    <div className="wt-mt-title">{t.title}</div>
                    <div className="wt-mt-meta">
                      {t.fileNames.length} file{t.fileNames.length !== 1 ? "s" : ""} · {formatSize(t.totalSize)}
                      {status && status !== "loading" && status !== "gone" && (
                        <> · {status.downloadCount} download{status.downloadCount !== 1 ? "s" : ""}</>
                      )}
                      {isGone && <> · expired or cancelled</>}
                    </div>
                  </div>
                  <div className="wt-mt-actions">
                    {!isGone && (
                      <button className="wt-mt-btn" onClick={() => copyLink(t)}>
                        {copiedId === t.transferId ? "Copied!" : "Copy link"}
                      </button>
                    )}
                    <button
                      className="wt-mt-btn wt-mt-btn-danger"
                      onClick={() => (isGone ? (removeMyTransfer(t.transferId), setTransfers(loadMyTransfers())) : cancelTransfer(t))}
                      disabled={cancelling === t.transferId}
                    >
                      {isGone ? "Remove" : cancelling === t.transferId ? "Cancelling…" : "Cancel"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [files, setFiles] = useState([]);
  const [progress, setProgress] = useState({});
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Email fields
  const [recipients, setRecipients] = useState([]);
  const [recipientInput, setRecipientInput] = useState("");
  const [senderEmail, setSenderEmail] = useState(erpHandoffEmail);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");

  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const [expiryDays, setExpiryDays] = useState(7);
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [password, setPassword] = useState("");

  // Result
  const [shareLink, setShareLink] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Dark mode
  const [dark, setDark] = useState(() => localStorage.getItem("sd_dark") === "1");

  // My Transfers panel
  const [showMyTransfers, setShowMyTransfers] = useState(false);

  // Email delivery status
  const [emailSent, setEmailSent] = useState(null); // null | true | false

  // Saved recipients (localStorage)
  const [savedEmails, setSavedEmails] = useState(loadSavedEmails);
  const [showSuggestions, setShowSuggestions] = useState(false);

  const recipientInputRef = useRef(null);
  const uploadStartRef = useRef(null);

  const addFiles = (newFiles) => {
    let arr = Array.from(newFiles);
    const oversized = arr.filter((f) => f.size > MAX_FILE_SIZE);
    if (oversized.length > 0) {
      setError(`Too large (max 250 GB): ${oversized.map((f) => f.name).join(", ")}`);
      arr = arr.filter((f) => f.size <= MAX_FILE_SIZE);
    }
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...arr.filter((f) => !existing.has(f.name + f.size))];
    });
  };

  const removeFile = (idx) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    setProgress((prev) => { const n = { ...prev }; delete n[idx]; return n; });
  };

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer.files);
  }, []);

  const addRecipient = (value) => {
    const email = value.trim().toLowerCase();
    if (!email) return;
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!valid) return;
    if (recipients.includes(email)) { setRecipientInput(""); return; }
    if (recipients.length >= MAX_RECIPIENTS) return;
    setRecipients((prev) => [...prev, email]);
    setRecipientInput("");
    setShowSuggestions(false);
  };

  const removeRecipient = (email) => {
    setRecipients((prev) => prev.filter((r) => r !== email));
  };

  const handleRecipientKeyDown = (e) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      addRecipient(recipientInput);
    } else if (e.key === "Backspace" && recipientInput === "" && recipients.length > 0) {
      setRecipients((prev) => prev.slice(0, -1));
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  };

  const handleSend = async () => {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    setError("");
    setEmailSent(null);
    uploadStartRef.current = Date.now();
    try {
      const { transferId, uploadToken, downloadPageUrl } = await createTransfer();

      for (let i = 0; i < files.length; i++) {
        await uploadFile(files[i], transferId, uploadToken, (pct) =>
          setProgress((prev) => ({ ...prev, [i]: pct }))
        );
      }

      const link = downloadPageUrl;
      setShareLink(link);

      addMyTransfer({
        transferId,
        uploadToken,
        title: title || "Files shared with you",
        fileNames: files.map((f) => f.name),
        totalSize: files.reduce((s, f) => s + f.size, 0),
        downloadPageUrl: link,
        createdAt: new Date().toISOString(),
      });

      // Register transfer metadata for admin + notifications + password
      await fetch("/api/register-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transferId,
          uploadToken,
          senderEmail,
          title: title || "Files shared with you",
          fileNames: files.map((f) => f.name),
          fileSizes: files.map((f) => f.size),
          expiryDays: parseInt(expiryDays),
          password: passwordEnabled && password ? password : null,
        }),
      }).catch(() => {});

      if (recipients.length > 0) {
        try {
          const emailRes = await fetch("/api/send-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipients,
              transferId,
              uploadToken,
              senderEmail,
              title: title || "Files shared with you",
              message,
              shareLink: link,
              fileNames: files.map((f) => f.name),
              expiryDays: parseInt(expiryDays),
            }),
          });
          setEmailSent(emailRes.ok);
          if (emailRes.ok) {
            const merged = [...new Set([...recipients, ...savedEmails])].slice(0, 5);
            setSavedEmails(merged);
            persistEmails(merged);
          }
        } catch {
          setEmailSent(false);
        }
      }

      setDone(true);
    } catch (e) {
      setError("Upload failed: " + e.message);
    } finally {
      setUploading(false);
    }
  };

  const copyLink = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareLink);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = shareLink;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copy failed. Select the link above and copy it manually.");
    }
  };

  const reset = () => {
    setFiles([]); setProgress({}); setShareLink("");
    setDone(false); setError(""); setCopied(false);
    setRecipients([]); setRecipientInput(""); setSenderEmail("");
    setTitle(""); setMessage(""); setPassword("");
    setPasswordEnabled(false); setShowAdvanced(false);
    setShowOptionsMenu(false);
    setEmailSent(null);
    uploadStartRef.current = null;
  };

  const totalProgress =
    files.length > 0
      ? Math.round(Object.values(progress).reduce((a, b) => a + b, 0) / files.length)
      : 0;

  const eta = uploading && uploadStartRef.current
    ? computeETA(progress, files, uploadStartRef.current)
    : "";

  const canSend = files.length > 0 && !uploading;

  const suggestions = savedEmails.filter(
    (e) => recipientInput.length > 0 && e.includes(recipientInput.toLowerCase()) && !recipients.includes(e)
  );

  const toggleDark = () => setDark(d => {
    localStorage.setItem("sd_dark", d ? "0" : "1");
    return !d;
  });

  return (
    <div className={`wt-app${dark ? " dark" : ""}`} style={{ backgroundImage: `url(${bgImage})` }}>
      <div className="wt-overlay" />
      <nav className="wt-nav">
        <div className="wt-logo">
          <img src="/logo.png" alt="BCIM Logo" className="wt-logo-img" />
          <div className="wt-logo-text">
            <span className="wt-logo-name">BCIM ENGINEERING</span>
            <span className="wt-logo-sub">PRIVATE LIMITED</span>
          </div>
        </div>
        <button className="wt-my-transfers-btn" onClick={() => setShowMyTransfers(true)} title="My Transfers">
          <HistoryIcon /> My Transfers
        </button>
        <button className="wt-dark-toggle" onClick={toggleDark} title="Toggle dark mode">
          {dark ? <SunIcon /> : <MoonIcon />}
        </button>
      </nav>

      {showMyTransfers && <MyTransfersPanel onClose={() => setShowMyTransfers(false)} />}

      <main className="wt-main">
        {done ? (
          <>
            <div className="wt-card">
              <div className="wt-success-body">
                <div className="wt-success-icon"><CheckCircleIcon /></div>
                <h2 className="wt-success-title">Your transfer is ready!</h2>
                <p className="wt-success-sub">
                  {files.length} file{files.length > 1 ? "s" : ""} uploaded · expires in {expiryDays} day{expiryDays > 1 ? "s" : ""}
                </p>

                {emailSent === true && (
                  <p className="wt-email-status wt-email-ok">
                    ✓ Email sent to {recipients.join(", ")}
                  </p>
                )}
                {emailSent === false && (
                  <p className="wt-email-status wt-email-fail">
                    ⚠ Email failed — share the link manually
                  </p>
                )}

                <div className="wt-links">
                  <a href={shareLink} target="_blank" rel="noreferrer" className="wt-link-row">
                    <span className="wt-link-label">
                      {files.length} file{files.length > 1 ? "s" : ""} · click to open
                    </span>
                    <span className="wt-link-url">{shareLink}</span>
                  </a>
                </div>

                <div className="wt-qr">
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(shareLink)}`}
                    alt="QR code"
                    width={120}
                    height={120}
                  />
                  <p className="wt-qr-label">Scan to open on mobile</p>
                </div>
              </div>
              <button className="wt-transfer-btn" onClick={copyLink}>
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
            <button className="wt-new-transfer" onClick={reset}>Send another transfer</button>
          </>
        ) : (
          <>
            <div className="wt-card wt-transfer-card">
              {uploading && <UploadTransferAnimation percent={totalProgress} />}
              <div className="wt-card-tab">Request files</div>
              <div
                className={`wt-files-section ${dragOver ? "drag" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
              >
                <div className="wt-upload-tiles">
                  <button className="wt-upload-tile" type="button" onClick={() => document.getElementById("wt-file-input").click()}>
                    <span className="wt-tile-icon"><PlusIcon /></span>
                    <span>Add files</span>
                  </button>
                  <button className="wt-upload-tile" type="button" onClick={() => document.getElementById("wt-folder-input").click()}>
                    <span className="wt-tile-icon"><FolderAddIcon /></span>
                    <span>Add folders</span>
                  </button>
                </div>
                {files.length > 0 && (
                  <div className="wt-file-list">
                    {files.map((file, i) => (
                      <div key={i} className="wt-file-row">
                        <div className="wt-file-icon">{getExt(file.name)}</div>
                        <div className="wt-file-info">
                          <span className="wt-file-name">{file.webkitRelativePath || file.name}</span>
                          <span className="wt-file-size">{formatSize(file.size)}</span>
                          {progress[i] !== undefined && (
                            <div className="wt-progress">
                              <div className="wt-progress-fill" style={{ width: `${progress[i]}%` }} />
                            </div>
                          )}
                        </div>
                        {!uploading && (
                          <button className="wt-file-remove" type="button" onClick={() => removeFile(i)}><XIcon /></button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <input id="wt-file-input" type="file" multiple style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
                <input id="wt-folder-input" type="file" multiple webkitdirectory="" directory="" style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
              </div>

              {/* Fields */}
              <div className="wt-fields">

                {/* Email to — with tag input, suggestions, and counter */}
                <div
                  className="wt-field-row wt-field-row--tags"
                  onClick={() => recipientInputRef.current?.focus()}
                >
                  <EmailIcon />
                  <div className="wt-tags-wrap" style={{ position: "relative" }}>
                    {recipients.map((r) => (
                      <span key={r} className="wt-tag">
                        {r}
                        <button className="wt-tag-remove" onClick={(e) => { e.stopPropagation(); removeRecipient(r); }}>×</button>
                      </span>
                    ))}
                    {recipients.length < MAX_RECIPIENTS && (
                      <input
                        ref={recipientInputRef}
                        className="wt-field-input wt-tag-input"
                        type="email"
                        placeholder={recipients.length === 0 ? "Email to" : ""}
                        value={recipientInput}
                        onChange={(e) => { setRecipientInput(e.target.value); setShowSuggestions(true); }}
                        onKeyDown={handleRecipientKeyDown}
                        onBlur={() => { setTimeout(() => { addRecipient(recipientInput); setShowSuggestions(false); }, 150); }}
                        onFocus={() => setShowSuggestions(true)}
                        autoComplete="off"
                      />
                    )}
                    {showSuggestions && suggestions.length > 0 && (
                      <div className="wt-suggestions">
                        {suggestions.map((email) => (
                          <div
                            key={email}
                            className="wt-suggestion-item"
                            onMouseDown={(e) => { e.preventDefault(); addRecipient(email); }}
                          >
                            {email}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="wt-counter">{recipients.length} of {MAX_RECIPIENTS}</span>
                </div>

                <div className="wt-field-divider" />

                {/* Your email */}
                <div className="wt-field-row">
                  <PersonIcon />
                  <input
                    className="wt-field-input"
                    type="email"
                    placeholder="Your email"
                    value={senderEmail}
                    onChange={(e) => setSenderEmail(e.target.value)}
                  />
                </div>

                <div className="wt-field-divider" />

                {/* Title */}
                <div className="wt-field-row">
                  <TitleIcon />
                  <input
                    className="wt-field-input"
                    type="text"
                    placeholder="Title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>

                <div className="wt-field-divider" />

                {/* Message */}
                <div className="wt-field-row wt-field-row--message">
                  <MessageIcon />
                  <textarea
                    className="wt-field-input wt-field-textarea"
                    placeholder="Message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={1}
                    onInput={(e) => {
                      e.target.style.height = "auto";
                      e.target.style.height = e.target.scrollHeight + "px";
                    }}
                  />
                </div>

                {/* More options */}
                <div className="wt-toggles">
                  <button className="wt-optional-toggle" onClick={() => setShowAdvanced((v) => !v)}>
                    {showAdvanced ? "− Hide options" : "+ More options"}
                  </button>
                </div>

                {showAdvanced && (
                  <div className="wt-advanced">
                    <div className="wt-adv-row">
                      <label>Expires after</label>
                      <select value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)}>
                        <option value={1}>1 day</option>
                        <option value={3}>3 days</option>
                        <option value={7}>7 days</option>
                        <option value={14}>14 days</option>
                        <option value={30}>30 days</option>
                      </select>
                    </div>
                    <div className="wt-adv-row">
                      <label>Password protect</label>
                      <button className={`wt-toggle ${passwordEnabled ? "on" : ""}`} onClick={() => setPasswordEnabled((v) => !v)} />
                    </div>
                    {passwordEnabled && (
                      <input className="wt-adv-input" type="password" placeholder="Set a password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    )}
                  </div>
                )}
              </div>

              {error && <div className="wt-error">{error}</div>}

              <div className="wt-bottom-bar">
                <select className="wt-expiry-pill" value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)}>
                  <option value={1}>1 day</option>
                  <option value={3}>3 days</option>
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                </select>
                <button className={`wt-more-button ${passwordEnabled ? "active" : ""}`} type="button" onClick={() => setShowOptionsMenu((v) => !v)}>
                  <MoreIcon />
                </button>
                {showOptionsMenu && (
                  <div className="wt-options-menu">
                    <button type="button" className="wt-options-row" onClick={() => setPasswordEnabled((v) => !v)}>
                      <span>Password protect</span>
                      <span className={`wt-mini-switch ${passwordEnabled ? "on" : ""}`} />
                    </button>
                    {passwordEnabled && (
                      <input
                        className="wt-options-input"
                        type="password"
                        placeholder="Set a password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="wt-action-wrap">
                <button className={`wt-transfer-btn ${uploading ? "uploading" : ""}`} onClick={handleSend} disabled={!canSend}>
                {uploading
                  ? `Uploading ${totalProgress}%${eta ? ` · ${eta}` : ""}`
                  : "Transfer"}
                </button>
              </div>
            </div>

            <p className="wt-footer-note">
              Files stored for {expiryDays} day{expiryDays > 1 ? "s" : ""} · Up to 250 GB per file · Stored securely in the cloud
            </p>
          </>
        )}
      </main>
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function FolderAddIcon() {
  return (
    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 012-2h5l2 2h7a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <circle cx="17" cy="16" r="4" fill="currentColor" stroke="none" opacity=".18" />
      <path d="M17 14v4M15 16h4" />
    </svg>
  );
}
function MoreIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
    </svg>
  );
}
function CheckSmallIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M8 12.5l2.5 2.5L16 9" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function EmailIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}
function PersonIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
    </svg>
  );
}
function TitleIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}
function MessageIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}
function HistoryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
      <path d="M3 3v5h5" /><path d="M12 7v5l4 2" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
      <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
    </svg>
  );
}
function CheckCircleIcon() {
  return (
    <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function FileFlyIcon() {
  return (
    <svg width="20" height="24" viewBox="0 0 24 28" fill="none">
      <path d="M4 2h11l5 5v19a2 2 0 01-2 2H4a2 2 0 01-2-2V4a2 2 0 012-2z" fill="#f3f3f3" stroke="#d8d8d8" strokeWidth="1" />
      <path d="M15 2v5h5" fill="none" stroke="#d8d8d8" strokeWidth="1" />
      <rect x="5" y="12" width="10" height="1.6" rx="0.8" fill="#e8a33d" />
      <rect x="5" y="16" width="14" height="1.6" rx="0.8" fill="#cfcfcf" />
      <rect x="5" y="20" width="8" height="1.6" rx="0.8" fill="#cfcfcf" />
    </svg>
  );
}

function UploadTransferAnimation({ percent }) {
  return (
    <div className="wt-upload-anim">
      <span className="wt-upload-anim-percent">{percent}%</span>
      <div className="wt-upload-anim-row">
        <svg className="wt-upload-anim-laptop" width="48" height="48" viewBox="0 0 64 64" fill="none">
          <rect x="10" y="12" width="44" height="30" rx="3" fill="#1b2740" stroke="#e8a33d" strokeWidth="2" />
          <rect x="15" y="17" width="34" height="20" rx="1.5" fill="#0f1826" />
          <rect x="18" y="20" width="20" height="3" rx="1.5" fill="#e8a33d" opacity="0.85" />
          <rect x="18" y="26" width="26" height="2.5" rx="1.25" fill="#6b7a99" />
          <rect x="18" y="31" width="14" height="2.5" rx="1.25" fill="#6b7a99" />
          <path d="M4 46l6-6h44l6 6z" fill="#233254" stroke="#e8a33d" strokeWidth="1.5" />
        </svg>

        <div className="wt-upload-anim-track">
          <span className="wt-upload-anim-file f1"><FileFlyIcon /></span>
          <span className="wt-upload-anim-file f2"><FileFlyIcon /></span>
          <span className="wt-upload-anim-file f3"><FileFlyIcon /></span>
        </div>

        <svg className="wt-upload-anim-cloud" width="52" height="52" viewBox="0 0 64 64" fill="none">
          <path d="M46.5 44H19a10 10 0 01-1.4-19.9 13.5 13.5 0 0126.6-3A9.5 9.5 0 0146.5 44z" fill="#1b2740" stroke="#e8a33d" strokeWidth="2" />
          <path d="M32 30v14M26 38l6 6 6-6" stroke="#e8a33d" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <p className="wt-upload-anim-caption">Sending your files securely…</p>
    </div>
  );
}
