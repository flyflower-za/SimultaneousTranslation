#!/usr/bin/env bash
#
# 同声传译系统 · Linux 生产部署脚本（systemd 托管）
#
# 用法：
#   1. 把整个项目目录拷到目标 Linux 服务器（scp/rsync/git clone 均可）
#   2. 在项目目录里执行：
#        sudo bash deploy/deploy-linux.sh
#   可用环境变量覆盖默认值：
#        DEPLOY_DIR=/opt/simtrans   部署目录
#        SERVICE_USER=simtrans      运行服务的系统账号
#        PORT=15677                 服务端口
#   升级（重新部署）同样执行本脚本：保留 data/（审批与用量数据库）与 ssl/ 证书，
#   重建虚拟环境并安装最新依赖，重启服务。
#
# 脚本做这些事：
#   - 安装系统依赖（python3.10+、venv、sqlite3、rsync）
#   - 创建专用低权限系统账号（非 root 运行）
#   - 同步代码到 DEPLOY_DIR（排除运行时数据），创建 .venv 并安装依赖
#   - 无证书时生成自签名证书（建议尽快替换为公司内部 CA 证书）
#   - 安装并启用 systemd 服务（崩溃自动重启、开机自启、日志进 journald）
#   - 安装每日 03:00 的 SQLite 备份 cron（保留 30 天）
#   - 启动并做健康检查
#
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/simtrans}"
SERVICE_USER="${SERVICE_USER:-simtrans}"
PORT="${PORT:-15677}"
SERVICE_NAME="simtrans"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

info()  { echo -e "\033[36m[deploy]\033[0m $*"; }
warn()  { echo -e "\033[33m[deploy]\033[0m $*" >&2; }
die()   { echo -e "\033[31m[deploy] 错误: $*\033[0m" >&2; exit 1; }

# ---------- 前置检查 ----------
[[ $EUID -eq 0 ]] || die "请用 root/sudo 运行（systemd 单元与 cron 需要写 /etc）"
[[ "$(uname -s)" == "Linux" ]] || die "本脚本仅支持 Linux（macOS 请用 launchd，Windows 请用 start.ps1 + 任务计划）"
[[ -f "$SRC_DIR/start_server.py" ]] || die "未找到项目文件，请在项目目录内运行本脚本"

# ---------- 系统依赖 ----------
install_pkgs() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq python3 python3-venv python3-pip sqlite3 rsync >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q python3 python3-pip sqlite rsync >/dev/null
  else
    warn "未识别的包管理器（无 apt/dnf），跳过系统依赖安装，请自行确保 python3/venv/sqlite3/rsync 可用"
  fi
}
command -v python3 >/dev/null 2>&1 || install_pkgs
command -v sqlite3 >/dev/null 2>&1 || install_pkgs || true
command -v rsync >/dev/null 2>&1 || die "缺少 rsync，请先安装"

# ---------- 选择 Python >= 3.10 ----------
pick_python() {
  local candidate
  for candidate in python3.13 python3.12 python3.11 python3.10 python3; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    local ver
    ver="$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
    if [[ "$(echo "$ver" | awk -F. '{print ($1>3 || ($1==3 && $2>=10)) ? "ok" : "no"}')" == "ok" ]]; then
      echo "$candidate"; return 0
    fi
  done
  return 1
}
PY_BIN="$(pick_python)" || die "未找到 Python >= 3.10（项目要求 3.10+）。
  Ubuntu 20.04 等老系统请启用 deadsnakes PPA 安装 python3.10+，或升级系统后重试。"
info "使用 Python: $PY_BIN ($("$PY_BIN" --version))"

# ---------- 专用系统账号 ----------
if id "$SERVICE_USER" >/dev/null 2>&1; then
  info "系统账号 $SERVICE_USER 已存在，跳过创建"
else
  useradd --system --home-dir "$DEPLOY_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  info "已创建系统账号: $SERVICE_USER（无登录 shell）"
fi

# ---------- 同步代码（保留运行时数据与证书） ----------
mkdir -p "$DEPLOY_DIR"
rsync -a --delete \
  --exclude 'data/' --exclude 'ssl/' --exclude '.venv/' \
  --exclude '.git/' --exclude '__pycache__/' --exclude '.DS_Store' \
  "$SRC_DIR"/ "$DEPLOY_DIR"/
info "代码已同步到 $DEPLOY_DIR（data/ 与 ssl/ 不被覆盖）"

