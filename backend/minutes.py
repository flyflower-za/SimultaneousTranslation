"""会议纪要生成与持久化重试。原文是事实依据，译文仅辅助理解。"""
import asyncio
import logging
import os
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

import aiohttp

logger = logging.getLogger(__name__)


@dataclass
class Completion:
    content: str
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None


class PermanentModelError(Exception):
    pass


def align_segments(segments: list[dict], max_lag_sec: int = 90) -> list[dict]:
    """按各自顺序和时间窗口配对字幕；缺失译文不会整体错位。"""
    sources = [s for s in segments if s["kind"] == "source"]
    targets = [s for s in segments if s["kind"] == "translation"]
    pairs, target_index = [], 0
    for source in sources:
        source_time = datetime.fromisoformat(source["occurred_at"])
        best, best_score = None, None
        for index in range(target_index, min(target_index + 4, len(targets))):
            target = targets[index]
            wall_lag = (datetime.fromisoformat(target["occurred_at"]) - source_time).total_seconds()
            if source.get("start_ms") is not None and target.get("start_ms") is not None:
                lag = (target["start_ms"] - source["start_ms"]) / 1000
                # 重连后媒体时间会从零开始，不能跨会话只凭相同偏移量配对。
                valid = -8 <= lag <= 8 and -5 <= wall_lag <= max_lag_sec
                score = abs(lag) + (index - target_index) * 8
            else:
                lag = wall_lag
                valid = -5 <= lag <= max_lag_sec
                score = abs(lag) + (index - target_index) * 8
            if valid:
                if best_score is None or score < best_score:
                    best, best_score = index, score
        if best is None:
            pairs.append({"source": source, "translation": None})
            continue
        for skipped in targets[target_index:best]:
            pairs.append({"source": None, "translation": skipped})
        pairs.append({"source": source, "translation": targets[best]})
        target_index = best + 1
    for remaining in targets[target_index:]:
        pairs.append({"source": None, "translation": remaining})
    return pairs


def transcript_chunks(segments: list[dict], chunk_chars: int) -> list[str]:
    """以原文/译文配对为切分单位，保留时间戳与字幕 ID。"""
    chunks, current, length = [], [], 0
    for pair in align_segments(segments):
        source, target = pair["source"], pair["translation"]
        lines = []
        if source:
            lines.append(f"[S{source['id']} {source['occurred_at']}] 原文: {source['text']}")
        if target:
            lines.append(f"[T{target['id']} {target['occurred_at']}] 译文: {target['text']}")
        block = "\n".join(lines)
        if current and length + len(block) > chunk_chars:
            chunks.append("\n\n".join(current))
            current, length = [], 0
        current.append(block)
        length += len(block)
    if current:
        chunks.append("\n\n".join(current))
    return chunks


