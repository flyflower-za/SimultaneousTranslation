"""
同声传译 WebSocket 服务器
"""
import asyncio
import json
import logging
import secrets
import time
import websockets
from websockets.server import serve
from typing import Optional, Dict, List
import sys
import os
import uuid
import inspect

# 添加项目根目录到路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.volcengine_client import VolcengineASTClient
from backend.audio_processor import validate_audio_format
from backend.text_filter import filter_text
from backend.text_corrector import correct_text, get_corrector

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class TranslationSession:
    """翻译房间：一场翻译会议的上下文（控制端 + 查看端 + 字幕状态）

    多房间架构下每场会议一个实例，由 RoomRegistry 管理；
    控制端断开后房间保留一段时间（延迟回收），等待重连恢复。
    """

    def __init__(self, config: dict, room_id: str):
        """
        初始化房间

        Args:
            config: 配置字典
            room_id: 房间 ID
        """
        self.config = config
        self.room_id = room_id
        self.owner_code_id = None
        self.meeting_id = None
        self.share_token = None
        self.on_idle_close = None
        self.created_at = time.time()
        self.volcengine_client: Optional[VolcengineASTClient] = None
        self.controller_websocket = None  # 控制端连接
        self.viewer_websockets: Dict[str, any] = {}  # 查看端连接字典 {client_id: websocket}
        # 订阅 TTS 音频的查看端集合（默认不推音频，避免 base64 负载广播给所有查看端）
        self.viewer_wants_tts: set = set()
        # 控制端信息（来自其访问码），供管理端房间列表展示；控制端断开后保留至房间回收
        self.controller_info = {"applicant": "", "department": "", "topic": "", "code": ""}
        self.current_source_text = ""  # 当前原文
        self.current_target_text = ""  # 当前译文
        self.completed_source_lines: List[str] = []  # 已完成的原文行
        self.completed_target_lines: List[str] = []  # 已完成的译文行
        self.max_history_lines = 8  # 最大历史记录数

    async def add_controller(self, websocket, volcengine_client: VolcengineASTClient):
        """添加控制端连接（同一房间再次连入时顶替旧连接）"""
        if self.controller_websocket is not None and self.controller_websocket is not websocket:
            logger.info(f"[room {self.room_id}] 已有控制端连接，关闭旧连接（被新连接顶替）")
            try:
                if hasattr(self.controller_websocket, 'close'):
                    await self.controller_websocket.close()
                elif hasattr(self.controller_websocket, 'ws'):
                    await self.controller_websocket.ws.close()
            except:
                pass

        self.controller_websocket = websocket
        self.volcengine_client = volcengine_client
        logger.info(f"[room {self.room_id}] 控制端已连接")

    async def remove_controller(self, websocket=None):
        """移除控制端连接。传入 websocket 时仅在仍是当前控制端时移除（防止顶替竞争）"""
        if websocket is not None and self.controller_websocket is not None \
                and self.controller_websocket is not websocket:
            logger.info(f"[room {self.room_id}] 忽略旧控制端的清理请求（已被新连接顶替）")
            return
        self.controller_websocket = None
        logger.info(f"[room {self.room_id}] 控制端已断开")

    async def add_viewer(self, websocket) -> str:
        """添加查看端连接，返回客户端ID"""
        client_id = str(uuid.uuid4())
        self.viewer_websockets[client_id] = websocket
        logger.info(f"[room {self.room_id}] 查看端已连接，客户端ID: {client_id}，"
                    f"当前查看端数量: {len(self.viewer_websockets)}")
        return client_id
    
    async def remove_viewer(self, client_id: str):
        """移除查看端连接"""
        self.viewer_wants_tts.discard(client_id)
        if client_id in self.viewer_websockets:
            del self.viewer_websockets[client_id]
            logger.info(f"查看端已断开，客户端ID: {client_id}，当前查看端数量: {len(self.viewer_websockets)}")
    
    async def broadcast_to_viewers(self, message: dict, tts_client_ids: Optional[set] = None):
        """向所有查看端广播消息。

        Args:
            message: 要广播的消息（可能含 TTS 音频负载）
            tts_client_ids: 需要接收 TTS 音频的查看端集合。为 None 时所有查看端收到完整消息；
                            为集合时其余查看端收到剥离音频负载的精简消息（节省带宽）
        """
        if not self.viewer_websockets:
            return

        # 预先序列化：字幕事件频率高，避免每个查看端重复 dumps
        full_payload = json.dumps(message)
        lite_payload = None
        if tts_client_ids is not None and any(
                cid not in tts_client_ids for cid in self.viewer_websockets):
            lite_data = {k: v for k, v in message.get("data", {}).items() if k != "data"}
            lite_payload = json.dumps({**message, "data": lite_data})

        disconnected_clients = []
        for client_id, ws in self.viewer_websockets.items():
            try:
                # 检查连接是否打开
                if hasattr(ws, 'closed') and ws.closed:
                    disconnected_clients.append(client_id)
                    continue
                if hasattr(ws, 'open') and not ws.open:
                    disconnected_clients.append(client_id)
                    continue

                # 选择负载：未订阅 TTS 的查看端不收音频数据
                payload = full_payload
                if lite_payload is not None and client_id not in tts_client_ids:
                    payload = lite_payload

                # 发送消息
                if hasattr(ws, 'send_str'):
                    # send_str 是异步方法（WebSocketAdapter 中定义的）
                    await ws.send_str(payload)
                elif hasattr(ws, 'send'):
                    await ws.send(payload)
                else:
                    logger.warning(f"查看端 {client_id} 的 WebSocket 对象不支持发送消息")
            except Exception as e:
                logger.error(f"向查看端 {client_id} 发送消息失败: {e}")
                disconnected_clients.append(client_id)
        
        # 清理断开的连接
        for client_id in disconnected_clients:
            await self.remove_viewer(client_id)
    
    async def send_state_to_viewer(self, websocket):
        """向新连接的查看端发送当前状态"""
        state_message = {
            "type": "state_sync",
            "source_text": self.current_source_text,
            "target_text": self.current_target_text,
            "completed_source_lines": self.completed_source_lines[-self.max_history_lines:],
            "completed_target_lines": self.completed_target_lines[-self.max_history_lines:]
        }
        
        try:
            if hasattr(websocket, 'send_str'):
                # send_str 是异步方法（WebSocketAdapter 中定义的）
                await websocket.send_str(json.dumps(state_message))
            elif hasattr(websocket, 'send'):
                await websocket.send(json.dumps(state_message))
            else:
                logger.warning("WebSocket 对象不支持发送消息")
        except Exception as e:
            logger.error(f"发送状态同步消息失败: {e}", exc_info=True)
            # 不抛出异常，避免影响连接建立


