#!/usr/bin/env python3
"""
启动服务器脚本 - 支持 iPad 访问
使用 aiohttp 同时提供 HTTP/HTTPS 服务器（前端文件）和 WebSocket/WSS 服务器

路由结构：
  /            新首页（提交使用申请 / 输入访问码进入）
  /app         控制端页面（需访问码登录态）
  /viewer      查看端页面（需访问码登录态）
  /admin       管理页（管理员密码登录）
  /api/*       申请、验证、管理接口
  /ws          WebSocket（握手时校验访问码 cookie）
"""
import asyncio
import copy
import json
import logging
import os
import sys
import socket
import ssl
import time
import secrets
import aiohttp
from aiohttp import web
from aiohttp.web_runner import AppRunner, TCPSite

# 添加项目路径
project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_root)
# 确保 backend 目录在路径中
backend_dir = os.path.join(project_root, 'backend')
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from backend.server import TranslationServer, load_config, ROOM_REGISTRY
from backend.access_db import AccessDB
from backend.auth import (CookieSigner, get_code_id_from_request, is_admin,
                          make_user_cookie, make_admin_cookie)
from backend.mailer import Mailer
from backend.minutes import MinutesService

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# 数据库路径（测试时可用 AST_DB_PATH 指向独立文件，避免碰生产库）
DB_PATH = os.environ.get('AST_DB_PATH') or os.path.join(project_root, 'data', 'access.db')


