import { useState, useCallback, useRef } from "react";
import { createTransfer, uploadFile } from "./oneDriveService";
import "./App.css";

const MAX_RECIPIENTS = 3;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

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

export default function App() {
  const [files, setFiles] = useState([]);
  const [progress, setProgress] = useState({});
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Email fields
  const [recipients, setRecipients] = useState([]);
  const [recipientInput, setRecipientInput] = useState("");
  const [senderEmail, setSenderEmail] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");

  // Advanced options
  const [showAdvanced, setShowAdvanced] = useState(false);
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
      setError(`Too large (max 2 GB): ${oversized.map((f) => f.name).join(", ")}`);
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
      const { transferId, folderId, downloadPageUrl } = await createTransfer();

      for (let i = 0; i < files.length; i++) {
        await uploadFile(files[i], transferId, (pct) =>
          setProgress((prev) => ({ ...prev, [i]: pct }))
        );
      }

      const link = downloadPageUrl;
      setShareLink(link);

      // Register transfer metadata for admin + notifications + password
      await fetch("/api/register-transfer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transferId,
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

  const copyLink = () => {
    navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    setFiles([]); setProgress({}); setShareLink("");
    setDone(false); setError(""); setCopied(false);
    setRecipients([]); setRecipientInput(""); setSenderEmail("");
    setTitle(""); setMessage(""); setPassword("");
    setPasswordEnabled(false); setShowAdvanced(false);
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
        <button className="wt-dark-toggle" onClick={toggleDark} title="Toggle dark mode">
          {dark ? <SunIcon /> : <MoonIcon />}
        </button>
      </nav>

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
            <div className="wt-card">
              {/* Files section */}
              <div
                className={`wt-files-section ${dragOver ? "drag" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
              >
                {files.length === 0 ? (
                  <div className="wt-dropzone" onClick={() => document.getElementById("wt-file-input").click()}>
                    <div className="wt-add-circle"><PlusIcon /></div>
                    <p className="wt-drop-title">Add your files</p>
                    <p className="wt-drop-sub">or drop them here</p>
                  </div>
                ) : (
                  <div className="wt-file-list">
                    {files.map((file, i) => (
                      <div key={i} className="wt-file-row">
                        <div className="wt-file-icon">{getExt(file.name)}</div>
                        <div className="wt-file-info">
                          <span className="wt-file-name">{file.name}</span>
                          <span className="wt-file-size">{formatSize(file.size)}</span>
                          {progress[i] !== undefined && (
                            <div className="wt-progress">
                              <div className="wt-progress-fill" style={{ width: `${progress[i]}%` }} />
                            </div>
                          )}
                        </div>
                        {!uploading && (
                          <button className="wt-file-remove" onClick={() => removeFile(i)}><XIcon /></button>
                        )}
                      </div>
                    ))}
                    {!uploading && (
                      <button className="wt-add-more" onClick={() => document.getElementById("wt-file-input").click()}>
                        <span className="wt-add-more-plus">+</span> Add more files
                      </button>
                    )}
                  </div>
                )}
                <input id="wt-file-input" type="file" multiple style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
              </div>

              <div className="wt-divider" />

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

              <button className={`wt-transfer-btn ${uploading ? "uploading" : ""}`} onClick={handleSend} disabled={!canSend}>
                {uploading
                  ? `Uploading ${totalProgress}%${eta ? ` · ${eta}` : ""}`
                  : "Transfer"}
              </button>
            </div>

            <p className="wt-footer-note">
              Files stored for {expiryDays} day{expiryDays > 1 ? "s" : ""} · Up to 2 GB per file · Stored securely in the cloud
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
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
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
