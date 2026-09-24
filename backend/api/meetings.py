"""用户侧会议接口：我的会议、分享纪要、下载"""
from aiohttp import web

from backend.api.common import json_error, meeting_public, own_code_id
from backend.auth import get_code_id_from_request, is_admin
from backend.context import AppContext
from backend.minutes_export import render_minutes_pdf


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
        published = ctx.db.published_minutes(row["id"])
        if published is not None:
            result["minutes_text"] = published
    resp = web.json_response({"ok": True, "meeting": result})
    resp.headers["Cache-Control"] = "no-store"
    return resp


async def api_my_meetings(request):
    code_id = own_code_id(request)
    if code_id is None:
        return json_error(401, "请先登录控制端")
    rows = request.app['ctx'].db.list_meetings(code_id=code_id, limit=200)
    return web.json_response({"ok": True, "meetings": [meeting_public(row) for row in rows]})


async def api_my_meeting(request):
    code_id = own_code_id(request)
    if code_id is None:
        return json_error(401, "请先登录控制端")
    ctx: AppContext = request.app['ctx']
    meeting_id = int(request.match_info['id'])
    row = ctx.db.get_meeting(meeting_id)
    if not row or row["code_id"] != code_id:
        return json_error(404, "会议不存在")
    return web.json_response({"ok": True, "meeting": row,
                              "segments": ctx.db.meeting_segments(meeting_id),
                              "versions": ctx.db.list_minutes_versions(meeting_id)})


async def api_download_meeting(request):
    ctx: AppContext = request.app['ctx']
    meeting_id = int(request.match_info['id'])
    row = ctx.db.get_meeting(meeting_id)
    admin = is_admin(ctx.signer, request)
    if not row or (not admin and own_code_id(request) != row["code_id"]):
        return json_error(404, "会议不存在")
    if not row["minutes_text"]:
        return json_error(409, "纪要尚未生成")
    fmt = request.query.get("format", "md")
    if fmt == "pdf":
        body = render_minutes_pdf(row["title"] or f"会议 {meeting_id}", row["minutes_text"])
        content_type, suffix = "application/pdf", "pdf"
    elif fmt == "md":
        body = row["minutes_text"].encode("utf-8")
        content_type, suffix = "text/markdown", "md"
    else:
        return json_error(400, "只支持 md 或 pdf")
    filename = f"meeting-{meeting_id}.{suffix}"
    return web.Response(body=body, content_type=content_type,
                        headers={"Content-Disposition": f'attachment; filename="{filename}"',
                                 "Cache-Control": "no-store"})
