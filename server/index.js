require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { getValidToken } = require('./auth');

const app = express();
const GRAPH = 'https://graph.microsoft.com/v1.0';
const FOLDER = process.env.UPLOAD_FOLDER || 'SendDrive';
const UPN = process.env.ONEDRIVE_USER_UPN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',').map(s => s.trim());

app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ── Rate limiters ────────────────────────────────────────────────────────────
const limiter      = rateLimit({ windowMs: 15 * 60 * 1000, max: 60,  standardHeaders: true, legacyHeaders: false });
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,  standardHeaders: true, legacyHeaders: false });

// ── Transfer store (flat JSON file) ─────────────────────────────────────────
const STORE_PATH = path.join(__dirname, 'transfers.json');
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch { return {}; }
}
function saveStore(data) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}
function getRecord(id)        { return loadStore()[id]; }
function setRecord(id, data)  { const s = loadStore(); s[id] = data; saveStore(s); }
function deleteRecord(id)     { const s = loadStore(); delete s[id]; saveStore(s); }

// ── Helpers ──────────────────────────────────────────────────────────────────
function sanitizeFileName(name) { return name.replace(/[/\\<>:*?|"]/g, '_').slice(0, 200); }
function sanitizeText(str)      { return (str || '').replace(/<[^>]*>/g, '').trim(); }
function escapeHtml(str)        { return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function hashPwd(pwd)           { return crypto.createHash('sha256').update(pwd).digest('hex'); }

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

// ── GET /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await getValidToken();
    res.json({ status: 'ok', onedrive: true, uptime: Math.floor(process.uptime()) });
  } catch { res.status(500).json({ status: 'error', onedrive: false }); }
});

// ── POST /api/create-transfer ────────────────────────────────────────────────
app.post('/api/create-transfer', limiter, async (req, res) => {
  const transferId = `transfer-${crypto.randomBytes(5).toString('hex')}`;
  try {
    const token = await getValidToken();
    await axios.post(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}:/children`,
      { name: transferId, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
    res.json({ transferId, downloadPageUrl: `${base}/get/${transferId}` });
  } catch (err) {
    console.error('[create-transfer]', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create transfer folder' });
  }
});

// ── POST /api/upload-session ─────────────────────────────────────────────────
app.post('/api/upload-session', limiter, async (req, res) => {
  const { fileName, fileSize, transferId } = req.body;
  if (!fileName || !fileSize || !transferId)
    return res.status(400).json({ error: 'fileName, fileSize and transferId are required' });
  const safeName = sanitizeFileName(fileName);
  try {
    const token = await getValidToken();
    const r = await axios.post(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}/${transferId}/${safeName}:/createUploadSession`,
      { item: { '@microsoft.graph.conflictBehavior': 'rename', name: safeName } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ uploadUrl: r.data.uploadUrl });
  } catch (err) {
    console.error('[upload-session]', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create upload session' });
  }
});

// ── POST /api/register-transfer ──────────────────────────────────────────────
app.post('/api/register-transfer', limiter, (req, res) => {
  const { transferId, senderEmail, title, fileNames, fileSizes, expiryDays, password } = req.body;
  if (!transferId || !/^transfer-[0-9a-f]{10}$/.test(transferId))
    return res.status(400).json({ error: 'Invalid transferId' });

  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + (parseInt(expiryDays) || 7));

  setRecord(transferId, {
    createdAt:    new Date().toISOString(),
    expiresAt:    expiryDate.toISOString(),
    senderEmail:  sanitizeText(senderEmail),
    title:        sanitizeText(title),
    fileNames:    (fileNames || []).map(n => sanitizeText(n)),
    fileSizes:    fileSizes || [],
    totalSize:    (fileSizes || []).reduce((a, b) => a + b, 0),
    downloadCount: 0,
    notified:     false,
    passwordHash: password ? hashPwd(password) : null,
  });
  res.json({ ok: true });
});

