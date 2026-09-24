"""公开接口：使用申请与访问码验证"""
import logging

from aiohttp import web

from backend.api.common import json_error
from backend.auth import make_user_cookie
from backend.context import AppContext
from backend.server import ROOM_REGISTRY

logger = logging.getLogger(__name__)


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
