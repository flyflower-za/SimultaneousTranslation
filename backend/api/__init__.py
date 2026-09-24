"""HTTP API 路由层：按域拆分的 aiohttp handler 与统一注册入口"""
from aiohttp import web

from backend.api import access, admin, meetings, system


def register_routes(app: web.Application) -> None:
    """注册全部 API 路由"""
    app.router.add_post('/api/request', access.api_submit_request)
    app.router.add_post('/api/verify', access.api_verify_code)
    app.router.add_post('/api/admin/login', admin.api_admin_login)
    app.router.add_get('/api/admin/requests', admin.require_admin(admin.api_admin_requests))
    app.router.add_post('/api/admin/approve', admin.require_admin(admin.api_admin_approve))
    app.router.add_post('/api/admin/reject', admin.require_admin(admin.api_admin_reject))
    app.router.add_get('/api/admin/codes', admin.require_admin(admin.api_admin_codes))
    app.router.add_post('/api/admin/revoke', admin.require_admin(admin.api_admin_revoke))
    app.router.add_post('/api/admin/resend', admin.require_admin(admin.api_admin_resend))
    app.router.add_get('/api/admin/usage', admin.require_admin(admin.api_admin_usage))
    app.router.add_get('/api/admin/audit', admin.require_admin(admin.api_admin_audit))
    app.router.add_get('/api/admin/rooms', admin.require_admin(admin.api_admin_rooms))
    app.router.add_get('/api/admin/meetings', admin.api_admin_meetings)
    app.router.add_get('/api/admin/meetings/{id:\\d+}', admin.api_admin_meeting)
    app.router.add_post('/api/admin/meetings/{id:\\d+}', admin.api_admin_meeting_action)
    app.router.add_get('/api/admin/meetings/{id:\\d+}/versions/{version_id:\\d+}',
                       admin.api_admin_meeting_version)
    app.router.add_get('/api/admin/meetings/{id:\\d+}/download', meetings.api_download_meeting)
    app.router.add_get('/api/admin/minutes-settings', admin.api_admin_minutes_settings)
    app.router.add_post('/api/admin/minutes-settings', admin.api_admin_minutes_settings)
    app.router.add_get('/api/my/meetings', meetings.api_my_meetings)
    app.router.add_get('/api/my/meetings/{id:\\d+}', meetings.api_my_meeting)
    app.router.add_get('/api/my/meetings/{id:\\d+}/download', meetings.api_download_meeting)
    app.router.add_get('/api/share/{token}', meetings.api_shared_minutes)
    app.router.add_get('/api/health', system.api_health)
    app.router.add_get('/api/me', meetings.api_me)
