"""API 层公共工具"""
from aiohttp import web

from backend.auth import get_code_id_from_request


def json_error(status: int, message: str) -> web.Response:
    return web.json_response({"ok": False, "error": message}, status=status)


def qint(value, default, lo=None, hi=None) -> int:
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


def meeting_public(row: dict) -> dict:
    return {key: row[key] for key in ("id", "room_id", "title", "source_language",
            "target_language", "started_at", "ended_at", "status", "published_at")}


def own_code_id(request) -> "int | None":
    """当前登录态对应的访问码 ID（撤销后视为未登录）"""
    ctx = request.app['ctx']
    code_id = get_code_id_from_request(ctx.signer, request)
    row = ctx.db.get_code(code_id) if code_id else None
    return code_id if row and row["status"] != "revoked" else None
