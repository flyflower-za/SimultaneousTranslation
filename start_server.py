#!/usr/bin/env python3
"""
启动服务器脚本 - 支持 iPad 访问
使用 aiohttp 同时提供 HTTP/HTTPS 服务器（前端文件）和 WebSocket/WSS 服务器

路由结构：
  /            新首页（提交使用申请 / 输入访问码进入）
  /app         控制端页面（需访问码登录态）
  /viewer      查看端页面（需访问码登录态）
  /admin       管理页（管理员密码登录）
  /api/*       申请、验证、管理接口（见 backend/api/）
  /ws          WebSocket（握手时校验访问码 cookie）
"""
import asyncio
import copy
import logging
import os
import socket
import ssl
import sys

from aiohttp import web
from aiohttp.web_runner import AppRunner, TCPSite

# 添加项目路径
project_root = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, project_root)

from backend.api import register_routes
from backend.api.common import own_code_id
from backend.auth import get_code_id_from_request
from backend.context import AppContext
from backend.minutes import MinutesService  # noqa: F401  (re-export 供外部使用)
from backend.server import ROOM_REGISTRY, TranslationServer, load_config

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
    ctx = AppContext(config, use_https, DB_PATH)
    app['ctx'] = ctx
    ctx.db.end_orphan_meetings()
    ctx.minutes.start()

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

    async def my_meetings_handler(request):
        if own_code_id(request) is None:
            raise web.HTTPFound('/')
        return web.FileResponse(os.path.join(frontend_dir, 'my_meetings.html'))

    app.router.add_get('/my-meetings', my_meetings_handler)

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

    # API 路由（见 backend/api/）
    register_routes(app)

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
            logger.info("请先运行: ./scripts/generate_cert.sh")
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
            logger.info(f"  ./scripts/kill_port.sh {port}")
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