# 房间 ID 字符集：与访问码一致，去掉易混淆字符
ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
ROOM_ID_LENGTH = 6
# 控制端断开后房间的保留时间（秒），期间重连可恢复本场上下文和查看端
ROOM_IDLE_TEARDOWN_SEC = 5 * 60


class RoomRegistry:
    """房间注册表：room_id -> TranslationSession（进程级，多房间并发互不影响）"""

    def __init__(self):
        self._rooms: Dict[str, TranslationSession] = {}
        self._idle_tasks: Dict[str, asyncio.Task] = {}

    @staticmethod
    def generate_room_id() -> str:
        return "".join(secrets.choice(ROOM_ALPHABET) for _ in range(ROOM_ID_LENGTH))

    def get(self, room_id: str) -> Optional[TranslationSession]:
        return self._rooms.get(room_id)

    def get_or_create(self, room_id: Optional[str], config: dict) -> tuple:
        """获取房间；不存在则以给定 ID（或新生成）创建。返回 (session, created)"""
        if room_id and room_id in self._rooms:
            return self._rooms[room_id], False
        new_id = room_id or self.generate_room_id()
        # 极小概率撞上已有房间 ID 时重新生成
        while new_id in self._rooms:
            new_id = self.generate_room_id()
        session = TranslationSession(config, new_id)
        self._rooms[new_id] = session
        return session, True

    def cancel_idle_teardown(self, room_id: str):
        task = self._idle_tasks.pop(room_id, None)
        if task:
            task.cancel()

    def schedule_idle_teardown(self, room_id: str, delay_sec: Optional[int] = None):
        """控制端断开后延迟回收房间；到期仍无控制端则通知查看端并移除房间"""
        self.cancel_idle_teardown(room_id)

        async def _teardown():
            try:
                await asyncio.sleep(delay_sec if delay_sec is not None else ROOM_IDLE_TEARDOWN_SEC)
                room = self._rooms.get(room_id)
                if room is None or room.controller_websocket is not None:
                    return
                if room.on_idle_close:
                    try:
                        await room.on_idle_close()
                    except Exception:
                        logger.exception("[room %s] 会议收尾失败", room_id)
                logger.info(f"[room {room_id}] 控制端超过保留时间未重连，回收房间（查看端 {len(room.viewer_websockets)} 个）")
                await room.broadcast_to_viewers({
                    "type": "room_closed",
                    "message": "本场翻译已结束"
                })
                for client_id, ws in list(room.viewer_websockets.items()):
                    try:
                        raw_ws = getattr(ws, 'ws', None)
                        if raw_ws is not None:
                            await raw_ws.close()
                    except Exception:
                        pass
                self._rooms.pop(room_id, None)
            except asyncio.CancelledError:
                pass

        self._idle_tasks[room_id] = asyncio.create_task(_teardown())

    def find_room_by_code(self, code: str) -> Optional[str]:
        """按访问码找房间：优先控制端在线的房间，其次最近创建的（等待重连窗口内）"""
        best = None
        for room in self._rooms.values():
            if room.controller_info.get("code") != code:
                continue
            if room.controller_websocket is not None:
                return room.room_id  # 在线房间直接命中
            if best is None or room.created_at > best.created_at:
                best = room
        return best.room_id if best else None

    def snapshot(self) -> List[dict]:
        """房间运行态快照（供管理后台展示）"""
        result = []
        now = time.time()
        for room_id, room in self._rooms.items():
            result.append({
                "room_id": room_id,
                "created_at": room.created_at,
                "uptime_sec": int(now - room.created_at),
                "has_controller": room.controller_websocket is not None,
                "viewer_count": len(room.viewer_websockets),
                "applicant": room.controller_info.get("applicant", ""),
                "department": room.controller_info.get("department", ""),
                "topic": room.controller_info.get("topic", ""),
                "code": room.controller_info.get("code", ""),
                "share_token": room.share_token,
            })
        return sorted(result, key=lambda r: r["created_at"])


# 进程级房间注册表
ROOM_REGISTRY = RoomRegistry()