def get_local_ip():
    """获取本机局域网 IP 地址"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class AppContext:
    """全局上下文：配置、数据库、签名器、邮件"""

    def __init__(self, config: dict, use_https: bool):
        self.config = config
        self.use_https = use_https

        security = config.get("security", {})
        secret = security.get("secret_key", "")
        if not secret:
            # 未配置则自动生成随机密钥（重启后已发的登录态会失效，建议正式配置固定值）
            secret = secrets.token_hex(32)
            logger.warning("security.secret_key 未配置，已自动生成随机密钥"
                           "（重启后登录态失效，建议在 config.json 中配置固定值）")
        self.signer = CookieSigner(secret)
        self.admin_password = security.get("admin_password", "")
        self.valid_before_start_min = int(security.get("code_valid_before_start_min", 120))
        # 新申请提醒收件人（配置后，有新申请自动发邮件通知管理员）
        self.admin_notify_emails = [e.strip() for e in
                                    security.get("admin_notify_emails", []) if e.strip()]
        self.pricing = config.get("pricing", {})
        self.db = AccessDB(DB_PATH)
        self.minutes = MinutesService(self.db, config)
        self.mailer = Mailer(config.get("smtp", {}))
        # 访问码验证失败限速（防爆破）：ip -> 最近失败时间戳列表
        self._verify_failures = {}

    # ---------- 工具 ----------

    def set_cookie(self, resp, cookie_spec: dict):
        resp.set_cookie(cookie_spec["key"], cookie_spec["value"],
                        max_age=cookie_spec["max_age"], httponly=cookie_spec["httponly"],
                        samesite=cookie_spec["samesite"], secure=self.use_https)
        return resp

    def is_rate_limited(self, ip: str, limit: int = 10, window: int = 60) -> bool:
        now = time.time()
        hits = [t for t in self._verify_failures.get(ip, []) if now - t < window]
        if len(hits) >= limit:
            self._verify_failures[ip] = hits
            return True
        return False

    def record_failure(self, ip: str):
        self._verify_failures.setdefault(ip, []).append(time.time())


def json_error(status: int, message: str) -> web.Response:
    return web.json_response({"ok": False, "error": message}, status=status)


def _qint(value, default, lo=None, hi=None) -> int:
    """安全地把 query string 转 int, 带边界裁剪。"""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


# ---------- 公开接口：申请与访问码验证 ----------

async def api_submit_request(request):
    """提交使用申请"""
    ctx: AppContext = request.app['ctx']
    try:
        body = await request.json()
    except Exception:
        return json_error(400, "请求体格式错误")

    applicant = str(body.get("applicant", "")).strip()
    email = str(body.get("email", "")).strip()
    department = str(body.get("department", "")).strip()
    topic = str(body.get("topic", "")).strip()
    planned_start = str(body.get("planned_start", "")).strip()
    try:
        duration = int(body.get("planned_duration_min", 60))
    except (TypeError, ValueError):
        duration = 0

    if not applicant or not email or not planned_start:
        return json_error(400, "申请人、邮箱、使用时间为必填项")
    if "@" not in email:
        return json_error(400, "邮箱格式不正确")
    if not (15 <= duration <= 12 * 60):
        return json_error(400, "预计时长需在 15 分钟到 12 小时之间")
    try:
        from datetime import datetime
        datetime.fromisoformat(planned_start)
    except ValueError:
        return json_error(400, "使用时间格式不正确")

    if ctx.db.has_pending_request_from(email):
        return json_error(400, "该邮箱已有待审批的申请，请等待管理员处理")

    request_id = ctx.db.create_request(applicant, email, department, topic,
                                       planned_start, duration)
    ctx.db.audit(email, "request_submitted", f"申请 #{request_id}: {applicant} / {topic}")
    logger.info(f"收到使用申请 #{request_id}: {applicant} <{email}> {planned_start} {duration}分钟")

    # 新申请邮件提醒管理员（发送失败不影响用户提交结果）
    if ctx.admin_notify_emails:
        try:
            base_url = f"{'https' if ctx.use_https else 'http'}://{request.host}/admin"
            sent = await ctx.mailer.send_new_request_notify(
                ctx.admin_notify_emails, request_id, applicant, email,
                department, topic, planned_start, duration, base_url)
            if not sent:
                logger.warning("管理员提醒邮件发送失败，请管理员留意后台待审批列表")
        except Exception as e:
            logger.error(f"发送管理员提醒邮件失败: {e}")

    return web.json_response({"ok": True, "request_id": request_id,
                              "message": "申请已提交，审批通过后访问码将发送到你的邮箱"})


async def api_verify_code(request):
    """验证访问码，通过后发放登录态 cookie"""
    ctx: AppContext = request.app['ctx']
    ip = request.remote or "unknown"
    if ctx.is_rate_limited(ip):
        return json_error(429, "尝试次数过多，请稍后再试")

    try:
        body = await request.json()
    except Exception:
        return json_error(400, "请求体格式错误")
    code = str(body.get("code", "")).strip().upper()

    if not code:
        return json_error(400, "请输入访问码")

    code_row = ctx.db.get_code_by_value(code)
    valid, reason = (False, "访问码无效或已过期")
    if code_row:
        valid, reason = ctx.db.check_code_validity(code_row)
    if not valid:
        ctx.record_failure(ip)
        # 统一提示，不区分"不存在/已失效"，避免探测
        return json_error(401, reason if code_row else "访问码无效或已过期")

    target = str(body.get("target", "app"))

    # 查看端目标：解析该访问码当前进行中的房间，直接进入对应场次
    if target == "viewer":
        room_id = ROOM_REGISTRY.find_room_by_code(code_row["code"])
        meeting = ctx.db.get_open_meeting(room_id, code_row["id"]) if room_id else None
        if meeting is None:
            meeting = ctx.db.latest_shared_meeting_for_code(code_row["id"])
        if not meeting:
            return json_error(409, "访问码有效，但当前没有可查看的会议。")
        room_id = meeting["room_id"] if not meeting["ended_at"] else None
        redirect = (f"/viewer?room={room_id}&share={meeting['share_token']}" if room_id
                    else f"/viewer?share={meeting['share_token']}")
        cookie_spec = make_user_cookie(ctx.signer, code_row["id"], secure=ctx.use_https)
        resp = web.json_response({"ok": True, "code_id": code_row["id"],
                                  "applicant": code_row["applicant"],
                                  "room_id": room_id,
                                  "redirect": redirect})
        return ctx.set_cookie(resp, cookie_spec)

    cookie_spec = make_user_cookie(ctx.signer, code_row["id"], secure=ctx.use_https)
    resp = web.json_response({"ok": True, "code_id": code_row["id"],
                              "applicant": code_row["applicant"],
                              "redirect": "/app" if target == "app" else "/viewer"})
    return ctx.set_cookie(resp, cookie_spec)


# ---------- 管理接口 ----------

def require_admin(handler):
    """管理接口装饰器：校验管理员登录态"""
    async def wrapper(request):
        ctx: AppContext = request.app['ctx']
        if not is_admin(ctx.signer, request):
            return json_error(401, "请先登录管理后台")
        return await handler(request)
    return wrapper


async def api_admin_login(request):
    ctx: AppContext = request.app['ctx']
    if not ctx.admin_password:
        return json_error(500, "管理员密码未配置，请在 config.json 的 security.admin_password 中设置")
    try:
        body = await request.json()
    except Exception:
        return json_error(400, "请求体格式错误")
    password = str(body.get("password", ""))
    ip = request.remote or "unknown"
    if ctx.is_rate_limited(ip, limit=5, window=300):
        return json_error(429, "尝试次数过多，请稍后再试")
    if not secrets.compare_digest(password, ctx.admin_password):
        ctx.record_failure(ip)
        ctx.db.audit(ip, "admin_login_failed", "")
        return json_error(401, "密码错误")
    cookie_spec = make_admin_cookie(ctx.signer, secure=ctx.use_https)
    resp = web.json_response({"ok": True})
    ctx.db.audit("admin", "admin_login", f"IP {ip}")
    return ctx.set_cookie(resp, cookie_spec)


async def api_admin_requests(request):
    ctx: AppContext = request.app['ctx']
    status = request.query.get("status") or None
    q = (request.query.get("q") or "").strip() or None
    limit = _qint(request.query.get("limit"), 200, lo=1, hi=1000)
    offset = _qint(request.query.get("offset"), 0, lo=0)
    rows = ctx.db.list_requests(status=status, q=q, limit=limit, offset=offset)
    total = ctx.db.count_requests(status=status, q=q)
    return web.json_response({
        "ok": True, "total": total, "limit": limit, "offset": offset,
        "requests": [dict(r) for r in rows]
    })


async def api_admin_approve(request):
    ctx: AppContext = request.app['ctx']
    try:
        body = await request.json()
        request_id = int(body.get("request_id"))
    except (TypeError, ValueError):
        return json_error(400, "参数错误")

    code_row = ctx.db.approve_request(request_id, "admin",
                                      valid_before_start_min=ctx.valid_before_start_min)
    if not code_row:
        return json_error(400, "申请不存在或已处理")

    ctx.db.audit("admin", "request_approved",
                 f"申请 #{request_id} -> 访问码 {code_row['code']}（{code_row['applicant']}）")

    # 发送邮件（失败不阻塞审批，管理页可重发/复制）
    base_url = f"{'https' if ctx.use_https else 'http'}://{request.host}"
    sent = await ctx.mailer.send_access_code(
        code_row["email"], code_row["applicant"], code_row["code"],
        base_url, code_row["valid_from"], code_row["quota_min"])
    ctx.db.set_code_email_status(code_row["id"], "sent" if sent else "failed")

    return web.json_response({"ok": True, "code": code_row["code"],
                              "email_sent": sent,
                              "message": "已审批通过" + ("，访问码已通过邮件发送" if sent else "。邮件发送失败，请在访问码列表中复制后手动发送")})


async def api_admin_reject(request):
    ctx: AppContext = request.app['ctx']
    try:
        body = await request.json()
        request_id = int(body.get("request_id"))
    except (TypeError, ValueError):
        return json_error(400, "参数错误")
    reason = str(body.get("reason", "")).strip()
    ctx.db.reject_request(request_id, "admin", reason)
    ctx.db.audit("admin", "request_rejected", f"申请 #{request_id}: {reason}")
    return web.json_response({"ok": True})


async def api_admin_codes(request):
    ctx: AppContext = request.app['ctx']
    status = request.query.get("status") or None
    q = (request.query.get("q") or "").strip() or None
    limit = _qint(request.query.get("limit"), 200, lo=1, hi=1000)
    offset = _qint(request.query.get("offset"), 0, lo=0)
    rows = ctx.db.list_codes(status=status, q=q, limit=limit, offset=offset)
    total = ctx.db.count_codes(status=status, q=q)
    return web.json_response({
        "ok": True, "total": total, "limit": limit, "offset": offset,
        "codes": [dict(r) for r in rows]
    })


async def api_admin_revoke(request):
    ctx: AppContext = request.app['ctx']
    try:
        body = await request.json()
        code_id = int(body.get("code_id"))
    except (TypeError, ValueError):
        return json_error(400, "参数错误")
    ctx.db.set_code_status(code_id, "revoked")
    ctx.db.audit("admin", "code_revoked", f"访问码 #{code_id}")
    return web.json_response({"ok": True})


async def api_admin_resend(request):
    ctx: AppContext = request.app['ctx']
    try:
        body = await request.json()
        code_id = int(body.get("code_id"))
    except (TypeError, ValueError):
        return json_error(400, "参数错误")
    code_row = ctx.db.get_code(code_id)
    if not code_row:
        return json_error(404, "访问码不存在")
    base_url = f"{'https' if ctx.use_https else 'http'}://{request.host}"
    sent = await ctx.mailer.send_access_code(
        code_row["email"], code_row["applicant"], code_row["code"],
        base_url, code_row["valid_from"], code_row["quota_min"])
    ctx.db.set_code_email_status(code_id, "sent" if sent else "failed")
    return web.json_response({"ok": sent, "email_sent": sent})


async def api_admin_usage(request):
    ctx: AppContext = request.app['ctx']
    try:
        days = int(request.query.get("days", 30))
    except ValueError:
        days = 30
    days = max(1, min(days, 365))
    pricing = ctx.pricing
    per_k = {k: float(pricing.get(k, 0)) for k in
             ("input_audio_per_ktoken", "output_audio_per_ktoken", "output_text_per_ktoken")}
    currency = pricing.get("currency", "CNY")

    def with_cost(row):
        d = dict(row)
        cost = (d.get("input_audio_tokens", 0) / 1000 * per_k["input_audio_per_ktoken"]
                + d.get("output_audio_tokens", 0) / 1000 * per_k["output_audio_per_ktoken"]
                + d.get("output_text_tokens", 0) / 1000 * per_k["output_text_per_ktoken"])
        d["cost"] = round(cost, 2)
        return d

    by_code_limit = _qint(request.query.get("code_limit"), 200, lo=1, hi=1000)
    by_code_offset = _qint(request.query.get("code_offset"), 0, lo=0)
    by_code_total = ctx.db.count_usage_codes(days)
    by_day_limit = _qint(request.query.get("day_limit"), 10, lo=1, hi=365)
    by_day_offset = _qint(request.query.get("day_offset"), 0, lo=0)
    return web.json_response({
        "ok": True,
        "days": days,
        "currency": currency,
        "pricing": per_k,
        "by_code": {
            "total": by_code_total,
            "limit": by_code_limit,
            "offset": by_code_offset,
            "rows": [with_cost(r) for r in ctx.db.usage_summary(
                days, limit=by_code_limit, offset=by_code_offset)]
        },
        "by_day": {
            "total": ctx.db.count_daily_usage(days),
            "limit": by_day_limit,
            "offset": by_day_offset,
            "rows": [with_cost(r) for r in ctx.db.daily_usage(
                days, limit=by_day_limit, offset=by_day_offset)]
        },
    })


async def api_admin_audit(request):
    """审计日志（分页）"""
    ctx: AppContext = request.app['ctx']
    limit = _qint(request.query.get("limit"), 20, lo=1, hi=200)
    offset = _qint(request.query.get("offset"), 0, lo=0)
    rows = ctx.db.list_audit(limit=limit, offset=offset)
    return web.json_response({
        "ok": True, "total": ctx.db.count_audit(), "limit": limit, "offset": offset,
        "logs": [dict(r) for r in rows],
    })


async def api_health(request):
    """健康检查（公开）：进程存活与房间概况"""
    rooms = ROOM_REGISTRY.snapshot()
    return web.json_response({
        "ok": True,
        "rooms": len(rooms),
        "active_rooms": sum(1 for r in rooms if r["has_controller"]),
        "viewers": sum(r["viewer_count"] for r in rooms),
    })


async def api_me(request):
    """当前登录态对应的访问码信息（控制端展示使用人/主题用）"""
    ctx: AppContext = request.app['ctx']
    code_id = get_code_id_from_request(ctx.signer, request)
    if code_id is None:
        return json_error(401, "未登录")
    code_row = ctx.db.get_code(code_id)
    if not code_row:
        return json_error(401, "登录态无效")
    return web.json_response({
        "ok": True,
        "applicant": code_row["applicant"],
        "department": code_row["department"] or "",
        "topic": code_row["topic"] or "",
        "code": code_row["code"],
    })


async def api_admin_rooms(request):
    """活跃房间列表（管理端）"""
    return web.json_response({"ok": True, "rooms": ROOM_REGISTRY.snapshot()})


def meeting_public(row: dict) -> dict:
    return {key: row[key] for key in ("id", "room_id", "title", "source_language",
            "target_language", "started_at", "ended_at", "status", "published_at")}


async def api_shared_minutes(request):
    ctx: AppContext = request.app['ctx']
    token = request.match_info['token']
    if len(token) < 32 or len(token) > 128:
        return json_error(404, "分享链接无效")
    row = ctx.db.get_shared_meeting(token)
    if not row:
        return json_error(404, "分享链接无效或已撤销")
    result = meeting_public(row)
    if row["ended_at"] and row["published_at"]:
        result["minutes_text"] = row["minutes_text"]
    resp = web.json_response({"ok": True, "meeting": result})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@require_admin
async def api_admin_meetings(request):
    ctx: AppContext = request.app['ctx']
    rows = ctx.db.list_meetings(limit=200)
    return web.json_response({"ok": True, "meetings": [
        {**meeting_public(row), "applicant": row["applicant"],
         "share_revoked": bool(row["share_revoked_at"])} for row in rows]})


@require_admin
async def api_admin_meeting(request):
    ctx: AppContext = request.app['ctx']
    meeting_id = int(request.match_info['id'])
    row = ctx.db.get_meeting(meeting_id)
    if not row:
        return json_error(404, "会议不存在")
    return web.json_response({"ok": True, "meeting": row,
                              "segments": ctx.db.meeting_segments(meeting_id)})


@require_admin
async def api_admin_meeting_action(request):
    ctx: AppContext = request.app['ctx']
    meeting_id = int(request.match_info['id'])
    row = ctx.db.get_meeting(meeting_id)
    if not row:
        return json_error(404, "会议不存在")
    try:
        body = await request.json()
    except Exception:
        return json_error(400, "请求体格式错误")
    action = body.get("action")
    if action == "generate":
        if not row["ended_at"]:
            return json_error(409, "会议尚未结束")
        if row["published_at"]:
            return json_error(409, "请先撤回发布再重新生成")
        if not ctx.minutes.schedule(meeting_id):
            return json_error(409, "纪要模型未配置或任务正在运行")
    elif action == "save":
        content = body.get("minutes_text")
        if not row["ended_at"] or not isinstance(content, str) or not content.strip() or len(content) > 200000:
            return json_error(400, "纪要内容无效")
        if row["status"] == "generating":
            return json_error(409, "纪要正在生成，请稍后编辑")
        if row["published_at"]:
            return json_error(409, "请先撤回发布再编辑")
        ctx.db.save_minutes(meeting_id, content.strip())
    elif action == "publish":
        if not row["ended_at"] or not row["minutes_text"] or row["status"] == "generating":
            return json_error(409, "纪要尚未就绪")
        ctx.db.publish_minutes(meeting_id, True)
    elif action == "unpublish":
        ctx.db.publish_minutes(meeting_id, False)
    elif action == "revoke_share":
        ctx.db.revoke_meeting_share(meeting_id)
    elif action == "delete":
        if not row["ended_at"] or row["status"] == "generating":
            return json_error(409, "会议仍在进行或纪要正在生成")
        ctx.db.delete_meeting(meeting_id)
    else:
        return json_error(400, "未知操作")
    ctx.db.audit("admin", f"meeting_{action}", f"会议 #{meeting_id}")
    return web.json_response({"ok": True, "meeting": ctx.db.get_meeting(meeting_id)})


# ---------- WebSocket ----------

async def websocket_handler(request):
    """WebSocket 处理器：控制端校验访问码登录态；查看端凭房间链接即可加入（扫码即进）"""
    ctx: AppContext = request.app['ctx']

    ws = web.WebSocketResponse()
    await ws.prepare(request)

    # 先解析角色与房间（查看端凭有效房间可免登录态）
    query_params = request.query
    client_role = query_params.get("role", "controller")  # 默认为控制端
    if client_role not in ["controller", "viewer"]:
        client_role = "controller"
    room_id = (query_params.get("room") or "").strip().upper() or None

    if client_role == "viewer" and room_id and ROOM_REGISTRY.get(room_id) is not None:
        # 扫码/链接直达的查看端：房间号即凭证（6 位随机、不可猜测、空闲即回收），跳过 cookie 鉴权
        code_id = None
        auth_error = None
        code_row = None
    else:
        # 鉴权：cookie 中解析访问码登录态
        code_id = get_code_id_from_request(ctx.signer, request)
        auth_error = None
        code_row = None
        if code_id is None:
            auth_error = "未登录，请先在首页输入访问码"
        else:
            code_row = ctx.db.get_code(code_id)
            if not code_row:
                auth_error = "登录态无效，请重新输入访问码"
            else:
                valid, reason = ctx.db.check_code_validity(code_row)
                if not valid:
                    auth_error = reason

    # 查看端必须携带房间参数（从控制端分享的链接进入）
    if client_role == "viewer" and not room_id:
        auth_error = auth_error or "缺少房间参数，请使用控制端分享的查看端链接进入"

    # 查看端带了房间号但房间不存在（可能已被回收）：给出明确提示而不是要求登录
    if client_role == "viewer" and room_id and auth_error:
        auth_error = "房间不存在或已结束，请向演讲者获取新的查看端链接"

    if auth_error:
        try:
            await ws.send_json({"type": "auth_error", "message": auth_error})
        finally:
            await ws.close()
        logger.warning(f"WebSocket 鉴权失败: {request.remote}, 角色: {client_role}, 原因: {auth_error}")
        return ws

    # 创建翻译服务器实例（绑定访问码与房间，携带访问码信息供房间列表展示）
    # 配置在启动时已加载一次（见 start_server），这里只传深拷贝副本：
    # 避免每个连接重复读磁盘/重初始化纠正器，同时保证 TranslationServer 内部的
    # 配置修改（如 update_language）不会跨连接/跨房间泄露
    config = copy.deepcopy(ctx.config)
    code_info = None
    if code_row is not None:
        code_info = {
            "applicant": code_row["applicant"],
            "department": code_row["department"] or "",
            "topic": code_row["topic"] or "",
            "code": code_row["code"],
        }
    server = TranslationServer(config, client_role=client_role,
                               access_db=ctx.db, code_id=code_id, room_id=room_id,
                               code_info=code_info, minutes_service=ctx.minutes)

    # 创建适配器，让aiohttp的WebSocket看起来像websockets库的WebSocket
    class WebSocketAdapter:
        def __init__(self, ws):
            self.ws = ws

        @property
        def open(self):
            return not self.ws.closed

        @property
        def closed(self):
            return self.ws.closed

        @property
        def remote_address(self):
            """返回远程地址（用于日志）"""
            return getattr(self.ws, 'remote', 'unknown')

        async def send(self, data):
            if isinstance(data, str):
                await self.ws.send_str(data)
            else:
                await self.ws.send_bytes(data)

        async def send_str(self, data):
            """异步发送字符串消息"""
            await self.ws.send_str(data)

        async def send_bytes(self, data):
            await self.ws.send_bytes(data)

    server.client_websocket = WebSocketAdapter(ws)

    try:
        client_address = request.remote
        logger.info(f"客户端连接: {client_address}, 角色: {client_role}, 访问码ID: {code_id}")

        # 处理客户端连接（根据角色不同处理）
        # 创建适配器并传入
        adapter = WebSocketAdapter(ws)
        server.client_websocket = adapter

        # 初始化连接（这里会创建 volcengine_client 并连接）
        try:
            logger.info(f"开始初始化客户端连接，角色: {client_role}, WebSocket 状态: closed={ws.closed}")

            # iOS Safari 特殊处理：等待 WebSocket 连接完全建立
            # iOS Safari 的 WebSocket 连接可能需要额外时间才能稳定
            if client_role == "viewer":
                # 等待一小段时间，确保 WebSocket 连接完全建立
                await asyncio.sleep(0.2)  # 延迟 200ms
                # 再次检查连接状态
                if ws.closed:
                    logger.warning("WebSocket 连接在延迟期间已关闭")
                    return ws

            await server.handle_client(adapter, client_role=client_role)
            logger.info(f"客户端连接初始化成功，角色: {client_role}, WebSocket 状态: closed={ws.closed}")
        except Exception as e:
            logger.error(f"初始化连接失败: {e}", exc_info=True)
            logger.error(f"异常类型: {type(e).__name__}, 异常消息: {str(e)}")
            # 如果连接失败，不继续处理消息
            if not ws.closed:
                try:
                    await ws.send_json({
                        "type": "error",
                        "message": f"初始化失败: {str(e)}"
                    })
                except Exception as send_error:
                    logger.error(f"发送错误消息失败: {send_error}")
            return ws

        # 接收客户端消息（消息循环）
        # 只有连接成功后才进入消息循环
        logger.info(f"开始消息循环，角色: {client_role}")
        try:
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT:
                    await server._handle_client_message(msg.data)
                elif msg.type == web.WSMsgType.BINARY:
                    # 二进制消息（音频数据）
                    await server._handle_client_message(msg.data)
                elif msg.type == web.WSMsgType.ERROR:
                    logger.error(f'WebSocket 错误: {ws.exception()}')
                    break
                elif msg.type == web.WSMsgType.CLOSE:
                    logger.info('WebSocket 连接关闭')
                    break
        except asyncio.CancelledError:
            logger.info("消息循环被取消")
            raise
        except Exception as e:
            logger.error(f"消息循环错误: {e}", exc_info=True)
        finally:
            # 连接关闭时清理资源
            logger.info(f"开始清理资源，角色: {client_role}")
            await server.cleanup(client_role)

    except Exception as e:
        logger.error(f"处理客户端连接时出错: {e}", exc_info=True)
        try:
            if not ws.closed:
                await ws.send_json({
                    "type": "error",
                    "message": str(e)
                })
        except:
            pass
    finally:
        logger.info(f"客户端断开连接: {client_address}")

    return ws


# ---------- 页面 ----------

async def start_server(port=15677, use_https=False):
    """启动服务器（同时处理 HTTP 和 WebSocket）"""
    app = web.Application()

    # 读取配置
    try:
        config = load_config()
    except Exception:
        config = {}
    ctx = AppContext(config, use_https)
    app['ctx'] = ctx
    ctx.db.end_orphan_meetings()
    for meeting_id in ctx.db.pending_minutes():
        ctx.minutes.schedule(meeting_id)

    server_config = (config or {}).get("server", {}) if isinstance(config, dict) else {}
    advertise_ip = server_config.get("advertise_ip")

    # 静态文件服务（前端文件）
    frontend_dir = os.path.join(project_root, 'frontend')

    # 处理 favicon.ico 请求（避免 404 错误）
    async def favicon_handler(request):
        return web.Response(status=204)  # No Content

    app.router.add_get('/favicon.ico', favicon_handler)

    # WebSocket 路由（必须在静态文件路由之前，以确保优先匹配）
    app.router.add_get('/ws', websocket_handler)

    # 新首页：申请使用 / 输入访问码（公开）
    async def welcome_handler(request):
        return web.FileResponse(os.path.join(frontend_dir, 'welcome.html'))

    app.router.add_get('/', welcome_handler)

    # 受保护页面：控制端（需访问码登录态，否则跳回首页）
    async def app_handler(request):
        if get_code_id_from_request(ctx.signer, request) is None:
            raise web.HTTPFound('/')
        index_path = os.path.join(frontend_dir, 'index.html')
        return web.FileResponse(index_path)

    app.router.add_get('/app', app_handler)

    # 受保护页面：查看端
    async def viewer_handler(request):
        # 扫码/链接直达场景：携带房间参数即可进入（房间号本身即凭证，不可猜测且短时效）；
        # 无房间参数时要求访问码登录态，否则回到首页
        room_param = (request.query.get('room') or '').strip()
        share_param = (request.query.get('share') or '').strip()
        if not room_param and not share_param and get_code_id_from_request(ctx.signer, request) is None:
            raise web.HTTPFound('/')
        viewer_path = os.path.join(frontend_dir, 'viewer.html')
        if os.path.exists(viewer_path):
            resp = web.FileResponse(viewer_path)
            resp.headers['Referrer-Policy'] = 'no-referrer'
            resp.headers['Cache-Control'] = 'no-store'
            return resp
        return web.Response(text="查看端页面未找到", status=404)

    app.router.add_get('/viewer', viewer_handler)

    # 管理页（页面本身公开，数据接口需管理员登录态）
    async def admin_handler(request):
        return web.FileResponse(os.path.join(frontend_dir, 'admin.html'))

    app.router.add_get('/admin', admin_handler)

    # API 路由
    app.router.add_post('/api/request', api_submit_request)
    app.router.add_post('/api/verify', api_verify_code)
    app.router.add_post('/api/admin/login', api_admin_login)
    app.router.add_get('/api/admin/requests', require_admin(api_admin_requests))
    app.router.add_post('/api/admin/approve', require_admin(api_admin_approve))
    app.router.add_post('/api/admin/reject', require_admin(api_admin_reject))
    app.router.add_get('/api/admin/codes', require_admin(api_admin_codes))
    app.router.add_post('/api/admin/revoke', require_admin(api_admin_revoke))
    app.router.add_post('/api/admin/resend', require_admin(api_admin_resend))
    app.router.add_get('/api/admin/usage', require_admin(api_admin_usage))
    app.router.add_get('/api/admin/audit', require_admin(api_admin_audit))
    app.router.add_get('/api/admin/rooms', require_admin(api_admin_rooms))
    app.router.add_get('/api/admin/meetings', api_admin_meetings)
    app.router.add_get('/api/admin/meetings/{id:\\d+}', api_admin_meeting)
    app.router.add_post('/api/admin/meetings/{id:\\d+}', api_admin_meeting_action)
    app.router.add_get('/api/share/{token}', api_shared_minutes)
    app.router.add_get('/api/health', api_health)
    app.router.add_get('/api/me', api_me)

    # 静态文件（CSS、JS等）- 使用通配符匹配所有文件
    async def static_handler(request):
        filename = request.match_info['filename']
        file_path = os.path.join(frontend_dir, filename)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            return web.FileResponse(file_path)
        else:
            return web.Response(status=404)

    app.router.add_get('/{filename}', static_handler)

    # 配置 SSL
    ssl_context = None
    if use_https:
        cert_file = os.path.join(project_root, 'ssl', 'cert.pem')
        key_file = os.path.join(project_root, 'ssl', 'key.pem')

        if not os.path.exists(cert_file) or not os.path.exists(key_file):
            logger.error("SSL 证书文件不存在！")
            logger.info("请先运行: ./generate_cert.sh")
            raise FileNotFoundError("SSL 证书文件不存在")

        ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_context.load_cert_chain(cert_file, key_file)

    # 检查端口是否被占用（设置 SO_REUSEADDR，避免刚停止的服务留下 TIME_WAIT 导致误报）
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(('0.0.0.0', port))
        sock.close()
    except OSError as e:
        if e.errno == 48:  # Address already in use
            logger.error(f"端口 {port} 已被占用！")
            logger.info("请使用以下命令关闭占用端口的进程：")
            logger.info(f"  ./kill_port.sh {port}")
            sys.exit(1)
        else:
            raise

    # 启动服务器
    runner = AppRunner(app)
    await runner.setup()

    protocol = "https" if use_https else "http"
    site = TCPSite(runner, '0.0.0.0', port, ssl_context=ssl_context)
    await site.start()

    logger.info("=" * 60)
    logger.info("同声传译实时翻译系统")
    logger.info("=" * 60)
    logger.info(f"服务器启动: {protocol}://0.0.0.0:{port}")
    logger.info(f"首页（申请/访问码）: {protocol}://localhost:{port}")
    logger.info(f"控制端: {protocol}://localhost:{port}/app")
    logger.info(f"查看端: {protocol}://localhost:{port}/viewer")
    logger.info(f"管理后台: {protocol}://localhost:{port}/admin")
    local_ip = advertise_ip.strip() if isinstance(advertise_ip, str) and advertise_ip.strip() else get_local_ip()
    logger.info(f"局域网访问: {protocol}://{local_ip}:{port}")
    logger.info(f"WebSocket 地址: {protocol.replace('http', 'ws')}://{local_ip}:{port}/ws")
    if use_https:
        logger.info(f"iPad/手机访问: 在设备浏览器中输入 {protocol}://{local_ip}:{port}")
        logger.info("注意：首次访问会显示安全警告，点击'高级' -> '继续访问'")
    else:
        logger.warning("注意：移动设备需要 HTTPS 才能使用麦克风功能")
        logger.info("使用 --https 参数启动 HTTPS 服务器")
    if not ctx.admin_password:
        logger.warning("security.admin_password 未配置，管理后台无法登录！")
    if ctx.mailer.enabled:
        mode = "匿名" if not ctx.mailer.username else "账号鉴权"
        logger.info(f"邮件通知: 已启用（{ctx.mailer.host}:{ctx.mailer.port}，{mode}，发件人 {ctx.mailer.from_addr}）")
    else:
        logger.info("邮件通知: 未启用（审批通过后请在管理页复制访问码手动发送）")
    if ctx.admin_notify_emails:
        if ctx.mailer.enabled:
            logger.info(f"新申请提醒: 新申请将邮件通知 {', '.join(ctx.admin_notify_emails)}")
        else:
            logger.warning("security.admin_notify_emails 已配置但 smtp.enabled=false，新申请无法邮件提醒管理员")
    else:
        logger.info("新申请提醒: 未配置 security.admin_notify_emails，请管理员自行查看后台待审批列表")
    logger.info("=" * 60)

    try:
        await asyncio.Future()  # 永久运行
    except KeyboardInterrupt:
        logger.info("服务器已停止")
    finally:
        await runner.cleanup()
        for room in list(ROOM_REGISTRY._rooms.values()):
            if room.meeting_id and ctx.db.end_meeting(room.meeting_id):
                ctx.minutes.schedule(room.meeting_id)
        for task in list(ROOM_REGISTRY._idle_tasks.values()):
            task.cancel()
        await ctx.minutes.shutdown()
        ctx.db.close()


def main():
    """主函数"""
    import argparse

    parser = argparse.ArgumentParser(description='同声传译实时翻译系统服务器')
    parser.add_argument('--https', action='store_true', help='使用 HTTPS 服务器（支持移动设备麦克风）')
    parser.add_argument('--port', type=int, default=15677, help='服务器端口（默认: 15677）')
    args = parser.parse_args()

    try:
        asyncio.run(start_server(port=args.port, use_https=args.https))
    except KeyboardInterrupt:
        logger.info("服务器已停止")


if __name__ == "__main__":
    main()