class MinutesService:
    def __init__(self, db, config: dict):
        self.db = db
        self.base_config = dict(config.get("minutes", {}))
        self.config = {}
        self.reload_settings()
        self.tasks = set()
        self.active_ids = set()
        self.worker_task = None

    def reload_settings(self):
        self.config = {**self.base_config, **self.db.get_minutes_settings()}

    def public_settings(self) -> dict:
        return {**{key: value for key, value in self.config.items() if key != "api_key"},
                "api_key_set": bool(self._api_key()),
                "api_key_from_env": bool(os.environ.get("MINUTES_API_KEY"))}

    @property
    def configured(self) -> bool:
        return bool(self.config.get("base_url") and self.config.get("model") and self._api_key())

    def _api_key(self) -> str:
        return os.environ.get("MINUTES_API_KEY") or self.config.get("api_key", "")

    def start(self):
        if self.worker_task is None:
            self.worker_task = asyncio.create_task(self._retry_worker())
        for meeting_id in self.db.pending_minutes():
            self._dispatch(meeting_id)

    def schedule(self, meeting_id: int) -> bool:
        meeting = self.db.get_meeting(meeting_id)
        if not meeting or not meeting["ended_at"] or meeting_id in self.active_ids:
            return False
        if not self.configured:
            self.db.set_meeting_status(meeting_id, "needs_config", "请配置独立纪要模型")
            return False
        self.db.queue_minutes(meeting_id)
        self._dispatch(meeting_id)
        return True

    def _dispatch(self, meeting_id: int):
        if meeting_id in self.active_ids or not self.configured:
            return
        self.active_ids.add(meeting_id)
        attempt_no = self.db.begin_minutes_attempt(meeting_id)
        settings = {**self.config, "_effective_api_key": self._api_key()}
        task = asyncio.create_task(self._generate(meeting_id, attempt_no, settings))
        self.tasks.add(task)
        task.add_done_callback(lambda done: (self.tasks.discard(done), self.active_ids.discard(meeting_id)))

    async def _retry_worker(self):
        try:
            while True:
                if self.configured:
                    for meeting_id in self.db.due_minutes():
                        self._dispatch(meeting_id)
                await asyncio.sleep(5)
        except asyncio.CancelledError:
            raise

    async def _complete(self, messages: list, settings: dict) -> Completion:
        url = settings["base_url"].rstrip("/") + "/chat/completions"
        timeout = aiohttp.ClientTimeout(total=int(settings.get("timeout_sec", 120)))
        payload = {"model": settings["model"], "messages": messages,
                   "temperature": 0.2, "max_tokens": int(settings.get("max_tokens", 2500))}
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload, headers={
                "Authorization": f"Bearer {settings['_effective_api_key']}"}) as response:
                if response.status in (400, 401, 403, 404):
                    raise PermanentModelError(f"模型接口返回 HTTP {response.status}，请检查配置")
                response.raise_for_status()
                data = await response.json()
        choice = data["choices"][0]
        content = choice["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise ValueError("纪要模型返回空内容")
        if choice.get("finish_reason") == "length":
            raise ValueError("纪要模型输出被截断，请增加 max_tokens")
        usage = data.get("usage") or {}
        return Completion(content.strip(), usage.get("prompt_tokens"), usage.get("completion_tokens"))

    async def _generate(self, meeting_id: int, attempt_no: int, settings: dict):
        try:
            meeting = self.db.get_meeting(meeting_id)
            segments = self.db.meeting_segments(meeting_id)
            if not any(s["kind"] == "source" for s in segments):
                self.db.set_meeting_status(meeting_id, "failed", "本场没有可用的原文定稿字幕")
                return
            chunk_size = max(2000, min(int(settings.get("chunk_chars", 12000)), 30000))
            chunks = transcript_chunks(segments, chunk_size)
            output_language = settings.get("output_language", "中文")
            system = ("你是严谨的会议记录员。原文字幕是事实依据，译文只用于辅助理解。"
                      "不得编造决定、负责人、截止日期或发言人；不确定时明确写未确认。"
                      f"保留关键数字和专有名词；输出{output_language} Markdown。"
                      "关键结论引用原文的 S 编号作为依据，不要将译文 T 编号当作唯一依据。")

            async def call(stage: str, messages: list) -> str:
                result = await self._complete(messages, settings)
                if isinstance(result, str):  # 兼容测试替身
                    result = Completion(result)
                input_tokens, output_tokens = result.input_tokens, result.output_tokens
                cost = None
                if input_tokens is not None and output_tokens is not None:
                    cost = (input_tokens * float(settings.get("input_per_million", 0)) +
                            output_tokens * float(settings.get("output_per_million", 0))) / 1_000_000
                self.db.record_minutes_model_call(
                    meeting_id, attempt_no, stage, settings["model"], input_tokens, output_tokens,
                    cost, settings.get("currency", "CNY"))
                return result.content

            notes = []
            for index, chunk in enumerate(chunks, 1):
                notes.append(await call(f"chunk_{index}", [
                    {"role": "system", "content": system},
                    {"role": "user", "content": f"第 {index}/{len(chunks)} 段会议字幕。提炼讨论、决定、待办、未解决问题：\n{chunk}"}
                ]))
            level = 0
            while len(notes) > 1:
                groups, group, size = [], [], 0
                for note in notes:
                    if group and size + len(note) > chunk_size:
                        groups.append(group)
                        group, size = [], 0
                    group.append(note)
                    size += len(note)
                if group:
                    groups.append(group)
                # 某个模型输出比切分上限还长时，至少两两合并以保证收敛。
                if len(groups) == len(notes):
                    groups = [notes[i:i + 2] for i in range(0, len(notes), 2)]
                merged = []
                for index, group in enumerate(groups, 1):
                    merged.append(await call(f"merge_{level}_{index}", [
                        {"role": "system", "content": system},
                        {"role": "user", "content":
                         f"会议主题：{meeting['title']}。合并以下分段纪要，保留摘要、讨论要点、决定、待办、未解决问题及证据编号。"
                         "去重；缺负责人或日期时标未确认。\n\n" + "\n\n".join(group)}
                    ]))
                notes = merged
                level += 1
            result = notes[0]
            self.db.save_minutes(meeting_id, result, actor=settings["model"], source="model")
        except asyncio.CancelledError:
            self.db.queue_minutes(meeting_id, reset_retry=False)
            raise
        except PermanentModelError as exc:
            self.db.set_meeting_status(meeting_id, "needs_config", str(exc))
        except Exception as exc:
            logger.exception("生成会议 #%s 纪要失败", meeting_id)
            max_attempts = max(1, min(int(settings.get("max_attempts", 3)), 10))
            if attempt_no < max_attempts:
                delay = min(3600, max(1, int(settings.get("retry_delay_sec", 30))) * 2 ** (attempt_no - 1))
                self.db.defer_minutes(meeting_id, str(exc), delay)
            else:
                self.db.set_meeting_status(meeting_id, "failed", str(exc))

    async def shutdown(self):
        if self.worker_task:
            self.worker_task.cancel()
            await asyncio.gather(self.worker_task, return_exceptions=True)
        if self.tasks:
            await asyncio.wait(self.tasks, timeout=10)
            for task in list(self.tasks):
                task.cancel()
            if self.tasks:
                await asyncio.gather(*self.tasks, return_exceptions=True)
