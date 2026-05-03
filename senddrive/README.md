# SendDrive – OneDrive File Transfer Portal

A WeTransfer-style file transfer portal that uses your own Microsoft OneDrive as storage.
Upload files, generate shareable links with expiry dates, and optionally password-protect them.

---

## Features

- Drag-and-drop file uploads to your OneDrive
- Resumable uploads (supports large files up to 2 GB each)
- Shareable download links with expiry (1–30 days)
- Optional password protection on links
- Microsoft account login (personal and work/school accounts)

---

## Step 1 – Register Your App on Azure

You need a free Azure App Registration to allow users to sign in with Microsoft.

1. Go to https://portal.azure.com and sign in with your Microsoft account.
2. Search for **"App registrations"** in the top search bar and open it.
3. Click **"New registration"**.
4. Fill in:
   - **Name**: SendDrive (or anything you like)
   - **Supported account types**: "Accounts in any organizational directory and personal Microsoft accounts"
   - **Redirect URI**: Select **Single-page application (SPA)** and enter:
     - For local dev: `http://localhost:5173`
     - For production: your deployed URL, e.g. `https://yourdomain.com`
5. Click **Register**.
6. On the app overview page, copy the **Application (client) ID** — you'll need this next.

### Add API Permissions (optional but recommended)

By default, `Files.ReadWrite` is granted via the login scope. If you see permission errors:

1. In your app registration, go to **API permissions**.
2. Click **Add a permission → Microsoft Graph → Delegated permissions**.
3. Add: `Files.ReadWrite`, `User.Read`.
4. Click **Grant admin consent** if you're an admin.

---

## Step 2 – Configure the App

Open `src/authConfig.js` and paste your **Client ID**:

```js
clientId: "YOUR_CLIENT_ID_HERE",  // ← replace this
```

---

## Step 3 – Install and Run

Make sure you have **Node.js 18+** installed. Then:

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Open http://localhost:5173 in your browser.

---

## Step 4 – Deploy to Production

### Option A – Netlify (easiest, free)

```bash
npm run build
```

Then drag and drop the `dist/` folder into https://app.netlify.com/drop

**Important**: In your Azure App Registration, add your Netlify URL as a redirect URI:
- Go to your app → Authentication → Add URI → paste your Netlify URL

### Option B – Vercel

```bash
npm install -g vercel
vercel
```

### Option C – GitHub Pages

```bash
npm run build
# Deploy the dist/ folder to your GitHub Pages branch
```

---

## How It Works

1. User clicks "Connect OneDrive" → Microsoft login popup appears
2. After login, the app gets an access token (stored in session, never sent to any server)
3. Files are uploaded directly from the browser to OneDrive via Microsoft Graph API
4. Files are stored in a folder called `SendDrive` in the user's OneDrive root
5. A shareable anonymous link is created with the chosen expiry date
6. If password protection is set, the link requires a password to download

---

## Notes

- **Password protection** on share links requires a OneDrive Business or SharePoint account.
  Personal OneDrive accounts may not support this feature via the API.
- Files are uploaded to the **signed-in user's** OneDrive — make sure the account has enough storage.
- The app runs entirely in the browser. No backend server is needed.
- Tokens are stored in `sessionStorage` and cleared when the browser tab is closed.

---

## Folder Structure

```
senddrive/
├── src/
│   ├── main.jsx          # Entry point, MSAL provider setup
│   ├── App.jsx           # Main UI component
│   ├── App.css           # All styles
│   ├── authConfig.js     # Azure app config ← edit this
│   └── oneDriveService.js # Graph API calls (upload, share, etc.)
├── index.html
├── package.json
├── vite.config.js
└── README.md
```
