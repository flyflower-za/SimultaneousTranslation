import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from backend.access_db import AccessDB, now_iso
from backend.minutes import MinutesService
from backend.server import ROOM_REGISTRY, TranslationServer
from backend.volcengine_client import VolcengineASTClient
from start_server import api_shared_minutes


class MinutesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = AccessDB(str(Path(self.temp.name) / "minutes.db"))
        self.db._conn.execute(
            """INSERT INTO codes (id, code, applicant, email, valid_from, quota_min, created_at)
               VALUES (1, 'TESTCODE', 'Tester', 'test@example.com', ?, 60, ?)""",
            (now_iso(), now_iso()))
        self.db._conn.commit()
        self.meeting = self.db.create_meeting("ROOM01", 1, "Test", "en", "zh")

    async def asyncTearDown(self):
        self.db.close()
        self.temp.cleanup()

    async def test_generation_uses_final_segments_and_draft_requires_publication(self):
        self.db.add_meeting_segment(self.meeting["id"], "source", "We agreed to launch on Friday.")
        self.db.add_meeting_segment(self.meeting["id"], "translation", "我们同意周五发布。")
        self.assertTrue(self.db.end_meeting(self.meeting["id"]))
        self.assertFalse(self.db.end_meeting(self.meeting["id"]))
        service = MinutesService(self.db, {"minutes": {"base_url": "http://unused/v1",
                                                     "model": "fake", "api_key": "test"}})
        seen = []
        async def fake_complete(messages):
            seen.append(messages[-1]["content"])
            return "# 纪要\n周五发布。"
        service._complete = fake_complete
        self.assertTrue(service.schedule(self.meeting["id"]))
        await service.shutdown()
        row = self.db.get_meeting(self.meeting["id"])
        self.assertEqual(row["status"], "draft")
        self.assertIsNone(row["published_at"])
        self.assertIn("We agreed", seen[0])
        self.assertIn("我们同意", seen[0])

    async def test_share_only_exposes_published_minutes_and_can_be_revoked(self):
        self.db.end_meeting(self.meeting["id"])
        self.db.save_minutes(self.meeting["id"], "Private draft")
        app = web.Application()
        app["ctx"] = SimpleNamespace(db=self.db)
        app.router.add_get("/api/share/{token}", api_shared_minutes)
        async with TestClient(TestServer(app)) as client:
            path = f"/api/share/{self.meeting['share_token']}"
            result = await (await client.get(path)).json()
            self.assertNotIn("minutes_text", result["meeting"])
            self.db.publish_minutes(self.meeting["id"], True)
            result = await (await client.get(path)).json()
            self.assertEqual(result["meeting"]["minutes_text"], "Private draft")
            self.db.revoke_meeting_share(self.meeting["id"])
            self.assertEqual((await client.get(path)).status, 404)

    async def test_other_access_code_cannot_take_over_room(self):
        room, _ = ROOM_REGISTRY.get_or_create("ROOM01", {})
        room.owner_code_id = 1
        try:
            server = TranslationServer({}, code_id=2, room_id="ROOM01")
            with self.assertRaises(PermissionError):
                await server.handle_client(None)
        finally:
            ROOM_REGISTRY._rooms.pop("ROOM01", None)

    async def test_upstream_finish_is_sent_while_connected(self):
        client = VolcengineASTClient("test")
        client.connected = True
        client.session_id = "session"
        called = []
        async def finish():
            called.append(client.connected)
        class FakeSocket:
            async def close(self):
                pass
        client.send_finish_session = finish
        client.websocket = FakeSocket()
        await client.close()
        self.assertEqual(called, [True])
