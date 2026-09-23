"""会后纪要生成：独立文本模型，原文为事实依据，译文仅作辅助。"""
import asyncio
import logging
import os

import aiohttp

logger = logging.getLogger(__name__)


class MinutesService:
    def __init__(self, db, config: dict):
        self.db = db
        self.config = config.get("minutes", {})
        self.tasks = set()

    @property
    def configured(self) -> bool:
        return bool(self.config.get("base_url") and self.config.get("model") and self._api_key())

    def _api_key(self) -> str:
        return os.environ.get("MINUTES_API_KEY") or self.config.get("api_key", "")

    def schedule(self, meeting_id: int) -> bool:
        meeting = self.db.get_meeting(meeting_id)
        if not meeting or not meeting["ended_at"] or meeting["status"] == "generating":
            return False
        if not self.configured:
            self.db.set_meeting_status(meeting_id, "needs_config", "请配置独立纪要模型")
            return False
        self.db.set_meeting_status(meeting_id, "generating")
        task = asyncio.create_task(self._generate(meeting_id))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return True

    async def _complete(self, messages: list) -> str:
        url = self.config["base_url"].rstrip("/") + "/chat/completions"
        timeout = aiohttp.ClientTimeout(total=int(self.config.get("timeout_sec", 120)))
        payload = {"model": self.config["model"], "messages": messages,
                   "temperature": 0.2, "max_tokens": int(self.config.get("max_tokens", 2500))}
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=payload, headers={
                "Authorization": f"Bearer {self._api_key()}"}) as response:
                response.raise_for_status()
                data = await response.json()
        content = data["choices"][0]["message"]["content"]
        if not isinstance(content, str) or not content.strip():
            raise ValueError("纪要模型返回空内容")
        return content.strip()

    async def _generate(self, meeting_id: int):
        try:
            meeting = self.db.get_meeting(meeting_id)
            segments = self.db.meeting_segments(meeting_id)
            if not any(s["kind"] == "source" for s in segments):
                self.db.set_meeting_status(meeting_id, "failed", "本场没有可用的原文定稿字幕")
                return
            rows = [f"[{s['occurred_at']}] {('原文' if s['kind'] == 'source' else '译文')}: {s['text']}"
                    for s in segments]
            chunks, current = [], []
            chunk_size = max(2000, min(int(self.config.get("chunk_chars", 12000)), 30000))
            length = 0
            for row in rows:
                if current and length + len(row) > chunk_size:
                    chunks.append("\n".join(current))
                    current, length = [], 0
                current.append(row)
                length += len(row)
            if current:
                chunks.append("\n".join(current))
            output_language = self.config.get("output_language", "中文")
            system = ("你是严谨的会议记录员。原文字幕是事实依据，译文只用于辅助理解。"
                      "不得编造决定、负责人、截止日期或发言人；不确定时明确写未确认。"
                      f"保留关键数字和专有名词；输出{output_language} Markdown，按时间戳标注关键依据。")
            notes = []
            for index, chunk in enumerate(chunks, 1):
                notes.append(await self._complete([
                    {"role": "system", "content": system},
                    {"role": "user", "content": f"第 {index}/{len(chunks)} 段会议字幕。提炼讨论、决定、待办、未解决问题：\n{chunk}"}
                ]))
            result = await self._complete([
                {"role": "system", "content": system},
                {"role": "user", "content":
                 f"会议主题：{meeting['title']}。根据以下分段记录生成完整纪要，含摘要、讨论要点、决定、待办、未解决问题。"
                 "合并重复内容，待办缺负责人或日期时留空并标未确认。\n\n" + "\n\n".join(notes)}
            ]) if len(notes) > 1 else notes[0]
            self.db.save_minutes(meeting_id, result)
        except asyncio.CancelledError:
            self.db.set_meeting_status(meeting_id, "pending", "生成任务已中断，可重试")
            raise
        except Exception as exc:
            logger.exception("生成会议 #%s 纪要失败", meeting_id)
            self.db.set_meeting_status(meeting_id, "failed", str(exc))

    async def shutdown(self):
        if self.tasks:
            await asyncio.wait(self.tasks, timeout=10)
            for task in list(self.tasks):
                task.cancel()
            if self.tasks:
                await asyncio.gather(*self.tasks, return_exceptions=True)