# ---------- 虚拟环境与依赖 ----------
info "创建虚拟环境并安装依赖（每次部署重建，确保依赖与代码同步）..."
rm -rf "$DEPLOY_DIR/.venv"
"$PY_BIN" -m venv "$DEPLOY_DIR/.venv"
"$DEPLOY_DIR/.venv/bin/python" -m pip install --upgrade pip -q
"$DEPLOY_DIR/.venv/bin/python" -m pip install -r "$DEPLOY_DIR/requirements.txt" -q

# ---------- SSL 证书 ----------
mkdir -p "$DEPLOY_DIR/ssl"
if [[ -f "$DEPLOY_DIR/ssl/cert.pem" && -f "$DEPLOY_DIR/ssl/key.pem" ]]; then
  info "SSL 证书已存在，保留（替换证书后 systemctl restart $SERVICE_NAME 生效）"
else
  LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$LAN_IP" ]] || LAN_IP="127.0.0.1"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$DEPLOY_DIR/ssl/key.pem" -out "$DEPLOY_DIR/ssl/cert.pem" \
    -subj "/CN=$LAN_IP" \
    -addext "subjectAltName=IP:$LAN_IP,DNS:localhost" >/dev/null 2>&1
  warn "已生成自签名证书（CN=$LAN_IP）。浏览器会弹安全警告，正式上线建议替换为公司内部 CA 签发的证书"
fi

# ---------- 配置文件检查 ----------
CONFIG_OK=0
if [[ -f "$DEPLOY_DIR/config/config.json" ]]; then
  CONFIG_OK=1
else
  if [[ -f "$DEPLOY_DIR/config/config.example.json" ]]; then
    cp "$DEPLOY_DIR/config/config.example.json" "$DEPLOY_DIR/config/config.json"
  fi
  warn "config/config.json 不存在！已从模板创建，请填写后再启动服务"
fi

# ---------- 目录属主 ----------
mkdir -p "$DEPLOY_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DEPLOY_DIR"

# ---------- systemd 服务 ----------
info "安装 systemd 服务..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Simultaneous Translation Server (同声传译系统)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$DEPLOY_DIR
ExecStart=$DEPLOY_DIR/.venv/bin/python ./start_server.py --port $PORT --https
Restart=always
RestartSec=3
# 日志交给 journald（自动轮转）：journalctl -u $SERVICE_NAME -f
StandardOutput=journal
StandardError=journal
# 基础加固
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DEPLOY_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
info "服务已安装并设为开机自启"

# ---------- 每日备份 cron ----------
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DEPLOY_DIR/data/backup"
chmod 755 "$DEPLOY_DIR/deploy/backup-db.sh"
cat > "/etc/cron.d/${SERVICE_NAME}-backup" <<EOF
# 同声传译系统：每日 03:00 备份 SQLite（保留 30 天）
0 3 * * * $SERVICE_USER "$DEPLOY_DIR/deploy/backup-db.sh" "$DEPLOY_DIR/data/access.db" "$DEPLOY_DIR/data/backup"
EOF
chmod 644 "/etc/cron.d/${SERVICE_NAME}-backup"
info "每日备份 cron 已安装（03:00，保留 30 天，存于 $DEPLOY_DIR/data/backup）"

# ---------- 启动与健康检查 ----------
if [[ $CONFIG_OK -eq 1 ]]; then
  info "启动服务..."
  systemctl restart "$SERVICE_NAME"
  info "等待健康检查..."
  HEALTH_OK=0
  for _ in $(seq 1 30); do
    if curl -skf "https://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
    sleep 1
  done
  if [[ $HEALTH_OK -eq 1 ]]; then
    info "✓ 服务已启动并通过健康检查"
  else
    warn "健康检查超时（30 秒）。查看日志: journalctl -u $SERVICE_NAME -n 50"
  fi
else
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  warn "已跳过启动。填写 $DEPLOY_DIR/config/config.json 后执行:"
  warn "  systemctl start $SERVICE_NAME"
fi

# ---------- 完成 ----------
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
info "================ 部署完成 ================"
echo "  服务目录:   $DEPLOY_DIR"
echo "  访问入口:   https://${LAN_IP:-<服务器IP>}:$PORT/"
echo "  管理后台:   https://${LAN_IP:-<服务器IP>}:$PORT/admin"
echo "  健康检查:   https://127.0.0.1:$PORT/api/health"
echo
echo "  常用命令:"
echo "    systemctl status  $SERVICE_NAME     # 状态"
echo "    journalctl -u $SERVICE_NAME -f      # 实时日志"
echo "    systemctl restart $SERVICE_NAME     # 重启（升级: 拉新代码后重跑本脚本）"
echo "  备份位置:   $DEPLOY_DIR/data/backup/（每日 03:00）"
echo "=========================================="
