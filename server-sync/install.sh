#!/usr/bin/env bash
# Installation automatique de Reishin Sync sur le VPS (Linux).
# Usage : curl -fsSL https://raw.githubusercontent.com/kizaraKata/reishin-launcher/main/server-sync/install.sh | bash
set -e
REPO="https://raw.githubusercontent.com/kizaraKata/reishin-launcher/main/server-sync"
PORT=7780
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "== Reishin Sync : installation =="

# 1) Node.js
if ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]; then
  echo "-> Installation de Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash - >/dev/null
  $SUDO apt-get install -y nodejs >/dev/null
fi
echo "-> Node.js $(node -v)"

# 2) Trouver le dossier du serveur nanos world (celui qui contient Config.toml + Packages)
SERVER_DIR="${1:-}"
if [ -z "$SERVER_DIR" ]; then
  for f in $($SUDO find / -xdev -name Config.toml -not -path "*/proc/*" 2>/dev/null); do
    d=$(dirname "$f")
    if grep -q "\[discover\]" "$f" 2>/dev/null && [ -d "$d/Packages" ]; then SERVER_DIR="$d"; break; fi
  done
fi
if [ -z "$SERVER_DIR" ]; then echo "!! Serveur nanos world introuvable. Relance avec le chemin : bash install.sh /chemin/du/serveur"; exit 1; fi
echo "-> Serveur nanos world trouvé : $SERVER_DIR"

# 3) Script
$SUDO mkdir -p /opt/reishin-sync
$SUDO curl -fsSL "$REPO/reishin-sync.js" -o /opt/reishin-sync/reishin-sync.js

# 4) Service (démarre tout seul, redémarre en cas de souci)
$SUDO tee /etc/systemd/system/reishin-sync.service >/dev/null <<EOF
[Unit]
Description=Reishin Sync
After=network.target
[Service]
ExecStart=$(command -v node) /opt/reishin-sync/reishin-sync.js "$SERVER_DIR" $PORT
Restart=always
[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now reishin-sync >/dev/null 2>&1
$SUDO systemctl restart reishin-sync

# 5) Pare-feu local (si ufw est actif)
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then $SUDO ufw allow $PORT/tcp >/dev/null; echo "-> Port $PORT ouvert dans ufw"; fi

sleep 3
echo
if curl -fsS "http://127.0.0.1:$PORT/" ; then
  echo; echo "== OK ! Reishin Sync tourne sur le port $PORT =="
  echo "Test depuis ton PC : http://$(curl -fsS ifconfig.me 2>/dev/null || echo IP-DU-VPS):$PORT"
else
  echo "!! Le service ne répond pas. Journal :"; $SUDO journalctl -u reishin-sync -n 20 --no-pager
fi
