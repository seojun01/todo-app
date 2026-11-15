#!/bin/sh
# 한 호스트의 Caddy 를 여러 앱(todo-app, fitness-app)이 함께 쓸 때, 서로의 설정을 지우지 않고 이 앱의 사이트만 설치한다.
# todo-app 과 fitness-app 의 deploy/ 에 같은 내용으로 들어 있다. 고치면 두 곳 모두 고친다.
#
#   사용: caddy-site.sh <이 앱의 deploy/Caddyfile>
#
# 구조:  /etc/caddy/Caddyfile        ← 전역 설정 + "import /etc/caddy/sites/*.caddy" 한 줄 (앱이 덮어쓰지 않는다)
#        /etc/caddy/sites/<호스트>.caddy ← 앱마다 사이트 블록 하나 (그 앱의 설치가 이 파일만 바꾼다)
#
# 예전 방식(사이트 블록이 Caddyfile 안에 직접 있음)이면 처음 한 번, 블록마다 sites/<호스트>.caddy 로 옮긴다.
# 그래서 어느 앱을 먼저 다시 설치해도 다른 앱의 사이트가 사라지지 않는다.
# 바꾸기 전에 Caddyfile 을 백업하고, 검증에 실패하면 되돌린다 (돌고 있는 Caddy 는 이전 설정을 그대로 쓴다).
set -eu

SRC_FILE="$1"
CADDY_DIR="${CADDY_DIR:-/etc/caddy}"
SITES="$CADDY_DIR/sites"
MAIN="$CADDY_DIR/Caddyfile"
IMPORT="import $SITES/*.caddy"

# 이 앱의 사이트 주소 = 주석이 아닌 첫 "<호스트> {" 줄의 첫 단어
HOST=$(awk '/^[^#[:space:]({][^[:space:]]* *\{[[:space:]]*$/ { print $1; exit }' "$SRC_FILE")
[ -n "$HOST" ] || { echo "  $SRC_FILE 에서 사이트 블록을 찾지 못했어요" >&2; exit 1; }

mkdir -p "$SITES"
BACKUP=""
if [ -f "$MAIN" ]; then
  BACKUP="$MAIN.bak-$(date +%Y%m%d%H%M%S)"
  cp "$MAIN" "$BACKUP"
fi

if [ ! -f "$MAIN" ]; then
  printf '# 앱별 사이트는 %s/ 에 있다 (각 앱의 deploy/install.sh 가 자기 파일만 설치한다)\n%s\n' "$SITES" "$IMPORT" > "$MAIN"
elif ! grep -qxF "$IMPORT" "$MAIN"; then
  # 예전 방식 → 사이트 블록을 파일로 옮기고 나머지(전역 설정·주석)는 남긴다. 이미 파일이 있으면 그 파일이 이긴다.
  awk -v dir="$SITES" '
    !blk && /^[^#[:space:]({][^[:space:]]* *\{[[:space:]]*$/ { blk = 1; f = dir "/" $1 ".caddy"; buf = $0 "\n"; next }
    blk {
      buf = buf $0 "\n"
      if ($0 ~ /^\}[[:space:]]*$/) {
        blk = 0
        if ((getline tmp < f) < 0) { printf "%s", buf > f } else { print "  이미 있어서 옮기지 않음: " f > "/dev/stderr" }
        close(f)
      }
      next
    }
    { print }
  ' "$BACKUP" > "$MAIN.new"
  printf '\n# 앱별 사이트는 %s/ 에 있다 (각 앱의 deploy/install.sh 가 자기 파일만 설치한다)\n%s\n' "$SITES" "$IMPORT" >> "$MAIN.new"
  mv "$MAIN.new" "$MAIN"
  echo "  Caddyfile 을 앱별 사이트 파일($SITES/*.caddy) 방식으로 바꿨어요 (백업: $BACKUP)"
fi

# 이 앱의 사이트 블록만 설치한다 (파일 머리의 주석은 빼고 블록부터)
SITE_OLD=""
if [ -f "$SITES/$HOST.caddy" ]; then SITE_OLD="$SITES/$HOST.caddy.prev"; cp "$SITES/$HOST.caddy" "$SITE_OLD"; fi
awk -v host="$HOST" 'index($0, host " ") == 1 { on = 1 } on' "$SRC_FILE" > "$SITES/$HOST.caddy"
chmod 0644 "$MAIN" "$SITES/$HOST.caddy"
echo "  사이트 설치: $SITES/$HOST.caddy"

if command -v caddy >/dev/null && ! caddy validate --config "$MAIN" --adapter caddyfile >/dev/null 2>&1; then
  echo "  Caddy 설정 검증 실패 → 되돌립니다. 원인: caddy validate --config $MAIN --adapter caddyfile" >&2
  [ -n "$BACKUP" ] && cp "$BACKUP" "$MAIN"
  if [ -n "$SITE_OLD" ]; then mv "$SITE_OLD" "$SITES/$HOST.caddy"; else rm -f "$SITES/$HOST.caddy"; fi
  exit 1
fi
rm -f "$SITE_OLD"
