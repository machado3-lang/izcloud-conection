#!/usr/bin/env bash
# vps-relay.sh — configura o VPS como relay L4 do REP-C.
#
# Uso (como root, no VPS Ubuntu/Debian):
#   bash vps-relay.sh
#   bash vps-relay.sh zephyr.proxy.rlwy.net 48331
#
# O que faz:
#   1. instala socat
#   2. cria o servico systemd izcloud-relay
#   3. escuta TCP 443 e encaminha para o TCP Proxy da Railway
#   4. libera 443 no ufw (se existir)
#
# O REP-C aponta para o IP publico deste VPS na porta 443 (fixa no firmware).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Rode como root (sudo bash vps-relay.sh)." >&2
  exit 1
fi

HOST="${1:-zephyr.proxy.rlwy.net}"
PORT="${2:-48331}"

echo "[1/4] Instalando socat..."
apt-get update -y
apt-get install -y socat ca-certificates

echo "[2/4] Criando /etc/systemd/system/izcloud-relay.service..."
cat >/etc/systemd/system/izcloud-relay.service <<EOF
[Unit]
Description=iZCloud L4 relay 443 -> Railway TCP proxy (${HOST}:${PORT})
After=network.target

[Service]
ExecStart=/usr/bin/socat -d -d TCP-LISTEN:443,fork,reuseaddr TCP:${HOST}:${PORT}
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

echo "[3/4] Ativando servico..."
systemctl daemon-reload
systemctl enable --now izcloud-relay

echo "[4/4] Liberando 443 no firewall (se ufw existir)..."
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp || true
  ufw allow 443/tcp || true
  ufw --force enable || true
  ufw status || true
else
  echo "ufw nao encontrado; libere TCP 443 no firewall do provedor."
fi

echo
echo "Relay ativo: 0.0.0.0:443 -> ${HOST}:${PORT}"
echo "Status:"
systemctl status --no-pager izcloud-relay || true
echo
echo "Logs: journalctl -u izcloud-relay -f"
echo "Teste externo: Test-NetConnection IP_DO_VPS -Port 443"
echo "Teste TLS:     openssl s_client -connect IP_DO_VPS:443"
echo
echo "No REP-C (REPCONFIG.exe): iDCloud = IP_DO_VPS, enable=true, porta fixa 443."
echo "No iZCloud: cadastre o REP com ModoConexao=rep_empurra."
