"""
火山引擎同声传译2.0 API 客户端（基于官方 demo 优化）
"""
import asyncio
import logging
import os
import platform
import sys
import uuid
from typing import Callable, Optional

import aiohttp

# Windows 系统使用 SelectorEventLoop 以支持 WebSocket 连接
if platform.system() == 'Windows':
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except AttributeError:
        # Python 3.8+ 才有 WindowsSelectorEventLoopPolicy
        pass

# 添加 protobuf 路径
# protobuf 生成的文件使用 from python_protogen.xxx 导入
# 所以需要将 backend 目录的父目录（项目根目录）添加到路径
current_dir = os.path.dirname(os.path.abspath(__file__))
backend_dir = os.path.dirname(current_dir)  # 项目根目录
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

# 导入 protobuf 模块
from google.protobuf.json_format import MessageToDict

from python_protogen.common.events_pb2 import Type
from python_protogen.products.understanding.ast.ast_service_pb2 import (
    TranslateRequest,
    TranslateResponse,
)

logger = logging.getLogger(__name__)


class VolcengineASTClient:
    """火山引擎同声传译客户端（使用 aiohttp + protobuf 协议）"""

    AST_WS_URL = "wss://openspeech.bytedance.com/api/v4/ast/v2/translate"

    def __init__(self, api_key: str, resource_id: str = "volc.service_type.10053",
                 source_lang: str = "zh", target_lang: str = "en",
                 tts_speaker_id: str = "", speech_rate: int = 0):
        """
        初始化客户端（新版控制台 X-Api-Key 鉴权）

        Args:
            api_key: API Key（火山引擎控制台获取）
            resource_id: 资源 ID
            source_lang: 源语言，默认中文
            target_lang: 目标语言，默认英文
            tts_speaker_id: TTS 说话人ID。可选公版音色：
                zh_female_vv_uranus_bigtts / zh_male_jingqiangkanye_emo_mars_bigtts；
                留空则自动复刻输入说话人音色
            speech_rate: 语速，取值 [-50, 100]，100 代表 2.0 倍速，-50 代表 0.5 倍速，0 为正常
        """
        self.api_key = api_key
        self.resource_id = resource_id
        self.source_lang = source_lang
        self.target_lang = target_lang
        self.tts_speaker_id = tts_speaker_id
        self.speech_rate = speech_rate
        self.websocket: Optional[aiohttp.ClientWebSocketResponse] = None
        self.session: Optional[aiohttp.ClientSession] = None
        self.on_message: Optional[Callable] = None
        self.on_error: Optional[Callable] = None
        self.connected = False
        self._receive_task: Optional[asyncio.Task] = None
        self.session_id: Optional[str] = None
        self.conn_id: Optional[str] = None

    async def connect(self):
        """连接到火山引擎 WebSocket API（使用 aiohttp）"""
        try:
            # 生成连接 ID（根据官方示例）
            self.conn_id = str(uuid.uuid4())

            # 鉴权：新版控制台只需 X-Api-Key + X-Api-Resource-Id
            headers = {
                "X-Api-Key": self.api_key,
                "X-Api-Resource-Id": self.resource_id,
            }

            # 记录连接信息（不记录敏感信息）
            logger.info(f"正在连接到火山引擎 API: {self.AST_WS_URL}")
            logger.debug(f"使用 Resource ID: {self.resource_id}")
            logger.debug(f"连接 ID: {self.conn_id}")

            # 创建 aiohttp 会话
            timeout = aiohttp.ClientTimeout(total=None)
            self.session = aiohttp.ClientSession(timeout=timeout)

            # 连接到 WebSocket
            self.websocket = await self.session.ws_connect(
                self.AST_WS_URL,
                headers=headers,
                max_msg_size=1000000000  # 1GB
            )
            # 记录服务端返回的 logid，便于定位问题
            # aiohttp 的 ClientWebSocketResponse 没有公开 headers 属性，
            # 响应头在内部的 _response 上，获取失败不影响连接
            try:
                response_headers = self.websocket._response.headers
                logid = response_headers.get("X-Tt-Logid")
                if logid:
                    logger.info(f"服务端 logid: {logid}")
            except AttributeError:
                pass
            self.connected = True
            logger.info("已连接到火山引擎 API")

            # 启动接收消息的任务（使用 create_task 确保任务运行）
            self._receive_task = asyncio.create_task(self._receive_messages())

        except Exception as e:
            # 检查是否是 HTTP 错误
            if hasattr(e, 'status') and e.status == 403:
                logger.error("连接被拒绝: HTTP 403")
                logger.error("可能的原因：")
                logger.error("1. API 凭证无效或过期")
                logger.error("2. 服务未开通或权限不足")
                logger.error("3. Resource ID 不正确")
                logger.error(f"   当前 Resource ID: {self.resource_id}")
                logger.error(f"   当前 API Key 长度: {len(self.api_key)}（内容已隐藏，请自行到控制台核对）")
            else:
                logger.error(f"连接失败: {e}")
                logger.error(f"错误类型: {type(e).__name__}")

            self.connected = False
            if self.on_error:
                await self.on_error(e)
            raise

    async def _receive_messages(self):
        """接收消息循环（使用 protobuf 解析）"""
        try:
            async for msg in self.websocket:
                try:
                    # aiohttp 返回的是 WSMessage 对象，需要获取数据
                    if msg.type == aiohttp.WSMsgType.BINARY:
                        message = msg.data
                    elif msg.type == aiohttp.WSMsgType.ERROR:
                        raise Exception(f"WebSocket 错误: {msg.data}")
                    else:
                        continue
                    # 解析 protobuf 消息
                    response = TranslateResponse()
                    response.ParseFromString(message)

                    # 转换为字典格式以便前端处理
                    # 将 bytes 数据转换为 base64 字符串以便 JSON 序列化
                    import base64
                    audio_data_b64 = None
                    if response.data:
                        audio_data_b64 = base64.b64encode(response.data).decode('utf-8')

                    # 提取文本内容
                    # 直接访问 response.text，确保获取到值
                    text_content = ""
                    if hasattr(response, 'text'):
                        text_content = response.text
                        # 确保是字符串类型
                        if not isinstance(text_content, str):
                            text_content = str(text_content) if text_content is not None else ""

                    # 调试日志：检查文本内容
                    if response.event in [Type.SourceSubtitleResponse, Type.TranslationSubtitleResponse]:
                        logger.info(f"🔍 原始 response.text 值: '{text_content}' (类型: {type(text_content).__name__}, 长度: {len(text_content) if text_content else 0})")
                        logger.info(f"🔍 response.text 原始值 repr: {repr(text_content)}")

                    response_dict = {
                        "event": response.event,
                        "session_id": response.response_meta.SessionID if response.response_meta else None,
                        "sequence": response.response_meta.Sequence if response.response_meta else 0,
                        "text": text_content,
                        "data": audio_data_b64,  # base64 编码的字符串
                        "data_length": len(response.data) if response.data else 0,  # 原始数据长度
                        "spk_chg": response.spk_chg,
                        "message": response.response_meta.Message if response.response_meta else None,
                        "start_time": getattr(response, 'start_time', None),
                        "end_time": getattr(response, 'end_time', None),
                    }

                    # 调试日志：检查 response_dict 中的文本
                    if response.event in [Type.SourceSubtitleResponse, Type.TranslationSubtitleResponse]:
                        logger.debug(f"response_dict['text'] 值: '{response_dict['text']}' (类型: {type(response_dict['text'])})")

                    # 如果是 UsageResponse，转换为 JSON
                    if response.event == Type.UsageResponse:
                        try:
                            usage_dict = MessageToDict(response)
                            response_dict["usage"] = usage_dict
                        except Exception as e:
                            logger.debug(f"转换 UsageResponse 失败: {e}")

                    # 记录重要事件
                    if response.event == Type.SessionStarted:
                        logger.info(f"✓ 会话已启动: {response_dict['session_id']}")
                    elif response.event == Type.SourceSubtitleResponse:
                        if response.text:
                            logger.info(f"收到原文: {response.text[:100]}...")
                    elif response.event == Type.TranslationSubtitleResponse:
                        if response.text:
                            logger.info(f"收到译文: {response.text[:100]}...")
                    elif response.event == Type.TTSResponse:
                        audio_size = response_dict.get('data_length', 0)
                        has_data = bool(response.data and len(response.data) > 0)
                        logger.info(f"🔊 收到 TTS 音频数据，大小: {audio_size} 字节，has_data: {has_data}")
                        if has_data:
                            logger.info(f"✓ TTS 音频数据有效，base64 长度: {len(response_dict.get('data', '') or '')}")
                        else:
                            logger.warning("⚠️ TTS 响应中没有音频数据")
                    elif response.event == Type.TTSSentenceStart:
                        logger.info("🔊 TTS 句子开始")
                    elif response.event == Type.TTSSentenceEnd:
                        audio_size = response_dict.get('data_length', 0)
                        logger.info(f"🔊 TTS 句子结束，音频大小: {audio_size} 字节")
                    elif response.event == Type.SessionFinished:
                        logger.info("会话已结束")
                    elif response.event == Type.SessionFailed:
                        logger.error(f"会话失败: {response_dict.get('message', '未知错误')}")

                    # 调用回调函数
                    if self.on_message:
                        if response.event in [Type.SourceSubtitleResponse, Type.TranslationSubtitleResponse]:
                            logger.info(f"📞 调用 on_message 回调，event={response.event}, text='{response_dict.get('text', '')[:50]}'")
                        await self.on_message(response_dict)
                    else:
                        logger.warning("⚠️ on_message 回调未设置！无法转发消息到前端")

                except Exception as e:
                    logger.error(f"处理消息时出错: {e}")
                    import traceback
                    logger.debug(traceback.format_exc())

        except Exception as e:
            # aiohttp WebSocket 连接关闭或错误
            if isinstance(e, aiohttp.WebSocketError):
                logger.info(f"WebSocket 连接已关闭或出错: {e}")
            else:
                logger.error(f"接收消息时出错: {e}")
            self.connected = False
            if self.on_error:
                await self.on_error(e)

    async def send_start_session(self):
        """发送 StartSession 请求（使用 protobuf）"""
        if not self.connected or not self.websocket:
            raise Exception("未连接到服务器")

        try:
            # 生成会话 ID
            self.session_id = str(uuid.uuid4())
            logger.info(f"启动会话，Session ID: {self.session_id}")

            # 构建 protobuf 请求
            request = TranslateRequest()
            request.request_meta.SessionID = self.session_id
            request.event = Type.StartSession
            request.user.uid = "ast_py_client"
            request.user.did = "ast_py_client"

            # 源音频配置
            request.source_audio.format = "wav"
            request.source_audio.rate = 16000
            request.source_audio.bits = 16
            request.source_audio.channel = 1

            # 目标音频配置（TTS 输出）
            request.target_audio.format = "ogg_opus"
            request.target_audio.rate = 24000

            # 翻译配置
            request.request.mode = "s2s"  # Speech-to-Speech
            request.request.source_language = self.source_lang
            request.request.target_language = self.target_lang

            # TTS 音色配置
            # 注意：S2S 模式下，不传 speaker_id 或传入不支持的值时，
            # 会自动复刻输入音频的说话人音色（默认行为）。
            # 当前支持的公版音色：
            #   zh_female_vv_uranus_bigtts
            #   zh_male_jingqiangkanye_emo_mars_bigtts
            if self.tts_speaker_id:
                request.request.speaker_id = self.tts_speaker_id
                logger.info(f"使用指定 TTS 音色: {self.tts_speaker_id}")
            else:
                logger.info("使用自动声音复刻模式（S2S模式会自动从输入音频中提取说话人音色特征）")

            # 语速：[-50, 100]，100 为 2.0 倍速，-50 为 0.5 倍速，0 为正常
            # 注意：当前 python_protogen 生成的 ReqParams 尚无 speech_rate 字段，
            # 需要用最新 proto 重新生成后该配置才会生效
            if self.speech_rate and hasattr(request.request, 'speech_rate'):
                request.request.speech_rate = self.speech_rate
                logger.info(f"设置 TTS 语速: {self.speech_rate}")

            # 发送 protobuf 序列化的消息
            await self.websocket.send_bytes(request.SerializeToString())
            logger.info("已发送 StartSession 请求（protobuf 格式）")

            # 等待 SessionStarted 响应（最多等待 5 秒）
            # 注意：这需要从接收消息的任务中处理，这里只是记录

        except Exception as e:
            logger.error(f"发送 StartSession 失败: {e}")
            raise

    async def send_audio(self, audio_data: bytes):
        """
        发送音频数据（使用 protobuf）
        
        Args:
            audio_data: PCM 音频数据（16kHz, 16bit, 单通道）
        """
        if not self.connected or not self.websocket:
            raise Exception("未连接到服务器")

        if not self.session_id:
            logger.warning("会话未启动，尝试启动会话...")
            await self.send_start_session()
            # 等待一小段时间让会话启动
            await asyncio.sleep(0.1)

        try:
            # 构建 protobuf 请求
            request = TranslateRequest()
            request.request_meta.SessionID = self.session_id
            request.event = Type.TaskRequest

            # 设置音频数据
            request.source_audio.binary_data = audio_data

            # 发送 protobuf 序列化的消息
            await self.websocket.send_bytes(request.SerializeToString())

            # 记录发送（每 100 次记录一次）
            if not hasattr(self, '_audio_send_count'):
                self._audio_send_count = 0
            self._audio_send_count += 1
            if self._audio_send_count == 1:
                logger.info(f"✓ 开始发送音频数据到火山引擎，第一个包大小: {len(audio_data)} 字节")
            if self._audio_send_count % 100 == 0:
                logger.debug(f"已发送 {self._audio_send_count} 个音频包到火山引擎")

        except Exception as e:
            logger.error(f"发送音频数据失败: {e}")
            raise

    async def send_finish_session(self):
        """发送 FinishSession 请求"""
        if not self.connected or not self.websocket:
            raise Exception("未连接到服务器")

        if not self.session_id:
            return  # 没有会话，无需结束

        try:
            request = TranslateRequest()
            request.request_meta.SessionID = self.session_id
            request.event = Type.FinishSession
            request.source_audio.format = "wav"  # 空音频

            await self.websocket.send_bytes(request.SerializeToString())
            logger.info("已发送 FinishSession 请求")

        except Exception as e:
            logger.error(f"发送 FinishSession 失败: {e}")
            raise

    async def close(self):
        """关闭连接"""
        # 发送结束会话请求
        if self.connected and self.session_id:
            try:
                await self.send_finish_session()
                # 给服务端最后的字幕和用量响应一个短暂的收尾窗口。
                await asyncio.sleep(0.5)
            except Exception as e:
                logger.debug(f"发送 FinishSession 失败: {e}")

        self.connected = False

        # 取消接收任务
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
            try:
                await self._receive_task
            except asyncio.CancelledError:
                pass

        # 关闭 WebSocket 连接
        if self.websocket:
            try:
                await self.websocket.close()
            except Exception as e:
                logger.debug(f"关闭 WebSocket 连接时出错: {e}")
            self.websocket = None

        # 关闭 aiohttp 会话
        if self.session:
            try:
                await self.session.close()
            except Exception as e:
                logger.debug(f"关闭 aiohttp 会话时出错: {e}")
            self.session = None

        logger.info("已断开连接")
