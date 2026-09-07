#!/usr/bin/env bash
# Actualiza el agente en una Pi ya instalada.  sudo bash /opt/print-agent/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/print-agent
APP_USER=printagent
cd "$APP_DIR"
sudo -u "$APP_USER" git pull --ff-only
sudo -u "$APP_USER" npm ci --no-audit --no-fund
sudo -u "$APP_USER" npm run build
sudo -u "$APP_USER" npm prune --omit=dev --no-audit --no-fund
install -m 644 deploy/print-agent.service /etc/systemd/system/print-agent.service
systemctl daemon-reload
systemctl restart print-agent
sleep 2
journalctl -u print-agent -n 20 --no-pager