class TranslationServer:
    """翻译服务器"""
    
    def __init__(self, config: dict, client_role: str = "controller",
                 access_db=None, code_id: Optional[int] = None,
                 room_id: Optional[str] = None, code_info: Optional[dict] = None,
                 minutes_service=None):
        """
        初始化服务器

        Args:
            config: 配置字典
            client_role: 客户端角色 ("controller" 或 "viewer")
            access_db: 访问控制数据库（可选，用于用量计量与额度管控）
            code_id: 当前连接绑定的访问码 ID（可选）
            room_id: 房间 ID（可选）。控制端携带时恢复该房间，否则新建；
                     查看端携带时加入该房间
            code_info: 访问码信息（申请人/部门/主题/码值），控制端连接成功后写入房间
        """
        self.config = config
        self.client_role = client_role
        self.room_id = (room_id or "").strip().upper() or None
        self.code_info = code_info or {}
        self.volcengine_client: Optional[VolcengineASTClient] = None
        self.client_websocket = None
        self.session: Optional[TranslationSession] = None
        self.viewer_client_id = None
        self.access_db = access_db
        self.code_id = code_id
        self.db_session_id = None  # 访问计量会话记录 ID
        self.minutes_service = minutes_service
        # TTS 停流看门狗：字幕仍在推进但长时间没有 TTS 事件时自动重建火山引擎会话
        self._tts_watchdog_task = None
        self._last_tts_ts = None          # 最近一次 TTS 事件（350/351/352）时间
        self._last_subtitle_ts = None     # 最近一次字幕事件（650-655）时间
        self._controller_connected_ts = None
        self._tts_rebuild_count = 0
        self._volcengine_rebuilding = False  # 会话重建中，音频直接丢弃避免并发重连
        
    async def handle_client(self, websocket, client_role: str = "controller"):
        """
        处理客户端连接（初始化阶段）

        Args:
            websocket: 客户端 WebSocket 连接
            client_role: 客户端角色 ("controller" 或 "viewer")
        """
        self.client_role = client_role
        self.client_websocket = websocket

        # 房间解析：控制端按 room 参数恢复或新建房间；查看端按 room 参数加入指定房间
        if client_role == "controller":
            existing = ROOM_REGISTRY.get(self.room_id) if self.room_id else None
            if existing and existing.owner_code_id != self.code_id:
                raise PermissionError("该房间不属于当前访问码")
            self.session, created = ROOM_REGISTRY.get_or_create(self.room_id, self.config)
            self.room_id = self.session.room_id
            if self.session.owner_code_id is None:
                self.session.owner_code_id = self.code_id
            if created:
                logger.info(f"创建新房间: {self.room_id}")
            else:
                logger.info(f"控制端重连/顶替，恢复房间: {self.room_id}")
            ROOM_REGISTRY.cancel_idle_teardown(self.room_id)
        else:
            self.session = ROOM_REGISTRY.get(self.room_id) if self.room_id else None
            if self.session is None:
                raise Exception("房间不存在或已结束，请使用控制端分享的查看端链接进入")

        try:
            client_address = websocket.remote_address if hasattr(websocket, 'remote_address') else "unknown"
            logger.info(f"客户端连接: {client_address}, 角色: {client_role}, 房间: {self.room_id}")

            if client_role == "controller":
                # 控制端：初始化火山引擎连接
                await self._handle_controller_connection(websocket)
            else:
                # 查看端：只接收广播消息
                await self._handle_viewer_connection(websocket)

        except Exception as e:
            logger.error(f"处理客户端连接时出错: {e}", exc_info=True)
            try:
                await self._send_to_client({
                    "type": "error",
                    "message": str(e)
                })
            except:
                pass
            raise  # 重新抛出异常，让上层处理
    
    async def cleanup(self, client_role: str):
        """
        清理资源（在连接真正关闭时调用）
        
        Args:
            client_role: 客户端角色
        """
        logger.info(f"开始清理资源，角色: {client_role}")
        if client_role == "controller":
            # 停止 TTS 停流看门狗
            if self._tts_watchdog_task:
                self._tts_watchdog_task.cancel()
                try:
                    await self._tts_watchdog_task
                except (asyncio.CancelledError, Exception):
                    pass
                self._tts_watchdog_task = None
            # 结束计量会话（墙钟时长已入库，供用量报表使用）
            if self.access_db and self.db_session_id:
                try:
                    self.access_db.end_session(self.db_session_id)
                    self.access_db.audit(f"code:{self.code_id}", "session_end",
                                         f"计量会话 #{self.db_session_id} 结束")
                except Exception as e:
                    logger.error(f"结束计量会话失败: {e}")
                self.db_session_id = None
            if self.session:
                await self.session.remove_controller(self.client_websocket)
            if self.volcengine_client:
                try:
                    await self.volcengine_client.close()
                except:
                    pass
            # 控制端断开后房间保留一段时间等待重连，到期自动回收并通知查看端
            if self.room_id and self.session is not None:
                if self.session.controller_websocket is None:
                    ROOM_REGISTRY.schedule_idle_teardown(self.room_id)
        else:
            if self.viewer_client_id and self.session:
                await self.session.remove_viewer(self.viewer_client_id)
        self.client_websocket = None
        logger.info(f"资源清理完成，角色: {client_role}")
    
    def _set_idle_meeting_close(self):
        meeting_id = self.session.meeting_id
        async def finish_on_idle():
            if self.access_db and self.access_db.end_meeting(meeting_id) and self.minutes_service:
                self.minutes_service.schedule(meeting_id)
        self.session.on_idle_close = finish_on_idle

    async def _finish_meeting(self):
        if self.access_db and self.session and self.session.meeting_id:
            meeting_id = self.session.meeting_id
            if self.access_db.end_meeting(meeting_id) and self.minutes_service:
                self.minutes_service.schedule(meeting_id)

    async def _handle_controller_connection(self, websocket):
        """处理控制端连接"""
        # 初始化火山引擎客户端
        volc_config = self.config["volcengine"]
        translation_config = self.config.get("translation", {})
        tts_config = self.config.get("tts", {})
        
        self.volcengine_client = VolcengineASTClient(
            api_key=volc_config["api_key"],
            resource_id=volc_config.get("resource_id", "volc.service_type.10053"),
            source_lang=translation_config.get("source_language", "zh"),
            target_lang=translation_config.get("target_language", "en"),
            tts_speaker_id=tts_config.get("speaker_id", ""),
            speech_rate=tts_config.get("speech_rate", 0)
        )
        
        # 设置消息回调
        self.volcengine_client.on_message = self._handle_volcengine_message
        self.volcengine_client.on_error = self._handle_volcengine_error
        
        # 连接到火山引擎
        logger.info("正在连接到火山引擎 API...")
        try:
            await self.volcengine_client.connect()
            logger.info("已连接到火山引擎 API")
            
            # 验证连接状态
            if not self.volcengine_client.connected:
                raise Exception("火山引擎客户端连接失败：connected 状态为 False")
            
            # 发送开始会话请求
            logger.info("发送 StartSession 请求...")
            await self.volcengine_client.send_start_session()
            logger.info("StartSession 请求已发送，等待响应...")
            
            # 注册到会话管理器
            await self.session.add_controller(websocket, self.volcengine_client)

            # 一场会议跨短暂断线持续存在；显式停止后再次开始则创建新记录。
            if self.access_db and self.code_id:
                meeting = self.access_db.get_open_meeting(self.room_id, self.code_id)
                if not meeting:
                    langs = self.config.get("translation", {})
                    meeting = self.access_db.create_meeting(
                        self.room_id, self.code_id, self.code_info.get("topic", "会议"),
                        langs.get("source_language", "zh"), langs.get("target_language", "en"))
                self.session.meeting_id = meeting["id"]
                self.session.share_token = meeting["share_token"]
                self._set_idle_meeting_close()

            # 将控制端的访问码信息写入房间（管理端房间列表展示用）
            if self.code_info:
                self.session.controller_info = {
                    "applicant": self.code_info.get("applicant", ""),
                    "department": self.code_info.get("department", ""),
                    "topic": self.code_info.get("topic", ""),
                    "code": self.code_info.get("code", ""),
                }
            
            # 通知前端连接成功，并告知房间信息（查看端链接凭此加入本场）
            await self._send_to_client({
                "type": "connected",
                "message": "已连接到翻译服务"
            })
            await self._send_to_client({
                "type": "room_info",
                "room_id": self.room_id,
                "viewer_path": (f"/viewer?room={self.room_id}&share={self.session.share_token}"
                                if self.session.share_token else f"/viewer?room={self.room_id}"),
                "share_token": self.session.share_token,
                "message": f"房间 {self.room_id} 已就绪，查看端链接已生成"
            })
            logger.info("已通知前端连接成功")

            # 访问计量：登记会话（仅统计用量，不做额度限制）
            if self.access_db and self.code_id:
                try:
                    self.db_session_id = self.access_db.start_session(self.code_id)
                    self.access_db.audit(f"code:{self.code_id}", "session_start",
                                         f"计量会话 #{self.db_session_id} 开始")
                except Exception as e:
                    logger.error(f"访问计量初始化失败（不影响翻译功能）: {e}")

            # 启动 TTS 停流看门狗
            self._controller_connected_ts = time.time()
            self._tts_watchdog_task = asyncio.create_task(self._tts_stall_watchdog())
        except Exception as e:
            logger.error(f"连接火山引擎失败: {e}", exc_info=True)
            # 清理失败的连接
            if self.volcengine_client:
                try:
                    await self.volcengine_client.close()
                except:
                    pass
                self.volcengine_client = None
            
            # 通知前端连接失败
            await self._send_to_client({
                "type": "error",
                "message": f"连接翻译服务失败: {str(e)}"
            })
            raise  # 重新抛出异常，让上层处理
    
    async def _handle_viewer_connection(self, websocket):
        """处理查看端连接"""
        # 注册到会话管理器（这是关键步骤，如果失败应该抛出异常）
        try:
            logger.debug(f"开始注册查看端，websocket 类型: {type(websocket)}, 是否有 send_str: {hasattr(websocket, 'send_str')}")
            self.viewer_client_id = await self.session.add_viewer(websocket)
            logger.info(f"查看端已注册，客户端ID: {self.viewer_client_id}")
        except Exception as e:
            logger.error(f"注册查看端失败: {e}", exc_info=True)
            raise  # 注册失败应该抛出异常
        
        # iOS Safari 特殊处理：延迟发送消息，确保连接完全建立
        # iOS Safari 在 WebSocket 连接刚建立时可能无法立即接收消息
        import asyncio
        await asyncio.sleep(0.1)  # 延迟 100ms，确保连接稳定
        
        # 发送当前状态（失败不应该影响连接建立）
        try:
            await self.session.send_state_to_viewer(websocket)
            logger.debug("已发送状态同步消息")
        except Exception as e:
            logger.error(f"发送状态同步消息失败: {e}", exc_info=True)
            # 不抛出异常，避免影响连接建立
        
        # 再次延迟，确保第一条消息已发送
        await asyncio.sleep(0.05)  # 延迟 50ms
        
        # 通知连接成功（失败不应该影响连接建立）
        try:
            await self._send_to_client({
                "type": "connected",
                "message": "已连接到查看端服务"
            })
            logger.debug("已发送连接成功消息")
        except Exception as e:
            logger.error(f"发送连接成功消息失败: {e}", exc_info=True)
            # 不抛出异常，避免影响连接建立（消息发送失败不应该导致连接失败）
        
        # 查看端的消息循环在 start_server.py 中处理
        # 这里只处理查看端的控制消息（如心跳）
    
    async def _handle_client_message(self, message):
        """
        处理来自客户端的消息
        
        Args:
            message: 客户端消息
        """
        try:
            if isinstance(message, bytes):
                # 音频数据（二进制）
                if not self.volcengine_client:
                    logger.warning("收到音频数据但 volcengine_client 未初始化（可能是查看端或连接失败）")
                    logger.debug(f"客户端角色: {self.client_role}, volcengine_client: {self.volcengine_client}")
                    return

                # 火山引擎会话重建期间直接丢弃音频，避免触发并发重连
                if self._volcengine_rebuilding:
                    return
                
                if not self.volcengine_client.connected:
                    logger.warning("收到音频数据但火山引擎客户端未连接，尝试重新连接...")
                    logger.debug(f"volcengine_client.connected: {self.volcengine_client.connected}")
                    logger.debug(f"volcengine_client.websocket: {self.volcengine_client.websocket}")
                    # 尝试重新连接
                    try:
                        logger.info("开始重新连接火山引擎...")
                        await self.volcengine_client.connect()
                        if self.volcengine_client.connected:
                            logger.info("重新连接成功，发送 StartSession...")
                            await self.volcengine_client.send_start_session()
                        else:
                            logger.error("重新连接失败：connected 仍为 False")
                            return
                    except Exception as e:
                        logger.error(f"重新连接失败: {e}", exc_info=True)
                        return
                
                # 检查会话是否已启动
                if not self.volcengine_client.session_id:
                    logger.warning("收到音频数据但会话未启动，尝试启动会话...")
                    await self.volcengine_client.send_start_session()
                
                # 记录音频数据接收（每 100 次记录一次，避免日志过多）
                if not hasattr(self, '_audio_receive_count'):
                    self._audio_receive_count = 0
                self._audio_receive_count += 1
                if self._audio_receive_count == 1:
                    logger.info(f"✓ 开始接收音频数据，第一个包大小: {len(message)} 字节")
                if self._audio_receive_count % 100 == 0:
                    logger.info(f"已接收 {self._audio_receive_count} 个音频包，当前包大小: {len(message)} 字节")
                
                await self.volcengine_client.send_audio(message)
            elif isinstance(message, str):
                # JSON 消息
                try:
                    data = json.loads(message)
                except json.JSONDecodeError:
                    logger.warning(f"无法解析 JSON 消息: {message[:100]}")
                    return
                
                msg_type = data.get("type")
                
                # 查看端的心跳消息
                if self.client_role == "viewer" and msg_type == "ping":
                    await self._send_to_client({"type": "pong"})
                    return

                # 查看端 TTS 音频订阅开关：仅订阅的查看端在广播时收到音频负载（默认不推，节省带宽）
                if self.client_role == "viewer" and msg_type == "set_tts":
                    if self.session and self.viewer_client_id:
                        if data.get("enabled"):
                            self.session.viewer_wants_tts.add(self.viewer_client_id)
                            logger.info(f"[room {self.session.room_id}] 查看端 {self.viewer_client_id} 订阅 TTS 音频")
                        else:
                            self.session.viewer_wants_tts.discard(self.viewer_client_id)
                            logger.info(f"[room {self.session.room_id}] 查看端 {self.viewer_client_id} 取消订阅 TTS 音频")
                    return
                
                # 控制端的消息处理
                if self.client_role != "controller":
                    return  # 查看端不处理其他消息
                
                if msg_type == "audio":
                    # 音频数据（base64 编码）
                    import base64
                    audio_data = base64.b64decode(data.get("data", ""))
                    if self.volcengine_client and self.volcengine_client.connected:
                        await self.volcengine_client.send_audio(audio_data)
                elif msg_type == "start":
                    # 开始翻译
                    if self.session and self.session.meeting_id and self.access_db:
                        previous = self.access_db.get_meeting(self.session.meeting_id)
                        if previous and previous["ended_at"]:
                            langs = self.config.get("translation", {})
                            meeting = self.access_db.create_meeting(
                                self.room_id, self.code_id, self.code_info.get("topic", "会议"),
                                langs.get("source_language", "zh"), langs.get("target_language", "en"))
                            self.session.meeting_id = meeting["id"]
                            self.session.share_token = meeting["share_token"]
                            self._set_idle_meeting_close()
                            await self._send_to_client({"type": "room_info", "room_id": self.room_id,
                                "viewer_path": f"/viewer?room={self.room_id}&share={self.session.share_token}",
                                "share_token": self.session.share_token})
                    if self.volcengine_client and not self.volcengine_client.connected:
                        await self.volcengine_client.connect()
                        await self.volcengine_client.send_start_session()
                elif msg_type == "stop":
                    # 停止翻译
                    logger.info("收到停止翻译请求")
                    if self.volcengine_client:
                        await self.volcengine_client.close()
                    await self._finish_meeting()
                    
                    # 清除会话状态
                    if self.session:
                        self.session.current_source_text = ""
                        self.session.current_target_text = ""
                        self.session.completed_source_lines = []
                        self.session.completed_target_lines = []
                        logger.info("已清除会话状态")
                    
                    # 广播停止消息给所有查看端
                    if self.session:
                        await self.session.broadcast_to_viewers({
                            "type": "translation_stopped",
                            "message": "翻译已停止"
                        })
                        logger.info("已广播停止消息给所有查看端")
                elif msg_type == "update_language":
                    # 更新翻译语言
                    source_lang = data.get("source_language", "zh")
                    target_lang = data.get("target_language", "en")
                    logger.info(f"收到语言更新请求: source_language={source_lang}, target_language={target_lang}")

                    # 校验：S2S 模式要求源语言或目标语言至少一个为中文/英语
                    if source_lang not in ("zh", "en") and target_lang not in ("zh", "en"):
                        logger.warning(f"无效的语言组合: {source_lang} -> {target_lang}（必须有一方为 zh/en）")
                        await self._send_to_client({
                            "type": "error",
                            "message": f"无效的语言组合: {source_lang} -> {target_lang}，源语言和目标语言中至少需要一个是中文或英语"
                        })
                        return

                    # 更新配置，保证后续重连也使用新语言
                    self.config.setdefault("translation", {})
                    self.config["translation"]["source_language"] = source_lang
                    self.config["translation"]["target_language"] = target_lang
                    
                    # 如果客户端已连接，需要重新启动会话以应用新语言
                    if self.volcengine_client and self.volcengine_client.connected:
                        # 更新客户端的语言设置
                        self.volcengine_client.source_lang = source_lang
                        self.volcengine_client.target_lang = target_lang
                        logger.info(f"已更新客户端语言设置为: {source_lang} -> {target_lang}")
                        
                        # 如果会话已启动，需要重新启动会话以应用新语言
                        if self.volcengine_client.session_id:
                            logger.info("会话已启动，重新启动会话以应用新语言...")
                            await self.volcengine_client.close()
                            await asyncio.sleep(0.5)  # 等待连接完全关闭
                            await self.volcengine_client.connect()
                            await self.volcengine_client.send_start_session()
                            logger.info("会话已重新启动，新语言已应用")
                            
                            # 通知前端语言已更新
                            await self._send_to_client({
                                "type": "language_updated",
                                "message": f"语言已更新为: {source_lang} -> {target_lang}"
                            })
                        else:
                            # 会话未启动，直接更新配置即可
                            logger.info("会话未启动，语言设置将在下次启动会话时应用")
                            await self._send_to_client({
                                "type": "language_updated",
                                "message": f"语言设置已保存: {source_lang} -> {target_lang}"
                            })
                    else:
                        # 客户端未连接，配置已更新，下次连接时生效
                        logger.info("客户端未连接，语言设置已保存到配置，将在连接时应用")
                        await self._send_to_client({
                            "type": "language_updated",
                            "message": f"语言设置已保存: {source_lang} -> {target_lang}"
                        })
                elif msg_type == "update_voice":
                    # 更新TTS音色
                    speaker_id = data.get("speaker_id", "")
                    logger.info(f"收到音色更新请求: speaker_id={speaker_id}")
                    
                    # 如果客户端已连接，需要重新启动会话以应用新音色
                    if self.volcengine_client and self.volcengine_client.connected:
                        # 更新客户端的音色设置
                        self.volcengine_client.tts_speaker_id = speaker_id
                        logger.info(f"已更新客户端音色设置为: {speaker_id or '默认音色'}")
                        
                        # 如果会话已启动，需要重新启动会话以应用新音色
                        if self.volcengine_client.session_id:
                            logger.info("会话已启动，重新启动会话以应用新音色...")
                            await self.volcengine_client.close()
                            await asyncio.sleep(0.5)  # 等待连接完全关闭
                            await self.volcengine_client.connect()
                            await self.volcengine_client.send_start_session()
                            logger.info("会话已重新启动，新音色已应用")
                            
                            # 通知前端音色已更新
                            await self._send_to_client({
                                "type": "voice_updated",
                                "message": f"音色已更新为: {speaker_id or '默认音色'}"
                            })
                        else:
                            # 会话未启动，直接更新配置即可
                            logger.info("会话未启动，音色设置将在下次启动会话时应用")
                            await self._send_to_client({
                                "type": "voice_updated",
                                "message": f"音色设置已保存: {speaker_id or '默认音色'}"
                            })
                    else:
                        # 客户端未连接，更新配置中的音色设置
                        tts_config = self.config.get("tts", {})
                        tts_config["speaker_id"] = speaker_id
                        logger.info(f"客户端未连接，已更新配置中的音色设置为: {speaker_id or '默认音色'}")
                        await self._send_to_client({
                            "type": "voice_updated",
                            "message": f"音色设置已保存: {speaker_id or '默认音色'}"
                        })
        except Exception as e:
            logger.error(f"处理客户端消息时出错: {e}", exc_info=True)
    
    async def _handle_volcengine_message(self, data: dict):
        """
        处理来自火山引擎的消息
        
        Args:
            data: 火山引擎响应数据
        """
        try:
            event = data.get("event")
            text = data.get("text", "")

            # TTS 停流看门狗的时间戳：字幕事件与 TTS 事件分别记录
            if event in (350, 351, 352):
                self._last_tts_ts = time.time()
            elif 650 <= event <= 655:
                self._last_subtitle_ts = time.time()

            # 访问计量：记录 UsageResponse (154) 的 token 消耗
            if event == 154 and self.access_db and self.db_session_id and self.code_id:
                try:
                    self._record_usage_event(data)
                except Exception as e:
                    logger.error(f"记录用量失败（不影响翻译功能）: {e}")

            # 确保 text 字段存在且为字符串
            if "text" not in data:
                logger.warning(f"数据中缺少 'text' 字段: {data}")
                data["text"] = ""
            elif data["text"] is None:
                logger.warning(f"数据中 'text' 字段为 None: {data}")
                data["text"] = ""

            # 纠正 + 过滤敏感词只执行一次，会话状态与转发复用同一结果（避免重复处理）
            if data["text"]:
                original_text = data["text"]
                # 1. 纠正识别错误 2. 过滤敏感词
                corrected_text = correct_text(original_text)
                filtered_text = filter_text(corrected_text, replacement="***")
                if corrected_text != original_text:
                    logger.debug(f"文本已纠正，原始: '{original_text[:50]}...', 纠正后: '{corrected_text[:50]}...'")
                if filtered_text != corrected_text:
                    logger.debug(f"文本已过滤敏感词，原始长度: {len(corrected_text)}, 过滤后长度: {len(filtered_text)}")
                data["text"] = filtered_text
            text = data["text"]

            # 更新会话状态（直接使用已纠正 + 过滤后的文本）
            if self.session:
                if event == 651:  # SourceSubtitleResponse
                    self.session.current_source_text = text
                elif event == 652:  # SourceSubtitleEnd
                    if text:
                        if self.access_db and self.session.meeting_id:
                            self.access_db.add_meeting_segment(self.session.meeting_id, "source", text)
                        self.session.completed_source_lines.append(text)
                        if len(self.session.completed_source_lines) > self.session.max_history_lines:
                            self.session.completed_source_lines.pop(0)
                        self.session.current_source_text = ""
                elif event == 654:  # TranslationSubtitleResponse
                    self.session.current_target_text = text
                elif event == 655:  # TranslationSubtitleEnd
                    if text:
                        if self.access_db and self.session.meeting_id:
                            self.access_db.add_meeting_segment(self.session.meeting_id, "translation", text)
                        self.session.completed_target_lines.append(text)
                        if len(self.session.completed_target_lines) > self.session.max_history_lines:
                            self.session.completed_target_lines.pop(0)
                        self.session.current_target_text = ""
            
            # 记录所有重要事件的调用
            if event in [350, 351, 352, 650, 651, 652, 653, 654, 655]:
                logger.info(f"📥 _handle_volcengine_message 被调用，event={event}, text='{text[:50] if text else ''}'")
            
            # 调试：检查接收到的数据
            if event in [350, 351, 352]:  # TTS 相关事件
                event_name = {
                    350: "TTSSentenceStart",
                    351: "TTSSentenceEnd",
                    352: "TTSResponse"
                }.get(event, f"Unknown({event})")
                audio_size = data.get('data_length', 0)
                logger.info(f"🔊 转发 TTS 数据到前端: {event_name}, 音频大小: {audio_size} 字节")
                logger.debug(f"完整 data 对象: {data}")
            elif event in [650, 651, 652, 653, 654, 655]:  # 原文/译文相关事件
                event_name = {
                    650: "SourceSubtitleStart",
                    651: "SourceSubtitleResponse",
                    652: "SourceSubtitleEnd",
                    653: "TranslationSubtitleStart",
                    654: "TranslationSubtitleResponse",
                    655: "TranslationSubtitleEnd"
                }.get(event, f"Unknown({event})")
                logger.info(f"📤 转发翻译数据到前端: {event_name}, text='{text}' (类型: {type(text).__name__}, 长度: {len(text) if text else 0})")
                logger.debug(f"完整 data 对象: {data}")
            
            # 转发给控制端
            message_to_send = {
                "type": "translation",
                "data": data
            }
            
            # 调试：检查要发送的消息
            if event in [650, 651, 652, 653, 654, 655]:
                logger.debug(f"要发送的消息中 text 值: '{message_to_send['data'].get('text', 'MISSING')}'")
            
            await self._send_to_client(message_to_send)
            
            # 广播给所有查看端（仅订阅了 TTS 的查看端收到音频负载，默认不广播音频节省带宽）
            if self.session:
                tts_targets = self.session.viewer_wants_tts if data.get("data") else None
                await self.session.broadcast_to_viewers(message_to_send,
                                                        tts_client_ids=tts_targets)
            
            logger.debug(f"已发送消息到客户端并广播给查看端: event={event}")
        except Exception as e:
            logger.error(f"转发火山引擎消息时出错: {e}", exc_info=True)
    
    async def _handle_volcengine_error(self, error: Exception):
        """
        处理火山引擎错误

        Args:
            error: 错误对象
        """
        logger.error(f"火山引擎错误: {error}")
        await self._send_to_client({
            "type": "error",
            "message": f"翻译服务错误: {str(error)}"
        })

    def _record_usage_event(self, data: dict):
        """解析 UsageResponse 的计量数据并落库"""
        usage = data.get("usage") or {}
        # MessageToDict 输出驼峰键；兼容蛇形命名
        meta = usage.get("responseMeta") or usage.get("response_meta") or {}
        billing = meta.get("billing") or {}
        duration_msec = int(float(billing.get("durationMsec") or billing.get("duration_msec") or 0))
        tokens = {"input_audio_tokens": 0.0, "output_audio_tokens": 0.0, "output_text_tokens": 0.0}
        for item in billing.get("items", []):
            unit = item.get("unit", "")
            if unit in tokens:
                tokens[unit] += float(item.get("quantity") or 0)
        self.access_db.record_usage(
            self.db_session_id, self.code_id, duration_msec,
            tokens["input_audio_tokens"], tokens["output_audio_tokens"], tokens["output_text_tokens"])
        logger.info(f"📊 用量已记录: 音频 {duration_msec}ms, "
                    f"输入音频 {tokens['input_audio_tokens']}, "
                    f"输出音频 {tokens['output_audio_tokens']}, "
                    f"输出文本 {tokens['output_text_tokens']} tokens")

    # TTS 停流判定参数：字幕活跃窗口（最近 30 秒内有字幕才算"仍在说话"）
    TTS_STALL_SUBTITLE_ACTIVE_SEC = 30
    # 单连接最多自动重建次数（防止重建风暴）
    TTS_STALL_MAX_REBUILDS = 20

    def _tts_stalled(self, now: float) -> bool:
        """
        判定 TTS 是否停流：字幕仍在推进（最近 30 秒内有字幕事件），
        且距最后一次 TTS 事件（或连接建立，若从未收到 TTS）超过阈值。
        说话人停顿（无字幕推进）不算停流。
        """
        if self._last_subtitle_ts is None:
            return False  # 从未收到字幕，无从判断
        if now - self._last_subtitle_ts > self.TTS_STALL_SUBTITLE_ACTIVE_SEC:
            return False  # 字幕已停（说话人停顿），无 TTS 属正常
        baseline = self._last_tts_ts or self._controller_connected_ts
        if baseline is None:
            return False
        threshold = float(self.config.get("tts", {}).get("stall_reconnect_min", 3)) * 60
        if threshold <= 0:
            return False  # 配置为 0 表示关闭看门狗
        return now - baseline > threshold

    async def _rebuild_volcengine_session(self, reason: str):
        """重建火山引擎会话（close -> reconnect -> StartSession）"""
        self._volcengine_rebuilding = True
        try:
            logger.warning(f"🔄 重建火山引擎会话: {reason}")
            if self.access_db and self.code_id:
                try:
                    self.access_db.audit(f"code:{self.code_id}", "session_rebuild", reason)
                except Exception:
                    pass
            await self._send_to_client({
                "type": "tts_reconnecting",
                "message": f"语音输出通道异常（{reason}），正在自动恢复，字幕不受影响…"
            })
            if self.volcengine_client:
                try:
                    await self.volcengine_client.close()  # 会先发 FinishSession，冲刷计量
                except Exception:
                    pass
            await asyncio.sleep(0.5)  # 等待连接完全关闭
            await self.volcengine_client.connect()
            await self.volcengine_client.send_start_session()
            # 重建后重置基线，开启新的停流观察窗口
            self._last_tts_ts = time.time()
            self._tts_rebuild_count += 1
            logger.info(f"✓ 火山引擎会话重建成功（本连接第 {self._tts_rebuild_count} 次）")
            await self._send_to_client({
                "type": "tts_reconnected",
                "message": "语音输出已恢复"
            })
            return True
        except Exception as e:
            logger.error(f"火山引擎会话重建失败: {e}", exc_info=True)
            await self._send_to_client({
                "type": "error",
                "message": f"语音输出恢复失败: {e}，将在稍后重试"
            })
            return False
        finally:
            self._volcengine_rebuilding = False

    async def _tts_stall_watchdog(self):
        """
        TTS 停流看门狗：每 15 秒检查一次。
        长会话中若火山引擎停止下发 TTS（字幕正常显示但没有语音），
        自动重建会话恢复语音输出——这是长会话丢 TTS 问题的根治手段。
        """
        try:
            while True:
                await asyncio.sleep(15)
                try:
                    if self._volcengine_rebuilding:
                        continue
                    if not self.volcengine_client or not self.volcengine_client.connected:
                        continue
                    if self._tts_rebuild_count >= self.TTS_STALL_MAX_REBUILDS:
                        logger.error(f"TTS 自动重建已达上限（{self.TTS_STALL_MAX_REBUILDS} 次），停止看门狗")
                        return
                    if self._tts_stalled(time.time()):
                        stalled_min = 3
                        baseline = self._last_tts_ts or self._controller_connected_ts
                        if baseline:
                            stalled_min = round((time.time() - baseline) / 60, 1)
                        ok = await self._rebuild_volcengine_session(
                            f"字幕正常但已 {stalled_min} 分钟无 TTS 事件")
                        if not ok:
                            await asyncio.sleep(30)  # 重建失败后退避，避免密集重试
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(f"TTS 停流看门狗异常: {e}")
        except asyncio.CancelledError:
            pass

    async def _send_to_client(self, message: dict):
        """
        发送消息给客户端
        
        Args:
            message: 消息字典
        """
        if self.client_websocket:
            try:
                # 检查连接状态
                if hasattr(self.client_websocket, 'closed') and self.client_websocket.closed:
                    logger.warning("客户端 WebSocket 已关闭，无法发送消息")
                    return
                if hasattr(self.client_websocket, 'open') and not self.client_websocket.open:
                    logger.warning("客户端 WebSocket 未打开，无法发送消息")
                    return
                
                # 发送消息
                if hasattr(self.client_websocket, 'send_str'):
                    # send_str 是异步方法（WebSocketAdapter 中定义的）
                    await self.client_websocket.send_str(json.dumps(message))
                elif hasattr(self.client_websocket, 'send'):
                    await self.client_websocket.send(json.dumps(message))
                else:
                    logger.warning("客户端 WebSocket 对象不支持发送消息")
                
                logger.debug(f"✓ 消息已发送到客户端: {message.get('type', 'unknown')}")
            except Exception as e:
                logger.error(f"发送消息给客户端失败: {e}", exc_info=True)
        else:
            logger.warning("客户端 WebSocket 不存在，无法发送消息")


