export async function createTransfer() {
  const res = await fetch('/api/create-transfer', { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create transfer');
  }
  return res.json();
}

async function uploadChunk(uploadUrl, chunk, start, end, fileSize) {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(end - start),
      'Content-Range': `bytes ${start}-${end - 1}/${fileSize}`,
    },
    body: chunk,
  });
  if (res.status === 200 || res.status === 201 || res.status === 202) return res;
  throw new Error(`HTTP ${res.status}`);
}

export async function uploadFile(file, transferId, onProgress) {
  const sessionRes = await fetch('/api/upload-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, fileSize: file.size, transferId }),
  });

  if (!sessionRes.ok) {
    const err = await sessionRes.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create upload session');
  }

  const { uploadUrl } = await sessionRes.json();

  const CHUNK_SIZE = 10 * 1024 * 1024;
  const fileSize = file.size;
  let start = 0;

  while (start < fileSize) {
    const end = Math.min(start + CHUNK_SIZE, fileSize);
    const chunk = file.slice(start, end);

    let delay = 1000;
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await uploadChunk(uploadUrl, chunk, start, end, fileSize);
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
}

