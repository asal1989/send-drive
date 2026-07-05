require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const archiver = require('archiver'); // pinned to 7.0.1 in package.json — 8.x is ESM-only and dropped the archiver('zip', opts) factory API
const { getValidToken } = require('./auth');
const { verifyIdToken } = require('./staffAuth');

const app = express();
app.set('trust proxy', 1); // trust Nginx reverse proxy
const GRAPH = 'https://graph.microsoft.com/v1.0';
const FOLDER = process.env.UPLOAD_FOLDER || 'SendDrive';
const UPN = process.env.ONEDRIVE_USER_UPN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD || ADMIN_PASSWORD === 'admin123' || ADMIN_PASSWORD === 'change_this_to_a_strong_password') {
  throw new Error('ADMIN_PASSWORD must be set to a strong production value');
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',').map(s => s.trim());

app.use(cors({ origin: allowedOrigins, methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ── Rate limiters ────────────────────────────────────────────────────────────
const limiter      = rateLimit({ windowMs: 15 * 60 * 1000, max: 60,  standardHeaders: true, legacyHeaders: false });
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10,  standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20,  standardHeaders: true, legacyHeaders: false });

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
function isTransferId(id)        { return /^transfer-[0-9a-f]{10}$/.test(id || ''); }
function isEmail(email)          { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim()); }
function makeBaseUrl()           { return (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3002}`).replace(/\/$/, ''); }
function transferUrl(id)         { return `${makeBaseUrl()}/get/${id}`; }
function makeToken()             { return crypto.randomBytes(24).toString('hex'); }

function hashPwd(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(pwd), salt, 210000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPwd(pwd, stored) {
  if (!pwd || !stored) return false;
  if (/^[a-f0-9]{64}$/i.test(stored)) return crypto.createHash('sha256').update(pwd).digest('hex') === stored;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const hash = crypto.pbkdf2Sync(String(pwd), parts[1], 210000, 32, 'sha256').toString('hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function hasExpired(record) {
  const expiresAt = new Date(record?.expiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function isRegistered(record) {
  return Boolean(record && record.registered !== false);
}

function assertTransferToken(record, token) {
  if (!record?.uploadToken || !token) return false;
  const expected = Buffer.from(record.uploadToken);
  const actual = Buffer.from(String(token));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function authCookieName(transferId) {
  return `sd_auth_${transferId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

function signTransferAuth(transferId, passwordHash) {
  return crypto.createHmac('sha256', ADMIN_PASSWORD).update(`${transferId}:${passwordHash}`).digest('hex');
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  return raw.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);
}

function hasPasswordAccess(req, transferId, record) {
  if (!record?.passwordHash) return true;
  const token = getCookie(req, authCookieName(transferId));
  return token === signTransferAuth(transferId, record.passwordHash);
}

function signAdminAuth() {
  return crypto.createHmac('sha256', ADMIN_PASSWORD).update('admin').digest('hex');
}

function hasAdminAccess(req) {
  return getCookie(req, 'sd_admin') === signAdminAuth();
}

// ── Staff-only login (Sign in with Microsoft / company account) ─────────────
// Gates the SENDER side only (creating/managing transfers) — the recipient
// download page (/get/:transferId) stays public on purpose, since the whole
// point of the tool is staff sending files to external people who were never
// going to have a company Microsoft account. Real enforcement happens
// server-side here; the frontend login screen is just the UX for it.
function signStaffAuth(email) {
  return crypto.createHmac('sha256', ADMIN_PASSWORD).update(`staff:${email}`).digest('hex');
}

function hasStaffAccess(req) {
  const email = getCookie(req, 'sd_staff_email');
  const sig   = getCookie(req, 'sd_staff_sig');
  if (!email || !sig) return false;
  const expected = Buffer.from(signStaffAuth(decodeURIComponent(email)));
  const actual   = Buffer.from(sig);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireStaff(req, res, next) {
  if (hasStaffAccess(req)) return next();
  res.status(401).json({ error: 'Sign in with your company Microsoft account first' });
}

function getExt(name) {
  const p = String(name || '').lastIndexOf('.');
  return p > -1 ? name.slice(p + 1).toUpperCase().slice(0, 4) : 'FILE';
}

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

// ── POST /api/auth/verify — exchange a Microsoft ID token for a staff session ──
app.post('/api/auth/verify', limiter, async (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: 'idToken required' });
  try {
    const { email, name } = await verifyIdToken(idToken);
    const sig = signStaffAuth(email);
    const common = 'HttpOnly; SameSite=Lax; Path=/; Max-Age=43200'; // 12 hours
    const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `sd_staff_email=${encodeURIComponent(email)}; ${common}${secureFlag}`,
      `sd_staff_sig=${sig}; ${common}${secureFlag}`,
    ]);
    res.json({ ok: true, email, name });
  } catch (err) {
    console.error('[auth/verify]', err.message);
    res.status(403).json({ error: 'Not a valid company account, or sign-in could not be verified' });
  }
});

