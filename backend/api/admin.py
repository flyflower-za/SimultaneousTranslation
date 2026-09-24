"""管理接口"""
import logging
import math
import secrets
from urllib.parse import urlsplit

from aiohttp import web

from backend.api.common import json_error, meeting_public, qint
from backend.auth import is_admin, make_admin_cookie
from backend.context import AppContext
from backend.server import ROOM_REGISTRY

logger = logging.getLogger(__name__)


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
        return json_error(500, "管理员密码未配置，"
                              "请在 config.json 的 security.admin_password 中设置")
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
    limit = qint(request.query.get("limit"), 200, lo=1, hi=1000)
    offset = qint(request.query.get("offset"), 0, lo=0)
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

    message = ("已审批通过，访问码已通过邮件发送" if sent
               else "已审批通过。邮件发送失败，请在访问码列表中复制后手动发送")
    return web.json_response({"ok": True, "code": code_row["code"],
                              "email_sent": sent, "message": message})


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
    limit = qint(request.query.get("limit"), 200, lo=1, hi=1000)
    offset = qint(request.query.get("offset"), 0, lo=0)
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

    by_code_limit = qint(request.query.get("code_limit"), 200, lo=1, hi=1000)
    by_code_offset = qint(request.query.get("code_offset"), 0, lo=0)
    by_code_total = ctx.db.count_usage_codes(days)
    by_day_limit = qint(request.query.get("day_limit"), 10, lo=1, hi=365)
    by_day_offset = qint(request.query.get("day_offset"), 0, lo=0)
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
    limit = qint(request.query.get("limit"), 20, lo=1, hi=200)
    offset = qint(request.query.get("offset"), 0, lo=0)
    rows = ctx.db.list_audit(limit=limit, offset=offset)
    return web.json_response({
        "ok": True, "total": ctx.db.count_audit(), "limit": limit, "offset": offset,
        "logs": [dict(r) for r in rows],
    })


async def api_admin_rooms(request):
    """活跃房间列表（管理端）"""
    return web.json_response({"ok": True, "rooms": ROOM_REGISTRY.snapshot()})


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
                              "segments": ctx.db.meeting_segments(meeting_id),
                              "versions": ctx.db.list_minutes_versions(meeting_id),
                              "model_calls": ctx.db.minutes_model_calls(meeting_id),
                              "model_totals": ctx.db.minutes_model_totals(meeting_id)})


@require_admin
async def api_admin_meeting_version(request):
    ctx: AppContext = request.app['ctx']
    version = ctx.db.get_minutes_version(int(request.match_info['id']),
                                         int(request.match_info['version_id']))
    if not version:
        return json_error(404, "纪要版本不存在")
    return web.json_response({"ok": True, "version": version})


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
        valid_content = (row["ended_at"] and isinstance(content, str)
                         and content.strip() and len(content) <= 200000)
        if not valid_content:
            return json_error(400, "纪要内容无效")
        if row["status"] == "generating":
            return json_error(409, "纪要正在生成，请稍后编辑")
        if row["published_at"]:
            return json_error(409, "请先撤回发布再编辑")
        ctx.db.save_minutes(meeting_id, content.strip())
    elif action == "restore":
        if not row["ended_at"] or row["published_at"] or row["status"] == "generating":
            return json_error(409, "请先结束会议并撤回发布")
        try:
            version_id = int(body.get("version_id"))
        except (TypeError, ValueError):
            return json_error(400, "版本 ID 无效")
        version = ctx.db.get_minutes_version(meeting_id, version_id)
        if not version:
            return json_error(404, "纪要版本不存在")
        ctx.db.save_minutes(meeting_id, version["content"], actor="admin", source="restore")
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


@require_admin
async def api_admin_minutes_settings(request):
    ctx: AppContext = request.app['ctx']
    if request.method == "GET":
        return web.json_response({"ok": True, "settings": ctx.minutes.public_settings()})
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("请求体必须是对象")
        base_url = str(body.get("base_url", "")).strip().rstrip("/")
        parsed = urlsplit(base_url)
        if base_url and (parsed.scheme not in ("http", "https") or not parsed.netloc
                         or parsed.username or parsed.password):
            raise ValueError("模型地址须为有效 HTTP/HTTPS URL")
        settings = dict(ctx.minutes.config)
        settings["base_url"] = base_url
        settings["model"] = str(body.get("model", "")).strip()[:150]
        settings["output_language"] = str(body.get("output_language", "中文")).strip()[:30]
        if body.get("clear_api_key"):
            settings["api_key"] = ""
        elif body.get("api_key"):
            settings["api_key"] = str(body["api_key"]).strip()
        for key, lo, hi in (("timeout_sec", 5, 600), ("chunk_chars", 2000, 30000),
                            ("max_tokens", 256, 8192), ("max_attempts", 1, 10),
                            ("retry_delay_sec", 1, 3600)):
            value = int(body.get(key, settings.get(key, lo)))
            if not lo <= value <= hi:
                raise ValueError(f"{key} 必须在 {lo} 到 {hi} 之间")
            settings[key] = value
        for key in ("input_per_million", "output_per_million"):
            value = float(body.get(key, settings.get(key, 0)))
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"{key} 必须是非负数字")
            settings[key] = value
        default_currency = settings.get("currency", "CNY")
        settings["currency"] = str(body.get("currency", default_currency)).strip()[:12]
    except (TypeError, ValueError) as exc:
        return json_error(400, str(exc))
    ctx.db.save_minutes_settings(settings)
    ctx.minutes.reload_settings()
    if ctx.minutes.configured:
        for meeting_id in ctx.db.minutes_needing_config():
            ctx.minutes.schedule(meeting_id)
    ctx.db.audit("admin", "minutes_model_settings_updated", f"模型 {settings['model']}")
    return web.json_response({"ok": True, "settings": ctx.minutes.public_settings()})
