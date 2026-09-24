import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from backend.access_db import AccessDB, now_iso
from backend.minutes import MinutesService, Completion, align_segments, transcript_chunks
from backend.server import ROOM_REGISTRY, TranslationServer
from backend.volcengine_client import VolcengineASTClient
from backend.auth import CookieSigner, make_user_cookie, make_admin_cookie
from start_server import (api_shared_minutes, api_my_meeting, api_download_meeting,
                          api_admin_minutes_settings)


class MinutesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = AccessDB(str(Path(self.temp.name) / "minutes.db"))
        self.db._conn.execute(
            """INSERT INTO codes (id, code, applicant, email, valid_from, quota_min, created_at)
               VALUES (1, 'TESTCODE', 'Tester', 'test@example.com', ?, 60, ?)""",
            (now_iso(), now_iso()))
        self.db._conn.execute(
            """INSERT INTO codes (id, code, applicant, email, valid_from, quota_min, created_at)
               VALUES (2, 'OTHER', 'Other', 'other@example.com', ?, 60, ?)""",
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
        async def fake_complete(messages, settings):
            seen.append(messages[-1]["content"])
            return Completion("# 纪要\n周五发布。", 1000, 200)
        service._complete = fake_complete
        self.assertTrue(service.schedule(self.meeting["id"]))
        await service.shutdown()
        row = self.db.get_meeting(self.meeting["id"])
        self.assertEqual(row["status"], "draft")
        self.assertIsNone(row["published_at"])
        self.assertIn("We agreed", seen[0])
        self.assertIn("我们同意", seen[0])
        self.assertEqual(len(self.db.list_minutes_versions(self.meeting["id"])), 1)
        self.assertEqual(self.db.minutes_model_totals(self.meeting["id"])["input_tokens"], 1000)

    async def test_versions_preserve_content_and_published_snapshot(self):
        meeting_id = self.meeting["id"]
        self.db.end_meeting(meeting_id)
        self.db.save_minutes(meeting_id, "First", actor="admin")
        self.db.publish_minutes(meeting_id, True)
        self.assertEqual(self.db.published_minutes(meeting_id), "First")
        self.db.publish_minutes(meeting_id, False)
        self.db.save_minutes(meeting_id, "Second", actor="admin")
        versions = self.db.list_minutes_versions(meeting_id)
        self.assertEqual([v["version_no"] for v in versions], [2, 1])
        self.assertEqual(self.db.get_minutes_version(meeting_id, versions[1]["id"])["content"], "First")
        self.assertIsNone(self.db.published_minutes(meeting_id))

    async def test_alignment_uses_media_time_and_keeps_unmatched_lines(self):
        segments = [
            {"id": 1, "kind": "source", "text": "one", "occurred_at": "2026-01-01T10:00:00", "start_ms": 1000},
            {"id": 2, "kind": "source", "text": "two", "occurred_at": "2026-01-01T10:00:02", "start_ms": 20000},
            {"id": 3, "kind": "translation", "text": "二", "occurred_at": "2026-01-01T10:00:03", "start_ms": 20000},
        ]
        pairs = align_segments(segments)
        self.assertIsNone(pairs[0]["translation"])
        self.assertEqual(pairs[1]["translation"]["text"], "二")
        chunks = transcript_chunks(segments, 2000)
        self.assertIn("[S2", chunks[0])
        self.assertIn("[T3", chunks[0])

    async def test_model_cost_and_retry_state(self):
        meeting_id = self.meeting["id"]
        self.db.add_meeting_segment(meeting_id, "source", "Decision")
        self.db.end_meeting(meeting_id)
        service = MinutesService(self.db, {"minutes": {"base_url": "http://unused/v1",
            "model": "fake", "api_key": "test", "max_attempts": 2, "retry_delay_sec": 1,
            "input_per_million": 2, "output_per_million": 4}})
        calls = 0
        async def fake_complete(messages, settings):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("temporary")
            return Completion("Decision summary", 1000, 500)
        service._complete = fake_complete
        self.assertTrue(service.schedule(meeting_id))
        await asyncio.sleep(0.05)
        self.assertEqual(self.db.get_meeting(meeting_id)["status"], "retry_wait")
        await asyncio.sleep(1.1)
        service._dispatch(meeting_id)
        await service.shutdown()
        self.assertEqual(self.db.get_meeting(meeting_id)["status"], "draft")
        self.assertAlmostEqual(self.db.minutes_model_totals(meeting_id)["cost"], 0.004)

    async def test_long_meeting_merges_chunk_notes(self):
        meeting_id = self.meeting["id"]
        for index in range(4):
            self.db.add_meeting_segment(meeting_id, "source", f"Decision {index}: " + "detail " * 400)
        self.db.end_meeting(meeting_id)
        service = MinutesService(self.db, {"minutes": {"base_url": "http://unused/v1",
            "model": "fake", "api_key": "test", "chunk_chars": 2000}})
        prompts = []
        async def fake_complete(messages, settings):
            prompts.append(messages[-1]["content"])
            return Completion("# Summary\nDecision preserved [S1]", 30, 10)
        service._complete = fake_complete
        self.assertTrue(service.schedule(meeting_id))
        await service.shutdown()
        calls = self.db.minutes_model_calls(meeting_id)
        self.assertGreater(len([c for c in calls if c["stage"].startswith("chunk_")]), 1)
        self.assertTrue(any(c["stage"].startswith("merge_") for c in calls))
        self.assertIn("[S1]", self.db.get_meeting(meeting_id)["minutes_text"])

    async def test_owner_scope_pdf_and_model_settings_redaction(self):
        meeting_id = self.meeting["id"]
        self.db.end_meeting(meeting_id)
        self.db.save_minutes(meeting_id, "# 结论\n周五发布")
        signer = CookieSigner("test-secret")
        service = MinutesService(self.db, {"minutes": {"api_key": "hidden", "model": "test"}})
        app = web.Application()
        app["ctx"] = SimpleNamespace(db=self.db, signer=signer, minutes=service)
        app.router.add_get("/api/my/meetings/{id:\\d+}", api_my_meeting)
        app.router.add_get("/api/my/meetings/{id:\\d+}/download", api_download_meeting)
        app.router.add_get("/api/admin/minutes-settings", api_admin_minutes_settings)
        app.router.add_post("/api/admin/minutes-settings", api_admin_minutes_settings)
        async with TestClient(TestServer(app)) as client:
            client.session.cookie_jar.update_cookies({"st_access": make_user_cookie(signer, 1)["value"]})
            self.assertEqual((await client.get(f"/api/my/meetings/{meeting_id}")).status, 200)
            pdf = await client.get(f"/api/my/meetings/{meeting_id}/download?format=pdf")
            self.assertEqual((await pdf.read())[:4], b"%PDF")
            client.session.cookie_jar.update_cookies({"st_access": make_user_cookie(signer, 2)["value"]})
            self.assertEqual((await client.get(f"/api/my/meetings/{meeting_id}")).status, 404)
            client.session.cookie_jar.update_cookies({"st_admin": make_admin_cookie(signer)["value"]})
            settings = await (await client.get('/api/admin/minutes-settings')).json()
            self.assertNotIn('api_key', settings['settings'])
            self.assertTrue(settings['settings']['api_key_set'])
            response = await client.post('/api/admin/minutes-settings', json={
                'base_url': 'https://models.example/v1', 'model': 'minutes-v2',
                'api_key': 'new-secret', 'timeout_sec': 30, 'chunk_chars': 4000,
                'max_tokens': 1000, 'max_attempts': 3, 'retry_delay_sec': 5,
                'input_per_million': 2, 'output_per_million': 4})
            self.assertEqual(response.status, 200)
            self.assertNotIn('new-secret', await response.text())
            self.assertEqual(self.db.get_minutes_settings()['api_key'], 'new-secret')
            response = await client.post('/api/admin/minutes-settings', json={
                'base_url': 'file:///tmp/model', 'model': 'bad'})
            self.assertEqual(response.status, 400)

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