// ── GET /api/auth/me — current staff session, if any ─────────────────────────
app.get('/api/auth/me', (req, res) => {
  if (!hasStaffAccess(req)) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, email: decodeURIComponent(getCookie(req, 'sd_staff_email') || '') });
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    'sd_staff_email=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    'sd_staff_sig=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
  ]);
  res.json({ ok: true });
});

// ── POST /api/create-transfer ────────────────────────────────────────────────
app.post('/api/create-transfer', limiter, requireStaff, async (req, res) => {
  const transferId = `transfer-${crypto.randomBytes(5).toString('hex')}`;
  const uploadToken = makeToken();
  try {
    const token = await getValidToken();
    const folder = await axios.post(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}:/children`,
      { name: transferId, folder: {}, '@microsoft.graph.conflictBehavior': 'rename' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 7);
    setRecord(transferId, {
      createdAt: new Date().toISOString(),
      expiresAt: expiryDate.toISOString(),
      folderId: folder.data.id,
      uploadToken,
      registered: false,
      senderEmail: '',
      title: '',
      fileNames: [],
      fileSizes: [],
      totalSize: 0,
      downloadCount: 0,
      notified: false,
      passwordHash: null,
    });
    res.json({ transferId, uploadToken, downloadPageUrl: transferUrl(transferId) });
  } catch (err) {
    console.error('[create-transfer]', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create transfer folder' });
  }
});

// ── POST /api/upload-session ─────────────────────────────────────────────────
app.post('/api/upload-session', limiter, requireStaff, async (req, res) => {
  const { fileName, fileSize, transferId, uploadToken } = req.body;
  if (!fileName || !fileSize || !transferId || !uploadToken)
    return res.status(400).json({ error: 'fileName, fileSize, transferId and uploadToken are required' });
  if (!isTransferId(transferId)) return res.status(400).json({ error: 'Invalid transferId' });
  if (!Number.isFinite(Number(fileSize)) || Number(fileSize) <= 0 || Number(fileSize) > 250 * 1024 * 1024 * 1024)
    return res.status(400).json({ error: 'Invalid file size' });
  const record = getRecord(transferId);
  if (!assertTransferToken(record, uploadToken)) return res.status(403).json({ error: 'Forbidden' });
  if (hasExpired(record)) return res.status(410).json({ error: 'Transfer has expired' });
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
app.post('/api/register-transfer', limiter, requireStaff, (req, res) => {
  const { transferId, uploadToken, senderEmail, title, fileNames, fileSizes, expiryDays, password } = req.body;
  if (!transferId || !isTransferId(transferId))
    return res.status(400).json({ error: 'Invalid transferId' });
  const record = getRecord(transferId);
  if (!assertTransferToken(record, uploadToken)) return res.status(403).json({ error: 'Forbidden' });

  const days = Math.max(1, Math.min(30, parseInt(expiryDays) || 7));
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + days);
  const safeFileSizes = Array.isArray(fileSizes) ? fileSizes.map(Number).filter(n => Number.isFinite(n) && n >= 0) : [];

  setRecord(transferId, {
    ...record,
    createdAt:    new Date().toISOString(),
    expiresAt:    expiryDate.toISOString(),
    registered:   true,
    senderEmail:  isEmail(senderEmail) ? sanitizeText(senderEmail) : '',
    title:        sanitizeText(title),
    fileNames:    Array.isArray(fileNames) ? fileNames.map(n => sanitizeText(n)).slice(0, 200) : [],
    fileSizes:    safeFileSizes,
    totalSize:    safeFileSizes.reduce((a, b) => a + b, 0),
    downloadCount: 0,
    notified:     false,
    passwordHash: password ? hashPwd(password) : null,
  });
  res.json({ ok: true });
});

// ── GET /get/:transferId — download page ─────────────────────────────────────
app.get('/get/:transferId', limiter, async (req, res) => {
  const { transferId } = req.params;

  if (!isTransferId(transferId))
    return res.status(404).send('Not found');

  const record = getRecord(transferId);
  if (!isRegistered(record) || hasExpired(record)) return res.status(410).send('Transfer not found or has expired.');

  // Password gate
  if (!hasPasswordAccess(req, transferId, record)) {
    return res.send(pwdPageHtml(transferId, false));
  }

  try {
    const token = await getValidToken();
    const r = await axios.get(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}/${transferId}:/children`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const files = (r.data.value || []).filter(f => !f.folder);

    // Best-effort preview thumbnails (images/PDFs/office docs) — Graph returns
    // a thumbnail set per item when one can be generated; anything else (zip,
    // exe, etc.) simply has no thumbnail and falls back to the file-type badge.
    const thumbUrls = await Promise.all(files.map(async f => {
      try {
        const t = await axios.get(
          `${GRAPH}/users/${UPN}/drive/items/${f.id}/thumbnails`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        return t.data.value?.[0]?.medium?.url || null;
      } catch { return null; }
    }));

    const fileRows = files.length
      ? files.map((f, i) => `
        <div class="file-row">
          ${thumbUrls[i]
            ? `<img class="file-thumb" src="${escapeHtml(thumbUrls[i])}" alt="">`
            : `<div class="file-thumb file-thumb-badge">${escapeHtml(getExt(f.name))}</div>`}
          <div class="file-info">
            <div class="file-name">${escapeHtml(f.name)}</div>
            <div class="file-size">${formatBytes(f.size)}</div>
          </div>
          <a class="dl-btn" href="/api/dl/${escapeHtml(transferId)}/${escapeHtml(f.id)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right:6px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </a>
        </div>`).join('')
      : '<p class="empty">No files found or this transfer has expired.</p>';

    res.send(downloadPageHtml(files.length, fileRows, transferId));
  } catch (err) {
    console.error('[download-page]', err.message);
    res.status(500).send('Transfer not found or has expired.');
  }
});

app.post('/get/:transferId/unlock', limiter, (req, res) => {
  const { transferId } = req.params;
  const { pwd } = req.body;
  if (!isTransferId(transferId)) return res.status(404).send('Not found');
  const record = getRecord(transferId);
  if (!isRegistered(record) || hasExpired(record)) return res.status(410).send('Transfer not found or has expired.');
  if (!verifyPwd(pwd, record.passwordHash)) return res.status(403).send(pwdPageHtml(transferId, true));

  const cookie = `${authCookieName(transferId)}=${signTransferAuth(transferId, record.passwordHash)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`;
  res.setHeader('Set-Cookie', process.env.NODE_ENV === 'production' ? `${cookie}; Secure` : cookie);
  res.redirect(`/get/${transferId}`);
});

// ── GET /api/dl/:transferId/:fileId — file download + notification ───────────
app.get('/api/dl/:transferId/:fileId', limiter, async (req, res) => {
  const { transferId, fileId } = req.params;
  if (!isTransferId(transferId)) return res.status(404).send('Not found');

  // Password check
  const record = getRecord(transferId);
  if (!isRegistered(record) || hasExpired(record)) return res.status(410).send('Transfer not found or has expired.');
  if (!hasPasswordAccess(req, transferId, record)) return res.status(403).send('Forbidden');

  try {
    const token = await getValidToken();
    const children = await axios.get(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}/${transferId}:/children`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const allowed = (children.data.value || []).some(f => !f.folder && f.id === fileId);
    if (!allowed) return res.status(404).send('File not found or has expired.');

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

// ── GET /api/dl-zip/:transferId — download all files as ZIP ─────────────────
app.get('/api/dl-zip/:transferId', limiter, async (req, res) => {
  const { transferId } = req.params;
  if (!isTransferId(transferId)) return res.status(404).send('Not found');

  const record = getRecord(transferId);
  if (!isRegistered(record) || hasExpired(record)) return res.status(410).send('Transfer not found or has expired.');
  if (!hasPasswordAccess(req, transferId, record)) return res.status(403).send('Forbidden');

  try {
    const token = await getValidToken();
    const children = await axios.get(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}/${transferId}:/children`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const files = (children.data.value || []).filter(f => !f.folder);
    if (!files.length) return res.status(404).send('No files found.');

    const zipName = sanitizeFileName((record.title || transferId).replace(/\s+/g, '_')) + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 0 } }); // level 0 = store only (fast, no recompression)
    archive.on('error', err => { console.error('[dl-zip] archiver error', err.message); });
    archive.pipe(res);

    for (const f of files) {
      try {
        const meta = await axios.get(
          `${GRAPH}/users/${UPN}/drive/items/${f.id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const dlUrl = meta.data['@microsoft.graph.downloadUrl'];
        if (!dlUrl) continue;
        const stream = await axios.get(dlUrl, { responseType: 'stream' });
        archive.append(stream.data, { name: f.name });
        await new Promise((resolve, reject) => {
          stream.data.on('end', resolve);
          stream.data.on('error', reject);
        });
      } catch (e) {
        console.error('[dl-zip] file error', f.name, e.message);
      }
    }

    // Update download count
    if (record) {
      record.downloadCount = (record.downloadCount || 0) + 1;
      if (!record.notified) {
        record.notified = true;
        setRecord(transferId, record);
        if (record.senderEmail) sendDownloadNotification(record, transferId).catch(console.error);
      } else {
        setRecord(transferId, record);
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('[dl-zip]', err.message);
    if (!res.headersSent) res.status(500).send('Failed to create ZIP.');
  }
});

// ── GET /api/transfer/:transferId/status — sender-side status (no password needed) ──
// Used by the "My Transfers" panel — auth is the uploadToken itself, same trust
// level as the download link (whoever holds the token created the transfer).
app.get('/api/transfer/:transferId/status', limiter, requireStaff, (req, res) => {
  const { transferId } = req.params;
  const token = req.query.token;
  if (!isTransferId(transferId)) return res.status(404).json({ error: 'Not found' });
  const record = getRecord(transferId);
  if (!assertTransferToken(record, token)) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    transferId,
    title: record.title,
    fileNames: record.fileNames || [],
    totalSize: record.totalSize || 0,
    downloadCount: record.downloadCount || 0,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    expired: hasExpired(record),
    hasPassword: !!record.passwordHash,
  });
});

// ── POST /api/transfer/:transferId/cancel — sender-initiated recall ──────────
// Same trust model as above: holding the uploadToken is proof of ownership.
app.post('/api/transfer/:transferId/cancel', limiter, requireStaff, async (req, res) => {
  const { transferId } = req.params;
  const { uploadToken } = req.body;
  if (!isTransferId(transferId)) return res.status(404).json({ error: 'Not found' });
  const record = getRecord(transferId);
  if (!assertTransferToken(record, uploadToken)) return res.status(403).json({ error: 'Forbidden' });

  try {
    const token = await getValidToken();
    await axios.delete(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}/${transferId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => {});
    deleteRecord(transferId);
    res.json({ ok: true });
  } catch (err) {
    console.error('[transfer-cancel]', err.message);
    res.status(500).json({ error: 'Failed to cancel transfer' });
  }
});

// ── Download notification email ──────────────────────────────────────────────
async function sendDownloadNotification(record, transferId) {
  const token = await getValidToken();
  const fileList = (record.fileNames || []).map(n => `<li style="padding:2px 0;color:#555;">${escapeHtml(n)}</li>`).join('');
  await axios.post(
    `${GRAPH}/users/${UPN}/sendMail`,
    {
      message: {
        subject: `Your files were downloaded — ${sanitizeText(record.title) || transferId}`,
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
          <a href="${transferUrl(transferId)}" style="display:inline-block;background:#00b69b;color:#fff;text-decoration:none;padding:10px 20px;border-radius:7px;font-size:13px;font-weight:600;">View transfer</a>
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
app.post('/api/send-email', emailLimiter, requireStaff, async (req, res) => {
  const { transferId, uploadToken, recipients, senderEmail, title, message, fileNames, expiryDays } = req.body;
  if (!isTransferId(transferId)) return res.status(400).json({ error: 'Invalid transferId' });
  const record = getRecord(transferId);
  if (!assertTransferToken(record, uploadToken)) return res.status(403).json({ error: 'Forbidden' });
  if (!isRegistered(record) || hasExpired(record)) return res.status(410).json({ error: 'Transfer has expired' });

  const safeRecipients = Array.isArray(recipients)
    ? [...new Set(recipients.map(r => String(r || '').trim().toLowerCase()).filter(isEmail))].slice(0, 3)
    : [];
  if (safeRecipients.length === 0)
    return res.status(400).json({ error: 'At least one recipient is required' });

  const displayTitle = sanitizeText(title) || 'Files shared with you';
  const safeMessage  = sanitizeText(message);
  const senderLabel  = isEmail(senderEmail) ? sanitizeText(senderEmail) : 'Someone';
  const expiryNum    = Math.max(1, Math.min(30, parseInt(expiryDays) || 7));
  const shareLink    = transferUrl(transferId);

  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + expiryNum);
  const expiryStr = expiryDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const fileList = (Array.isArray(fileNames) ? fileNames : record.fileNames || [])
    .map(n => `<li style="padding:3px 0;color:#555;">${escapeHtml(sanitizeText(n))}</li>`).join('');

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
          <p style="margin:0 0 6px;font-size:14px;color:#999;">${escapeHtml(senderLabel)} sent you files</p>
          <h1 style="margin:0 0 24px;font-size:22px;font-weight:700;color:#1a1a1a;">${escapeHtml(displayTitle)}</h1>
          ${safeMessage ? `<p style="margin:0 0 24px;font-size:15px;color:#444;line-height:1.6;padding:16px;background:#f9f9f9;border-radius:8px;border-left:3px solid #00b69b;">${escapeHtml(safeMessage)}</p>` : ''}
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
          toRecipients: safeRecipients.map(r => ({ emailAddress: { address: r } })),
          replyTo: isEmail(senderEmail) ? [{ emailAddress: { address: sanitizeText(senderEmail) } }] : undefined,
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
app.get('/admin', adminLimiter, (req, res) => {
  if (!hasAdminAccess(req)) return res.send(adminLoginHtml(false));

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
        <form method="POST" action="/admin/delete/${t.id}" onsubmit="return confirm('Delete this transfer?')">
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

app.post('/admin/login', adminLimiter, (req, res) => {
  const { key } = req.body;
  if (key !== ADMIN_PASSWORD) return res.status(403).send(adminLoginHtml(true));
  const cookie = `sd_admin=${signAdminAuth()}; HttpOnly; SameSite=Lax; Path=/admin; Max-Age=28800`;
  res.setHeader('Set-Cookie', process.env.NODE_ENV === 'production' ? `${cookie}; Secure` : cookie);
  res.redirect('/admin');
});

// ── POST /admin/delete/:id ───────────────────────────────────────────────────
app.post('/admin/delete/:transferId', adminLimiter, async (req, res) => {
  if (!hasAdminAccess(req)) return res.status(403).send('Forbidden');
  const { transferId } = req.params;
  if (!isTransferId(transferId)) return res.status(400).send('Invalid');

  try {
    const token = await getValidToken();
    // Delete folder from OneDrive
    await axios.delete(
      `${GRAPH}/users/${UPN}/drive/root:/${FOLDER}/${transferId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => {});
    deleteRecord(transferId);
  } catch {}

  res.redirect('/admin');
});

function portalPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>BCIM Engineering - Internal Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--sidebar-bg:#0F1C2E;--sidebar-text:#E8EDF4;--sidebar-muted:#6B82A0;--sidebar-badge-bg:rgba(255,255,255,.08);--main-bg:#F0F2F5;--main-surface:#fff;--main-border:#E4E7EC;--main-text:#1A1F2E;--main-muted:#6B7280;--main-subtle:#9CA3AF;--accent-red:#E05A3A;--accent-green:#16A97A;--accent-blue:#2D7DD2;--accent-teal:#0EA5AA;--radius:14px;--font:'Inter',sans-serif}
html,body{height:100%;font-family:var(--font);background:#D8DCE3}
.shell{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.window{display:flex;width:100%;max-width:1020px;min-height:580px;border-radius:20px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.22)}
.sidebar{width:280px;flex-shrink:0;background:var(--sidebar-bg);display:flex;flex-direction:column;position:relative;overflow:hidden}
.sidebar::before{content:'';position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,.06) 1px,transparent 1px);background-size:22px 22px;pointer-events:none}
.sidebar-brand{display:flex;align-items:center;gap:12px;padding:22px 22px 20px;border-bottom:1px solid rgba(255,255,255,.06);position:relative}
.brand-logo{width:40px;height:40px;background:#fff;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.brand-logo span{font-size:11px;font-weight:800;color:#0F1C2E;letter-spacing:.02em}
.brand-name{font-size:15px;font-weight:700;color:var(--sidebar-text);line-height:1.2}
.brand-sub{font-size:10px;font-weight:500;color:var(--sidebar-muted);letter-spacing:.12em;text-transform:uppercase;margin-top:2px}
.sidebar-body{flex:1;padding:28px 22px 22px;position:relative}
.app-hub-title{font-size:28px;font-weight:800;color:#fff;line-height:1.1;margin-bottom:14px}
.app-hub-title span{color:var(--accent-red)}
.sidebar-desc{font-size:13px;color:var(--sidebar-muted);line-height:1.65;margin-bottom:32px}
.platform-label{font-size:10px;font-weight:600;color:var(--sidebar-muted);letter-spacing:.14em;text-transform:uppercase;margin-bottom:14px}
.info-items{display:flex;flex-direction:column;gap:2px}
.info-item{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:10px;background:var(--sidebar-badge-bg);margin-bottom:4px}
.info-item i{font-size:16px;color:var(--accent-blue);width:18px;text-align:center}
.info-item span{font-size:13px;font-weight:500;color:var(--sidebar-text)}
.sidebar-footer{padding:16px 22px;border-top:1px solid rgba(255,255,255,.06);display:flex;align-items:center;gap:8px;position:relative}
.footer-dot{width:8px;height:8px;border-radius:50%;background:var(--accent-green);animation:blink 2.4s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.footer-label{font-size:10px;font-weight:600;color:var(--sidebar-muted);letter-spacing:.12em;text-transform:uppercase}
.footer-version{margin-left:auto;font-size:10px;color:var(--sidebar-muted);letter-spacing:.06em}
.main{flex:1;background:var(--main-bg);display:flex;flex-direction:column;min-width:0}
.main-topbar{background:var(--main-surface);border-bottom:1px solid var(--main-border);padding:0 28px;height:52px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.topbar-title{font-size:11px;font-weight:600;color:var(--main-subtle);letter-spacing:.14em;text-transform:uppercase}
.topbar-time{font-size:13px;font-weight:500;color:var(--main-muted)}
.main-content{flex:1;padding:28px 28px 0;display:flex;flex-direction:column}
.content-heading{font-size:24px;font-weight:700;color:var(--main-text);margin-bottom:4px}
.content-sub{font-size:13px;color:var(--main-muted);margin-bottom:24px}
.app-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;flex:1}
.app-card{background:var(--main-surface);border:1px solid var(--main-border);border-radius:var(--radius);padding:28px 24px 22px;text-decoration:none;display:flex;flex-direction:column;align-items:center;text-align:center;transition:transform .18s,box-shadow .18s,border-color .18s;cursor:pointer}
.app-card:hover{transform:translateY(-3px);box-shadow:0 8px 32px rgba(0,0,0,.09);border-color:#C8CDD6}
.app-card:active{transform:translateY(-1px)}
.app-icon-wrap{width:64px;height:64px;border-radius:16px;border:1px solid var(--main-border);display:flex;align-items:center;justify-content:center;font-size:28px;margin-bottom:16px}
.app-name{font-size:16px;font-weight:600;color:var(--main-text);margin-bottom:4px}
.app-category{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px}
.app-url{font-size:11px;color:var(--main-subtle);margin-bottom:12px;font-family:'Courier New',monospace}
.app-status{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:3px 14px;border-radius:20px}
.app-status.live{color:var(--accent-green);background:rgba(22,169,122,.08)}
.app-status.cloud{color:var(--accent-blue);background:rgba(45,125,210,.08)}
.card-green .app-icon-wrap{background:#F0FDF8;border-color:#B9F0DC;color:var(--accent-green)}.card-green .app-category{color:var(--accent-green)}
.card-red .app-icon-wrap{background:#FEF4F0;border-color:#FAC9B8;color:var(--accent-red)}.card-red .app-category{color:var(--accent-red)}
.card-blue .app-icon-wrap{background:#F0F6FE;border-color:#BADAF8;color:var(--accent-blue)}.card-blue .app-category{color:var(--accent-blue)}
.card-teal .app-icon-wrap{background:#F0FBFC;border-color:#A8E9EB;color:var(--accent-teal)}.card-teal .app-category{color:var(--accent-teal)}
.main-footer{padding:14px 28px;border-top:1px solid var(--main-border);background:var(--main-surface);text-align:center;font-size:12px;color:var(--main-subtle);margin-top:auto;flex-shrink:0}
@media(max-width:700px){.shell{padding:0}.window{flex-direction:column;border-radius:0;min-height:100vh}.sidebar{width:100%}.app-grid{grid-template-columns:1fr}.main-content{padding:20px 16px 0}.main-topbar{padding:0 16px}}
</style>
</head>
<body>
<div class="shell"><div class="window">
  <aside class="sidebar">
    <div class="sidebar-brand"><div class="brand-logo"><span>BCIM</span></div><div><div class="brand-name">BCIM Engineering</div><div class="brand-sub">Internal Portal</div></div></div>
    <div class="sidebar-body">
      <h2 class="app-hub-title">App <span>Hub</span></h2>
      <p class="sidebar-desc">One place to access all BCIM internal web applications. Click any app to open it securely.</p>
      <p class="platform-label">Platform Info</p>
      <div class="info-items">
        <div class="info-item"><i class="ti ti-device-desktop" aria-hidden="true"></i><span>3 apps connected</span></div>
        <div class="info-item"><i class="ti ti-world" aria-hidden="true"></i><span>Remote via DDNS</span></div>
        <div class="info-item"><i class="ti ti-user-shield" aria-hidden="true"></i><span>Authorized personnel only</span></div>
        <div class="info-item"><i class="ti ti-lock" aria-hidden="true"></i><span>Role-based access</span></div>
      </div>
    </div>
    <div class="sidebar-footer"><div class="footer-dot"></div><span class="footer-label">BCIM Office Server</span><span class="footer-version">v1.0</span></div>
  </aside>
  <div class="main">
    <div class="main-topbar"><span class="topbar-title">Internal Applications</span><span class="topbar-time" id="clock"></span></div>
    <div class="main-content">
      <h1 class="content-heading">Select Your Application</h1>
      <p class="content-sub">All apps open in a new tab. Contact IT if you face access issues.</p>
      <div class="app-grid">
        <a class="app-card card-green" href="http://bcim.ddns.net:3002/" target="_blank" rel="noopener noreferrer"><div class="app-icon-wrap"><i class="ti ti-cloud-upload" aria-hidden="true"></i></div><p class="app-name">SendDrive</p><p class="app-category">File Transfer</p><p class="app-url">bcim.ddns.net:3002</p><span class="app-status live">Live</span></a>
        <a class="app-card card-blue" href="http://bcim.ddns.net:3000/" target="_blank" rel="noopener noreferrer"><div class="app-icon-wrap"><i class="ti ti-device-desktop-analytics" aria-hidden="true"></i></div><p class="app-name">TQS ERP</p><p class="app-category">Enterprise Resource Planning</p><p class="app-url">bcim.ddns.net:3000</p><span class="app-status live">Live</span></a>
        <a class="app-card card-teal" href="http://bcim.ddns.net:5173/" target="_blank" rel="noopener noreferrer"><div class="app-icon-wrap"><i class="ti ti-file-type-pdf" aria-hidden="true"></i></div><p class="app-name">BCIM PDF Toolkit</p><p class="app-category">PDF Tools</p><p class="app-url">bcim.ddns.net:5173</p><span class="app-status live">Live</span></a>
        <div class="app-card card-red" style="opacity:.45;cursor:default;pointer-events:none"><div class="app-icon-wrap"><i class="ti ti-plus" aria-hidden="true"></i></div><p class="app-name">Coming Soon</p><p class="app-category">New Application</p><p class="app-url">-</p><span class="app-status cloud">Pending</span></div>
      </div>
    </div>
    <footer class="main-footer">© 2026 BCIM Engineering Private Limited &nbsp;·&nbsp; Authorized personnel only</footer>
  </div>
</div></div>
<script>
function updateClock(){const now=new Date();const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];let h=now.getHours(),min=String(now.getMinutes()).padStart(2,'0');const ampm=h>=12?'pm':'am';h=h%12||12;document.getElementById('clock').textContent=days[now.getDay()]+', '+now.getDate()+' '+months[now.getMonth()]+' · '+h+':'+min+' '+ampm}
updateClock();setInterval(updateClock,30000);
</script>
</body>
</html>`;
}

app.get(['/portal', '/softwares', '/apps'], (req, res) => {
  res.send(portalPageHtml());
});

// ── HTML templates ───────────────────────────────────────────────────────────
function downloadPageHtml(count, fileRows, transferId) {
  const showZip = count > 1;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BCIM Engineering — File Transfer</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2rem 1rem}
  .card{background:#fff;border-radius:14px;box-shadow:0 4px 32px rgba(0,0,0,.10);width:100%;max-width:480px;overflow:hidden}
  .header{background:#00b69b;padding:26px 32px}
  .header h1{color:#fff;font-size:20px;font-weight:800}
  .header p{color:rgba(255,255,255,.78);font-size:13px;margin-top:4px}
  .zip-bar{padding:14px 28px;border-bottom:2px solid #f2f2f2;display:flex;align-items:center;justify-content:space-between;gap:12px;background:#f9fffe}
  .zip-label{font-size:13px;color:#555;font-weight:500}
  .zip-btn{display:inline-flex;align-items:center;gap:7px;background:#00b69b;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;white-space:nowrap;flex-shrink:0;transition:background .15s;border:none;cursor:pointer}
  .zip-btn:hover{background:#009b84}
  .body{padding:8px 0}
  .file-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 28px;border-bottom:1px solid #f2f2f2;transition:background .12s}
  .file-row:last-child{border-bottom:none}
  .file-row:hover{background:#fafafa}
  .file-thumb{width:42px;height:42px;border-radius:8px;object-fit:cover;flex-shrink:0;background:#f2f2f2}
  .file-thumb-badge{display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:#00b69b;background:#e6faf7}
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
  ${showZip ? `<div class="zip-bar">
    <span class="zip-label">Download all ${count} files at once</span>
    <a class="zip-btn" href="/api/dl-zip/${escapeHtml(transferId)}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Download All (.zip)
    </a>
  </div>` : ''}
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
    <form method="POST" action="/get/${transferId}/unlock">
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
    <form method="POST" action="/admin/login">
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
