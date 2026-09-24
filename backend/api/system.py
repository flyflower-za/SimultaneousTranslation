"""系统接口"""
from aiohttp import web

from backend.server import ROOM_REGISTRY


async def api_health(request):
    """健康检查（公开）：进程存活与房间概况"""
    rooms = ROOM_REGISTRY.snapshot()
    return web.json_response({
        "ok": True,
        "rooms": len(rooms),
        "active_rooms": sum(1 for r in rooms if r["has_controller"]),
        "viewers": sum(r["viewer_count"] for r in rooms),
    })
