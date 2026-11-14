#!/usr/bin/env bash
# Debian 12 / Ubuntu 24.04 서버(LXC·VM) 안에서 root 로, 저장소 루트에서 실행한다:  sudo deploy/install.sh
# 여러 번 실행해도 안전하다(멱등). 설치: Node 24, Caddy, 앱 파일, systemd 유닛, todo-admin 명령.
set -euo pipefail

APP_DIR=/opt/todo
STATE_DIR=/var/lib/todo
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행해 주세요: sudo deploy/install.sh" >&2; exit 1; }
[ -f "$SRC/package.json" ] || { echo "저장소 루트를 찾을 수 없어요: $SRC" >&2; exit 1; }

echo "==> 기본 패키지"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node.js 24"
if ! command -v node >/dev/null || ! node -v | grep -Eq '^v(2[4-9]|[3-9][0-9])\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "==> Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "==> 앱 빌드 (개발 의존성은 빌드에만 쓰고, 서버에는 런타임 의존성이 없다)"
(cd "$SRC" && npm ci --no-audit --no-fund && npm run build)

echo "==> 사용자와 폴더"
id todo >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin todo
install -d -m 0755 "$APP_DIR" "$APP_DIR/client"
install -d -o todo -g todo -m 0750 "$STATE_DIR"

echo "==> 앱 파일 배포 → $APP_DIR"
rsync -a --delete "$SRC/server/src/" "$APP_DIR/server/src/"
rsync -a --delete "$SRC/shared/" "$APP_DIR/shared/" --exclude tests
rsync -a --delete "$SRC/client/dist/" "$APP_DIR/client/dist/"
install -m 0644 "$SRC/package.json" "$APP_DIR/package.json"   # "type": "module" 때문에 필요하다

echo "==> systemd 서비스"
install -m 0644 "$SRC/deploy/todo.service" /etc/systemd/system/todo.service
systemctl daemon-reload
systemctl enable todo >/dev/null
systemctl restart todo

echo "==> todo-admin 명령"
cat > /usr/local/bin/todo-admin <<'WRAP'
#!/bin/sh
# 서버와 같은 DB·키 파일을 쓰도록 todo 사용자로 실행한다
exec runuser -u todo -- env NODE_NO_WARNINGS=1 TODO_DB=/var/lib/todo/todo.db TODO_VAPID_FILE=/var/lib/todo/vapid.json \
  /usr/bin/node /opt/todo/server/src/admin-cli.ts "$@"
WRAP
chmod 0755 /usr/local/bin/todo-admin

echo "==> Caddy 설정"
install -m 0644 "$SRC/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "==> 확인"
sleep 2
if curl -fsS http://127.0.0.1:8080/api/health >/dev/null; then echo "  서버: 정상 (127.0.0.1:8080)"; else echo "  서버: 응답 없음 → journalctl -u todo -n 50" >&2; fi
if curl -fsSkI --resolve todo.home.arpa:443:127.0.0.1 https://todo.home.arpa/ >/dev/null; then echo "  Caddy(HTTPS): 정상"; else echo "  Caddy(HTTPS): 응답 없음 → journalctl -u caddy -n 50" >&2; fi
# 알림 푸시를 애플 서버로 보낼 수 있어야 한다. 어떤 HTTP 응답이든 오면 연결은 된다.
if curl -sS -o /dev/null --max-time 10 https://web.push.apple.com; then echo "  푸시 아웃바운드(web.push.apple.com:443): 연결됨"; else echo "  푸시 아웃바운드: 연결 안 됨 → 방화벽에서 이 서버의 인터넷 아웃바운드를 확인하세요" >&2; fi

cat <<'DONE'

설치가 끝났어요. 다음 단계:
  1) 기기마다 Caddy 루트 인증서를 설치하세요:  /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
  2) todo-admin pair --name "iPhone"  으로 페어링 코드를 받아 기기에서 등록하세요.
  3) 매일 백업:  todo-admin backup /var/lib/todo/backup-$(date +%F).db   (vapid.json 도 함께 백업)
DONE
