#!/usr/bin/env bash
# Deja una Raspberry Pi recién flasheada (Raspberry Pi OS Lite 64-bit) con el
# agente instalado como servicio. Idempotente: se puede volver a ejecutar
# (actualiza el codigo, conserva el .env).
#
#   sudo bash install.sh [URL-del-repo]
#
set -euo pipefail

REPO_URL="${1:-https://github.com/Dimo-nova/print-agent.git}"
APP_DIR=/opt/print-agent
APP_USER=printagent
NODE_MAJOR=22

if [ "$(id -u)" -ne 0 ]; then echo "ejecutar con sudo" >&2; exit 1; fi

echo "== paquetes base"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg

echo "== Node ${NODE_MAJOR}"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".").map(Number)[0]*1000+process.versions.node.split(".").map(Number)[1]')" -lt "$((NODE_MAJOR * 1000 + 13))" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "== Tailscale (sin login: haz 'sudo tailscale up' después)"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "== usuario de servicio"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

echo "== código en ${APP_DIR}"
if [ -d "$APP_DIR/.git" ]; then
  # Ya instalado: el repo pertenece a printagent desde el primer run, y git
  # rechaza operar como root sobre un repo ajeno (dubious ownership). Se tira
  # del repo como su dueño, igual que hace update.sh.
  sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build
sudo -u "$APP_USER" npm prune --omit=dev --no-audit --no-fund
sudo -u "$APP_USER" mkdir -p data

echo "== .env"
if [ ! -f .env ]; then
  read -rp "SUPABASE_URL: " SUPABASE_URL
  read -rp "SUPABASE_PUBLISHABLE_KEY: " SUPABASE_PUBLISHABLE_KEY
  read -rp "AGENT_EMAIL: " AGENT_EMAIL
  read -rsp "AGENT_PASSWORD (no se muestra): " AGENT_PASSWORD; echo
  umask 077
  cat > .env <<EOF
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_PUBLISHABLE_KEY=${SUPABASE_PUBLISHABLE_KEY}
AGENT_EMAIL=${AGENT_EMAIL}
AGENT_PASSWORD=${AGENT_PASSWORD}
EOF
  umask 022
fi
chmod 600 .env
chown "$APP_USER:$APP_USER" .env

echo "== systemd"
install -m 644 deploy/print-agent.service /etc/systemd/system/print-agent.service
systemctl daemon-reload
systemctl enable --now print-agent
sleep 3
systemctl --no-pager --lines=0 status print-agent || true

echo
echo "Listo. Log en vivo:  journalctl -u print-agent -f"
echo "Acceso remoto:       sudo tailscale up"