// ── GET /get/:transferId — download page ─────────────────────────────────────
app.get('/get/:transferId', limiter, async (req, res) => {
  const { transferId } = req.params;
  const { pwd } = req.query;

  if (!/^transfer-[0-9a-f]{10}$/.test(transferId))
    return res.status(404).send('Not found');

  const record = getRecord(transferId);

  // Password gate
  if (record?.passwordHash) {
    const ok = pwd && hashPwd(pwd) === record.passwordHash;
    if (!ok) {
      return res.send(pwdPageHtml(transferId, !!pwd && !ok));
    }
  }

  try {
    const token = await getValidToken();
    const r = await axios.get(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}/${transferId}:/children`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const files = (r.data.value || []).filter(f => !f.folder);
    const pwdParam = pwd ? `?pwd=${encodeURIComponent(pwd)}` : '';

    const fileRows = files.length
      ? files.map(f => `
        <div class="file-row">
          <div class="file-info">
            <div class="file-name">${escapeHtml(f.name)}</div>
            <div class="file-size">${formatBytes(f.size)}</div>
          </div>
          <a class="dl-btn" href="/api/dl/${escapeHtml(transferId)}/${escapeHtml(f.id)}${pwdParam}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </a>
        </div>`).join('')
      : '<p class="empty">No files found or this transfer has expired.</p>';

    res.send(downloadPageHtml(files.length, fileRows));
  } catch (err) {
    console.error('[download-page]', err.message);
    res.status(500).send('Transfer not found or has expired.');
  }
});

// ── GET /api/dl/:transferId/:fileId — file download + notification ───────────
app.get('/api/dl/:transferId/:fileId', limiter, async (req, res) => {
  const { transferId, fileId } = req.params;

  // Password check
  const record = getRecord(transferId);
  if (record?.passwordHash) {
    const { pwd } = req.query;
    if (!pwd || hashPwd(pwd) !== record.passwordHash)
      return res.status(403).send('Forbidden');
  }

  try {
    const token = await getValidToken();
    const r = await axios.get(
      `${GRAPH}/users/${UPN}/drive/items/${fileId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const url = r.data['@microsoft.graph.downloadUrl'];
    if (!url) return res.status(404).send('File not available');

    // Record download + send notification once
    if (record && !record.notified) {
      record.downloadCount = (record.downloadCount || 0) + 1;
      record.notified = true;
      setRecord(transferId, record);
      if (record.senderEmail) sendDownloadNotification(record, transferId).catch(console.error);
    } else if (record) {
      record.downloadCount = (record.downloadCount || 0) + 1;
      setRecord(transferId, record);
    }

    res.redirect(url);
  } catch (err) {
    console.error('[file-download]', err.message);
    res.status(404).send('File not found or has expired.');
  }
});

// ── Download notification email ──────────────────────────────────────────────
async function sendDownloadNotification(record, transferId) {
  const token = await getValidToken();
  const base = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
  const fileList = record.fileNames.map(n => `<li style="padding:2px 0;color:#555;">${escapeHtml(n)}</li>`).join('');
  await axios.post(
    `${GRAPH}/users/${UPN}/sendMail`,
    {
      message: {
        subject: `Your files were downloaded — ${record.title || transferId}`,
        body: {
          contentType: 'HTML',
          content: `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
        <tr><td style="background:#00b69b;padding:24px 36px;">
          <span style="color:#fff;font-size:20px;font-weight:700;">BCIM Engineering</span>
        </td></tr>
        <tr><td style="padding:32px 36px;">
          <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#111;">✓ Your files were downloaded</h2>
          <p style="margin:0 0 20px;font-size:14px;color:#666;">Someone has downloaded the files you sent.</p>
          ${fileList ? `<p style="margin:0 0 6px;font-size:12px;color:#999;text-transform:uppercase;letter-spacing:.06em;font-weight:600;">Files</p><ul style="margin:0 0 20px;padding-left:18px;font-size:13px;">${fileList}</ul>` : ''}
          <a href="${base}/get/${transferId}" style="display:inline-block;background:#00b69b;color:#fff;text-decoration:none;padding:10px 20px;border-radius:7px;font-size:13px;font-weight:600;">View transfer</a>
        </td></tr>
        <tr><td style="padding:16px 36px;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:12px;color:#ccc;text-align:center;">Sent via BCIM Engineering File Transfer</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
        },
        toRecipients: [{ emailAddress: { address: record.senderEmail } }],
      },
      saveToSentItems: false,
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

// ── POST /api/send-email ─────────────────────────────────────────────────────
app.post('/api/send-email', emailLimiter, async (req, res) => {
  const { recipients, senderEmail, title, message, shareLink, fileNames, expiryDays } = req.body;
  if (!recipients || recipients.length === 0)
    return res.status(400).json({ error: 'At least one recipient is required' });

  const displayTitle = sanitizeText(title) || 'Files shared with you';
  const safeMessage  = sanitizeText(message);
  const senderLabel  = sanitizeText(senderEmail) || 'Someone';
  const expiryNum    = parseInt(expiryDays) || 7;

  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + expiryNum);
  const expiryStr = expiryDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const fileList = (fileNames || []).map(n => `<li style="padding:3px 0;color:#555;">${sanitizeText(n)}</li>`).join('');

  const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
        <tr><td style="background:#00b69b;padding:28px 40px;">
          <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px;">BCIM Engineering</span>
        </td></tr>
        <tr><td style="padding:36px 40px;">
          <p style="margin:0 0 6px;font-size:14px;color:#999;">${senderLabel} sent you files</p>
          <h1 style="margin:0 0 24px;font-size:22px;font-weight:700;color:#1a1a1a;">${displayTitle}</h1>
          ${safeMessage ? `<p style="margin:0 0 24px;font-size:15px;color:#444;line-height:1.6;padding:16px;background:#f9f9f9;border-radius:8px;border-left:3px solid #00b69b;">${safeMessage}</p>` : ''}
          ${fileList ? `<p style="margin:0 0 8px;font-size:13px;color:#999;text-transform:uppercase;letter-spacing:.06em;font-weight:600;">Files included</p><ul style="margin:0 0 28px;padding:0 0 0 18px;font-size:14px;">${fileList}</ul>` : ''}
          <p style="margin:0 0 8px;font-size:13px;color:#999;text-transform:uppercase;letter-spacing:.06em;font-weight:600;">Your download link</p>
          <a href="${shareLink}" style="display:block;background:#00b69b;color:#fff;text-decoration:none;text-align:center;padding:16px;border-radius:8px;font-size:16px;font-weight:700;margin-bottom:16px;">Download files →</a>
          <p style="margin:0;font-size:12px;color:#bbb;text-align:center;">Link expires on ${expiryStr} · Files stored securely in the cloud</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:12px;color:#ccc;text-align:center;">Sent via BCIM Engineering File Transfer</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  try {
    const token = await getValidToken();
    await axios.post(
      `${GRAPH}/users/${UPN}/sendMail`,
      {
        message: {
          subject: `${senderLabel} sent you: ${displayTitle}`,
          body: { contentType: 'HTML', content: html },
          toRecipients: recipients.map(r => ({ emailAddress: { address: r } })),
          replyTo: senderEmail ? [{ emailAddress: { address: sanitizeText(senderEmail) } }] : undefined,
        },
        saveToSentItems: false,
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[send-email]', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send email: ' + (err.response?.data?.error?.message || err.message) });
  }
});

// ── GET /admin — dashboard ───────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_PASSWORD) return res.send(adminLoginHtml(false));

  const store = loadStore();
  const now = Date.now();
  const transfers = Object.entries(store).map(([id, r]) => ({ id, ...r }));
  transfers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const totalSize = transfers.reduce((s, t) => s + (t.totalSize || 0), 0);
  const active    = transfers.filter(t => new Date(t.expiresAt) > now).length;

  const rows = transfers.map(t => {
    const expired = new Date(t.expiresAt) <= now;
    const created = new Date(t.createdAt).toLocaleDateString('en-GB');
    const expires = new Date(t.expiresAt).toLocaleDateString('en-GB');
    return `
    <tr class="${expired ? 'expired' : ''}">
      <td><code>${t.id}</code></td>
      <td>${escapeHtml(t.senderEmail || '—')}</td>
      <td>${escapeHtml(t.title || '—')}</td>
      <td>${(t.fileNames || []).length}</td>
      <td>${formatBytes(t.totalSize || 0)}</td>
      <td>${t.downloadCount || 0}</td>
      <td>${created}</td>
      <td>${expires}</td>
      <td><span class="badge ${expired ? 'badge-expired' : 'badge-active'}">${expired ? 'Expired' : 'Active'}</span></td>
      <td>
        <form method="POST" action="/admin/delete/${t.id}?key=${encodeURIComponent(key)}" onsubmit="return confirm('Delete this transfer?')">
          <button class="del-btn" type="submit">Delete</button>
        </form>
      </td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SendDrive Admin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;min-height:100vh;color:#111}
  .topbar{background:#00b69b;padding:16px 32px;display:flex;align-items:center;justify-content:space-between}
  .topbar h1{color:#fff;font-size:18px;font-weight:700}
  .topbar span{color:rgba(255,255,255,.75);font-size:13px}
  .stats{display:flex;gap:16px;padding:24px 32px}
  .stat{background:#fff;border-radius:10px;padding:18px 24px;flex:1;box-shadow:0 1px 4px rgba(0,0,0,.07)}
  .stat-val{font-size:28px;font-weight:700;color:#111}
  .stat-lbl{font-size:12px;color:#999;margin-top:3px;text-transform:uppercase;letter-spacing:.05em}
  .wrap{padding:0 32px 32px}
  table{width:100%;background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.07);border-collapse:collapse;overflow:hidden}
  th{padding:11px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#999;border-bottom:1px solid #f0f0f0;white-space:nowrap}
  td{padding:11px 14px;font-size:13px;border-bottom:1px solid #f8f8f8;vertical-align:middle}
  tr.expired td{color:#bbb}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafafa}
  code{font-size:11px;background:#f0f0f0;padding:2px 6px;border-radius:4px}
  .badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600}
  .badge-active{background:#edf9f7;color:#00b69b}
  .badge-expired{background:#f5f5f5;color:#999}
  .del-btn{background:#fff0f0;border:1px solid #f5c6c6;color:#c00;padding:5px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600;transition:background .15s}
  .del-btn:hover{background:#fde8e8}
</style></head><body>
<div class="topbar">
  <h1>SendDrive Admin</h1>
  <span>BCIM Engineering · ${transfers.length} transfers · ${formatBytes(totalSize)} used</span>
</div>
<div class="stats">
  <div class="stat"><div class="stat-val">${active}</div><div class="stat-lbl">Active transfers</div></div>
  <div class="stat"><div class="stat-val">${transfers.length - active}</div><div class="stat-lbl">Expired</div></div>
  <div class="stat"><div class="stat-val">${formatBytes(totalSize)}</div><div class="stat-lbl">Total storage used</div></div>
  <div class="stat"><div class="stat-val">${transfers.reduce((s,t)=>s+(t.downloadCount||0),0)}</div><div class="stat-lbl">Total downloads</div></div>
</div>
<div class="wrap">
  <table>
    <thead><tr><th>Transfer ID</th><th>Sender</th><th>Title</th><th>Files</th><th>Size</th><th>Downloads</th><th>Created</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="10" style="text-align:center;color:#999;padding:32px">No transfers yet</td></tr>'}</tbody>
  </table>
</div>
</body></html>`);
});

// ── POST /admin/delete/:id ───────────────────────────────────────────────────
app.post('/admin/delete/:transferId', async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_PASSWORD) return res.status(403).send('Forbidden');
  const { transferId } = req.params;
  if (!/^transfer-[0-9a-f]{10}$/.test(transferId)) return res.status(400).send('Invalid');

  try {
    const token = await getValidToken();
    // Delete folder from OneDrive
    await axios.delete(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}/${transferId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => {});
    deleteRecord(transferId);
  } catch {}

  res.redirect(`/admin?key=${encodeURIComponent(key)}`);
});

// ── HTML templates ───────────────────────────────────────────────────────────
function downloadPageHtml(count, fileRows) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BCIM Engineering — File Transfer</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem}
  .card{background:#fff;border-radius:14px;box-shadow:0 4px 32px rgba(0,0,0,.10);width:100%;max-width:480px;overflow:hidden}
  .header{background:#00b69b;padding:26px 32px}
  .header h1{color:#fff;font-size:20px;font-weight:800}
  .header p{color:rgba(255,255,255,.78);font-size:13px;margin-top:4px}
  .body{padding:8px 0}
  .file-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 28px;border-bottom:1px solid #f2f2f2;transition:background .12s}
  .file-row:last-child{border-bottom:none}
  .file-row:hover{background:#fafafa}
  .file-info{flex:1;min-width:0}
  .file-name{font-size:14px;font-weight:600;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .file-size{font-size:12px;color:#999;margin-top:3px}
  .dl-btn{display:inline-flex;align-items:center;background:#00b69b;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap;flex-shrink:0;transition:background .15s}
  .dl-btn:hover{background:#009b84}
  .empty{padding:32px 28px;color:#aaa;font-size:14px}
  .footer{padding:16px 28px;border-top:1px solid #f2f2f2;font-size:12px;color:#ccc;text-align:center}
</style></head><body>
<div class="card">
  <div class="header"><h1>BCIM Engineering</h1><p>${count} file${count!==1?'s':''} ready to download</p></div>
  <div class="body">${fileRows}</div>
  <div class="footer">Sent via BCIM Engineering File Transfer &middot; Files stored securely</div>
</div></body></html>`;
}

function pwdPageHtml(transferId, showError) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BCIM Engineering — Password Required</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
  .card{background:#fff;border-radius:14px;box-shadow:0 4px 32px rgba(0,0,0,.10);width:100%;max-width:380px;overflow:hidden}
  .header{background:#00b69b;padding:24px 28px}
  .header h1{color:#fff;font-size:18px;font-weight:800}
  .header p{color:rgba(255,255,255,.78);font-size:13px;margin-top:3px}
  .body{padding:24px 28px}
  .label{font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
  input[type=password]{width:100%;padding:11px 14px;border:1.5px solid #d0d0d0;border-radius:8px;font-size:14px;outline:none;font-family:inherit;transition:border .2s}
  input[type=password]:focus{border-color:#00b69b}
  .error{margin-top:8px;font-size:13px;color:#c00}
  button{margin-top:14px;width:100%;padding:13px;background:#00b69b;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s}
  button:hover{background:#009b84}
</style></head><body>
<div class="card">
  <div class="header"><h1>BCIM Engineering</h1><p>This transfer is password protected</p></div>
  <div class="body">
    <form method="GET" action="/get/${transferId}">
      <div class="label">Enter password</div>
      <input type="password" name="pwd" placeholder="Password" autofocus required>
      ${showError ? '<div class="error">Incorrect password — try again</div>' : ''}
      <button type="submit">Unlock</button>
    </form>
  </div>
</div></body></html>`;
}

function adminLoginHtml(showError) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SendDrive Admin Login</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
  .card{background:#fff;border-radius:14px;box-shadow:0 4px 32px rgba(0,0,0,.10);width:100%;max-width:340px;overflow:hidden}
  .header{background:#00b69b;padding:24px 28px}
  .header h1{color:#fff;font-size:18px;font-weight:800}
  .body{padding:24px 28px}
  .label{font-size:12px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
  input{width:100%;padding:11px 14px;border:1.5px solid #d0d0d0;border-radius:8px;font-size:14px;outline:none;font-family:inherit;transition:border .2s}
  input:focus{border-color:#00b69b}
  button{margin-top:14px;width:100%;padding:13px;background:#00b69b;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}
  button:hover{background:#009b84}
  .error{margin-top:8px;font-size:13px;color:#c00}
</style></head><body>
<div class="card">
  <div class="header"><h1>SendDrive Admin</h1></div>
  <div class="body">
    <form method="GET" action="/admin">
      <div class="label">Admin password</div>
      <input type="password" name="key" placeholder="Password" autofocus required>
      ${showError ? '<div class="error">Incorrect password</div>' : ''}
      <button type="submit">Login</button>
    </form>
  </div>
</div></body></html>`;
}

// ── Serve built frontend ─────────────────────────────────────────────────────
const distPath = path.join(__dirname, '../senddrive/dist');
app.use(express.static(distPath));
app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));

app.listen(process.env.PORT || 3001, () =>
  console.log(`SendDrive server running on port ${process.env.PORT || 3001}`)
);