def _init_text_corrector():
    """初始化文本纠正器"""
    try:
        # 查找纠正词库文件
        config_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'config')
        correction_file = os.path.join(config_dir, 'corrections.json')
        
        # 如果文件存在，加载它
        if os.path.exists(correction_file):
            get_corrector(correction_file=correction_file)
            logger.info(f"已加载纠正词库: {correction_file}")
        else:
            # 创建默认的纠正词库文件
            default_corrections = {
                "静莹": "静音",
                # 用户可以在这里添加更多纠正规则
            }
            corrector = get_corrector(correction_dict=default_corrections)
            # 保存到文件
            corrector.save_to_file(correction_file)
            logger.info(f"已创建默认纠正词库: {correction_file}")
    except Exception as e:
        logger.error(f"初始化文本纠正器失败: {e}", exc_info=True)


def load_config():
    """加载配置文件"""
    # 初始化文本纠正器
    _init_text_corrector()
    
    # 加载主配置文件
    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "config",
        "config.json"
    )
    
    if not os.path.exists(config_path):
        logger.error(f"配置文件不存在: {config_path}")
        logger.info("请复制 config/config.example.json 为 config/config.json 并填入配置")
        sys.exit(1)
    
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)


async def main():
    """主函数"""
    # 加载配置和纠正词库
    config = load_config()
    
    # 创建服务器
    server = TranslationServer(config)
    
    # 获取服务器配置
    server_config = config["server"]
    host = server_config.get("host", "localhost")
    port = server_config.get("port", 8765)
    
    logger.info(f"启动服务器: ws://{host}:{port}")
    
    # 检查端口是否被占用
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
        sock.close()
    except OSError as e:
        if e.errno == 48:  # Address already in use
            logger.error(f"端口 {port} 已被占用！")
            logger.info("请执行以下命令查找并关闭占用端口的进程：")
            logger.info(f"  lsof -i :{port}")
            logger.info("或者修改 config/config.json 中的端口号")
            sys.exit(1)
        else:
            raise
    
    # 启动 WebSocket 服务器
    try:
        async with serve(server.handle_client, host, port):
            logger.info(f"服务器运行中，等待客户端连接...")
            await asyncio.Future()  # 永久运行
    except OSError as e:
        if e.errno == 48:
            logger.error(f"端口 {port} 已被占用！")
            logger.info("请关闭占用该端口的其他进程，或修改配置文件中的端口号")
            sys.exit(1)
        else:
            raise


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("服务器已停止")
