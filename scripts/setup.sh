#!/bin/bash
# =============================================================================
# SendDrive — First-time server setup script for E2E Networks (Ubuntu 22.04)
# Run as root: bash setup.sh
# =============================================================================
set -e

APP_DIR="/var/www/senddrive"
LOG_DIR="/var/log/senddrive"
DOMAIN="senddrive.bcim.in"
NODE_VERSION="20"

echo "======================================================"
echo "  SendDrive — E2E Networks Production Setup"
echo "======================================================"

# ── 1. System update ──────────────────────────────────────────────────────────
echo "[1/9] Updating system packages..."
apt-get update -y && apt-get upgrade -y

# ── 2. Install Node.js ────────────────────────────────────────────────────────
echo "[2/9] Installing Node.js $NODE_VERSION..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs

echo "Node version: $(node -v)"
echo "NPM version:  $(npm -v)"

# ── 3. Install PM2 globally ───────────────────────────────────────────────────
echo "[3/9] Installing PM2..."
npm install -g pm2

# ── 4. Install Nginx ──────────────────────────────────────────────────────────
echo "[4/9] Installing Nginx..."
apt-get install -y nginx

# ── 5. Create app directory & log directory ───────────────────────────────────
echo "[5/9] Creating directories..."
mkdir -p "$APP_DIR"
mkdir -p "$LOG_DIR"

# ── 6. Upload/copy project files ──────────────────────────────────────────────
echo "[6/9] Copying project files..."
# From this script's parent directory (the project root on Windows)
# If transferring via SCP/SFTP, files will already be in $APP_DIR
# This step runs after you've uploaded the project files.
echo "  → Make sure project files are already uploaded to $APP_DIR"
echo "  → Then press ENTER to continue..."
read -r

# ── 7. Install dependencies & build frontend ──────────────────────────────────
echo "[7/9] Installing dependencies and building frontend..."
cd "$APP_DIR"

# Install root-level deps (concurrently)
npm install --omit=dev

# Install server deps
cd "$APP_DIR/server"
npm install --omit=dev

# Install frontend deps and build
cd "$APP_DIR/senddrive"
npm install
npm run build
echo "  ✓ Frontend built → senddrive/dist/"

# ── 8. Environment file ───────────────────────────────────────────────────────
echo "[8/9] Setting up environment..."
if [ ! -f "$APP_DIR/server/.env" ]; then
  cp "$APP_DIR/server/.env.example" "$APP_DIR/server/.env"
  echo ""
  echo "  ⚠  IMPORTANT: Edit $APP_DIR/server/.env with your real values:"
  echo "     nano $APP_DIR/server/.env"
  echo ""
  echo "  Required values:"
  echo "    AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID"
  echo "    ONEDRIVE_USER_UPN"
  echo "    BASE_URL=http://$DOMAIN"
  echo "    ALLOWED_ORIGINS=http://$DOMAIN"
  echo "    ADMIN_PASSWORD=<choose a strong password>"
  echo ""
  echo "  Press ENTER after editing .env to continue..."
  read -r
else
  echo "  ✓ .env already exists, skipping."
fi

# ── 9. Configure Nginx ────────────────────────────────────────────────────────
echo "[9/9] Configuring Nginx..."
cp "$APP_DIR/nginx/senddrive.conf" /etc/nginx/sites-available/senddrive
ln -sf /etc/nginx/sites-available/senddrive /etc/nginx/sites-enabled/senddrive
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx
echo "  ✓ Nginx configured"

# ── Start app with PM2 ────────────────────────────────────────────────────────
echo ""
echo "Starting app with PM2..."
cd "$APP_DIR"
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash

echo ""
echo "======================================================"
echo "  SendDrive is now running!"
echo "  URL: http://$DOMAIN"
echo ""
echo "  Useful commands:"
echo "    pm2 status          — check running processes"
echo "    pm2 logs senddrive  — view live logs"
echo "    pm2 restart senddrive"
echo ""
echo "  To enable HTTPS (SSL):"
echo "    apt install certbot python3-certbot-nginx -y"
echo "    certbot --nginx -d $DOMAIN"
echo "======================================================"
