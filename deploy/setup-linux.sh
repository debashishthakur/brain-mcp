#!/usr/bin/env bash
# One-shot setup on an always-on Linux box. Run as the user who owns the vault, from anywhere.
# Idempotent: safe to re-run after `git pull` to rebuild and restart.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/brain-mcp}"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "Node 22+ is required. On Debian/Ubuntu:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi
if [ ! -f "$APP_DIR/package.json" ]; then
  echo "Expected brain-mcp at $APP_DIR (set APP_DIR to override). Clone it first:"
  echo "  git clone https://github.com/debashishthakur/brain-mcp.git $APP_DIR"
  exit 1
fi

cd "$APP_DIR"

# Read the vault location, capture folder and public hostname from brain.config.json.
# vaultPath is resolved relative to the config file, the same way the server resolves it.
{ IFS= read -r VAULT_DIR; IFS= read -r CAPTURE_DIR; IFS= read -r PUBLIC_HOST; } < <(node -e '
  const fs = require("fs"), path = require("path");
  const c = JSON.parse(fs.readFileSync("brain.config.json", "utf8"));
  const host = c.auth && c.auth.publicUrl ? new URL(c.auth.publicUrl).host : "brain.example.com";
  console.log([path.resolve(c.vaultPath), c.captureDir || "Captures", host].join("\n"));
')
if [ -z "${VAULT_DIR:-}" ] || [ ! -d "$VAULT_DIR" ]; then
  echo "The vault in brain.config.json does not exist: $VAULT_DIR"
  exit 1
fi

echo "== installing dependencies and building"
npm ci --no-audit --no-fund
npm run build --silent
npm prune --omit=dev --no-audit --no-fund
mkdir -p data logs "$VAULT_DIR/$CAPTURE_DIR"

echo "== installing systemd unit (vault: $VAULT_DIR)"
sed -e "s|__USER__|$USER|g" -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__VAULT_DIR__|$VAULT_DIR|g" deploy/brain-mcp.service | sudo tee /etc/systemd/system/brain-mcp.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable brain-mcp >/dev/null

if ! node dist/index.js auth status | grep -q "login configured: true"; then
  echo
  echo "== login is not configured yet. Run this next, then scan the QR code with your authenticator app:"
  echo "   cd $APP_DIR && node dist/index.js auth init"
  echo "   sudo systemctl start brain-mcp"
else
  sudo systemctl restart brain-mcp
  sleep 2
  systemctl --no-pager --lines=5 status brain-mcp || true
  curl -fsS http://127.0.0.1:3737/healthz && echo
fi

cat <<EOF

== Cloudflare Tunnel (once). Hostname from auth.publicUrl: $PUBLIC_HOST
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt-get update && sudo apt-get install -y cloudflared
  cloudflared tunnel login                       # opens a browser; pick the domain $PUBLIC_HOST belongs to
  cloudflared tunnel create brain                # prints the tunnel id
  cloudflared tunnel route dns brain $PUBLIC_HOST
  sed -e "s|__TUNNEL_ID__|<id>|g" -e "s|__HOME__|$HOME|g" -e "s|brain.example.com|$PUBLIC_HOST|g" $APP_DIR/deploy/cloudflared-config.yml | sudo tee /etc/cloudflared/config.yml
  sudo cloudflared service install
  curl -fsS https://$PUBLIC_HOST/healthz         # should answer from the box
EOF
