export async function createTransfer() {
  const res = await fetch('/api/create-transfer', { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create transfer');
  }
  return res.json();
}

// Uses XMLHttpRequest instead of fetch so we get real byte-level upload
// progress (xhr.upload.onprogress) even within a single chunk — fetch has no
// upload progress event, which made small files (under one 10MB chunk) jump
// straight from 0% to 100% with nothing in between.
function uploadChunk(uploadUrl, chunk, start, end, fileSize, onChunkProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Range', `bytes ${start}-${end - 1}/${fileSize}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onChunkProgress) onChunkProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status === 200 || xhr.status === 201 || xhr.status === 202) resolve();
      else reject(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(chunk);
  });
}

// ── Resumable session persistence ────────────────────────────────────────────
// If the tab is closed/reloaded mid-upload, the next attempt for the *same*
// file (same name+size, same transfer) picks up the existing Graph upload
// session instead of starting over from byte 0. Graph upload sessions expire
// on their own (~a few days) — if the saved session is no longer valid, we
// silently fall back to creating a fresh one.
const SESSION_KEY = 'sd_upload_sessions';

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); } catch { return {}; }
}
function saveSessions(sessions) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(sessions)); } catch { /* storage full/unavailable — non-fatal */ }
}
function sessionKey(transferId, file) {
  return `${transferId}::${file.name}::${file.size}`;
}

async function getResumeOffset(uploadUrl, fileSize) {
  const res = await fetch(uploadUrl); // GET on a Graph upload session URL returns its current status
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const range = data?.nextExpectedRanges?.[0];
  if (!range) return null;
  const start = parseInt(range.split('-')[0], 10);
  return Number.isFinite(start) && start >= 0 && start < fileSize ? start : null;
}

export async function uploadFile(file, transferId, uploadToken, onProgress) {
  const key = sessionKey(transferId, file);
  const sessions = loadSessions();
  const fileSize = file.size;
  let uploadUrl = sessions[key];
  let start = 0;

  if (uploadUrl) {
    const resumeOffset = await getResumeOffset(uploadUrl, fileSize).catch(() => null);
    if (resumeOffset != null) {
      start = resumeOffset;
    } else {
      uploadUrl = null; // stale/expired session — create a new one below
    }
  }

  if (!uploadUrl) {
    const sessionRes = await fetch('/api/upload-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, fileSize, transferId, uploadToken }),
    });
    if (!sessionRes.ok) {
      const err = await sessionRes.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to create upload session');
    }
    ({ uploadUrl } = await sessionRes.json());
    start = 0;
  }

  sessions[key] = uploadUrl;
  saveSessions(sessions);

  const CHUNK_SIZE = 10 * 1024 * 1024;
  onProgress(Math.round((start / fileSize) * 100));

  while (start < fileSize) {
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    const chunk = file.slice(start, end);

    let delay = 1000;
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await uploadChunk(uploadUrl, chunk, start, end, fileSize, (loadedInChunk) => {
          onProgress(Math.round(((start + loadedInChunk) / fileSize) * 100));
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
      }
    }
    if (lastErr) throw new Error(`Upload failed at byte ${start}: ${lastErr.message}`);

    start = end;
    onProgress(Math.round((end / fileSize) * 100));
  }

  const remaining = loadSessions();
  delete remaining[key];
  saveSessions(remaining);
}
