#!/bin/bash
# =============================================================================
# SendDrive — Update / redeploy script
# Run on the E2E server to pull latest changes and restart:
#   cd /var/www/senddrive && bash scripts/deploy.sh
# =============================================================================
set -e

APP_DIR="/var/www/senddrive"
echo "======================================================"
echo "  SendDrive — Deploying update"
echo "======================================================"

cd "$APP_DIR"

# ── Rebuild frontend ──────────────────────────────────────────────────────────
echo "[1/3] Rebuilding frontend..."
cd "$APP_DIR/senddrive"
npm install
npm run build
echo "  ✓ Frontend built"

# ── Install/update server deps ────────────────────────────────────────────────
echo "[2/3] Updating server dependencies..."
cd "$APP_DIR/server"
npm install --omit=dev
echo "  ✓ Server deps updated"

# ── Restart app ───────────────────────────────────────────────────────────────
echo "[3/3] Restarting app..."
cd "$APP_DIR"
pm2 restart senddrive
pm2 save

echo ""
echo "  ✓ Deployment complete!"
echo "  Run 'pm2 logs senddrive' to check for errors."
echo "======================================================"
