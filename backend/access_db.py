"""
访问控制数据层：申请、访问码、会话、用量计量、审计日志（SQLite）
"""
import json
import logging
import os
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger(__name__)

# 访问码字符集：去掉易混淆字符 0/O/1/I/L
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


class AccessDB:
    """访问控制数据库（SQLite 单文件，WAL 模式）"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        # 纪要模型密钥和会议记录保存在此库中，限制其他系统用户读取。
        if os.name == "posix":
            for path in (db_path, db_path + "-wal", db_path + "-shm"):
                if os.path.exists(path):
                    os.chmod(path, 0o600)
        # 多进程/多连接共享同一库文件时避免立即抛 database is locked
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._create_tables()

    def _create_tables(self):
        with self._lock, self._conn:
            self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS requests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                applicant TEXT NOT NULL,
                email TEXT NOT NULL,
                department TEXT DEFAULT '',
                topic TEXT DEFAULT '',
                planned_start TEXT NOT NULL,
                planned_duration_min INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                reviewed_at TEXT,
                reviewed_by TEXT,
                reject_reason TEXT,
                code_id INTEGER
            );
            CREATE TABLE IF NOT EXISTS codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT NOT NULL UNIQUE,
                request_id INTEGER,
                applicant TEXT NOT NULL,
                email TEXT NOT NULL,
                department TEXT DEFAULT '',
                topic TEXT DEFAULT '',
                valid_from TEXT NOT NULL,
                valid_until TEXT,
                quota_min INTEGER NOT NULL,
                used_sec REAL NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active',
                email_status TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code_id INTEGER NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                wall_sec REAL NOT NULL DEFAULT 0,
                duration_msec INTEGER NOT NULL DEFAULT 0,
                input_audio_tokens REAL NOT NULL DEFAULT 0,
                output_audio_tokens REAL NOT NULL DEFAULT 0,
                output_text_tokens REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                code_id INTEGER NOT NULL,
                ts TEXT NOT NULL,
                duration_msec INTEGER DEFAULT 0,
                input_audio_tokens REAL DEFAULT 0,
                output_audio_tokens REAL DEFAULT 0,
                output_text_tokens REAL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                actor TEXT DEFAULT '',
                action TEXT NOT NULL,
                detail TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(code_id);
            CREATE INDEX IF NOT EXISTS idx_usage_code ON usage_events(code_id);
            CREATE TABLE IF NOT EXISTS meetings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_id TEXT NOT NULL,
                code_id INTEGER NOT NULL,
                share_token TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL DEFAULT '',
                source_language TEXT NOT NULL DEFAULT 'zh',
                target_language TEXT NOT NULL DEFAULT 'en',
                started_at TEXT NOT NULL,
                ended_at TEXT,
                status TEXT NOT NULL DEFAULT 'recording',
                minutes_text TEXT NOT NULL DEFAULT '',
                error TEXT NOT NULL DEFAULT '',
                published_at TEXT,
                share_revoked_at TEXT
            );
            CREATE TABLE IF NOT EXISTS meeting_segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id INTEGER NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('source', 'translation')),
                text TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                start_ms INTEGER,
                end_ms INTEGER,
                sequence_no INTEGER,
                FOREIGN KEY(meeting_id) REFERENCES meetings(id)
            );
            CREATE INDEX IF NOT EXISTS idx_meetings_code ON meetings(code_id, id);
            CREATE INDEX IF NOT EXISTS idx_meetings_room ON meetings(room_id, id);
            CREATE INDEX IF NOT EXISTS idx_segments_meeting ON meeting_segments(meeting_id, id);
            CREATE TABLE IF NOT EXISTS minutes_versions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id INTEGER NOT NULL,
                version_no INTEGER NOT NULL,
                content TEXT NOT NULL,
                actor TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at TEXT NOT NULL,
                published_at TEXT,
                UNIQUE(meeting_id, version_no)
            );
            CREATE INDEX IF NOT EXISTS idx_minutes_versions_meeting ON minutes_versions(meeting_id, version_no);
            CREATE TABLE IF NOT EXISTS minutes_model_calls (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meeting_id INTEGER NOT NULL,
                attempt_no INTEGER NOT NULL,
                stage TEXT NOT NULL,
                model TEXT NOT NULL,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cost REAL,
                currency TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_minutes_calls_meeting ON minutes_model_calls(meeting_id, id);
            CREATE TABLE IF NOT EXISTS minutes_settings (
                id INTEGER PRIMARY KEY CHECK(id = 1),
                payload TEXT NOT NULL
            );
            """)
            columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(meetings)")}
            for name, definition in {
                "retry_count": "INTEGER NOT NULL DEFAULT 0",
                "next_retry_at": "TEXT",
                "published_version_id": "INTEGER",
            }.items():
                if name not in columns:
                    self._conn.execute(f"ALTER TABLE meetings ADD COLUMN {name} {definition}")
            segment_columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(meeting_segments)")}
            for name in ("start_ms", "end_ms", "sequence_no"):
                if name not in segment_columns:
                    self._conn.execute(f"ALTER TABLE meeting_segments ADD COLUMN {name} INTEGER")
            call_columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(minutes_model_calls)")}
            if "currency" not in call_columns:
                self._conn.execute("ALTER TABLE minutes_model_calls ADD COLUMN currency TEXT")
            # 从第一版升级：为已有草稿补一条初始版本，保留已发布状态。
            for row in self._conn.execute(
                    """SELECT id, minutes_text, started_at, published_at FROM meetings
                       WHERE minutes_text != '' AND NOT EXISTS
                       (SELECT 1 FROM minutes_versions v WHERE v.meeting_id = meetings.id)""").fetchall():
                cur = self._conn.execute(
                    """INSERT INTO minutes_versions
                       (meeting_id, version_no, content, actor, source, created_at, published_at)
                       VALUES (?, 1, ?, 'migration', 'legacy', ?, ?)""",
                    (row["id"], row["minutes_text"], row["started_at"], row["published_at"]))
                if row["published_at"]:
                    self._conn.execute("UPDATE meetings SET published_version_id = ? WHERE id = ?",
                                       (cur.lastrowid, row["id"]))

    # ---------- 审计 ----------

    # ---------- 会议纪要 ----------

    def create_meeting(self, room_id: str, code_id: int, title: str,
                       source_language: str, target_language: str) -> dict:
        token = secrets.token_urlsafe(32)
        with self._lock, self._conn:
            cur = self._conn.execute(
                """INSERT INTO meetings (room_id, code_id, share_token, title,
                   source_language, target_language, started_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (room_id, code_id, token, title, source_language, target_language, now_iso()))
            return dict(self._conn.execute(
                "SELECT * FROM meetings WHERE id = ?", (cur.lastrowid,)).fetchone())

    def get_meeting(self, meeting_id: int):
        row = self._conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        return dict(row) if row else None

    def get_open_meeting(self, room_id: str, code_id: int):
        row = self._conn.execute(
            """SELECT * FROM meetings WHERE room_id = ? AND code_id = ?
               AND ended_at IS NULL ORDER BY id DESC LIMIT 1""", (room_id, code_id)).fetchone()
        return dict(row) if row else None

    def latest_shared_meeting_for_code(self, code_id: int):
        row = self._conn.execute(
            """SELECT * FROM meetings WHERE code_id = ? AND share_revoked_at IS NULL
               ORDER BY id DESC LIMIT 1""", (code_id,)).fetchone()
        return dict(row) if row else None

    def get_shared_meeting(self, token: str):
        row = self._conn.execute(
            "SELECT * FROM meetings WHERE share_token = ? AND share_revoked_at IS NULL",
            (token,)).fetchone()
        return dict(row) if row else None

    def list_meetings(self, code_id=None, limit=100):
        if code_id is None:
            rows = self._conn.execute(
                """SELECT m.*, c.applicant FROM meetings m JOIN codes c ON c.id = m.code_id
                   ORDER BY m.id DESC LIMIT ?""", (limit,)).fetchall()
        else:
            rows = self._conn.execute(
                """SELECT m.*, c.applicant FROM meetings m JOIN codes c ON c.id = m.code_id
                   WHERE m.code_id = ? ORDER BY m.id DESC LIMIT ?""", (code_id, limit)).fetchall()
        return [dict(row) for row in rows]

    def list_minutes_versions(self, meeting_id: int):
        return [dict(row) for row in self._conn.execute(
            """SELECT id, meeting_id, version_no, actor, source, created_at, published_at
               FROM minutes_versions WHERE meeting_id = ? ORDER BY version_no DESC""",
            (meeting_id,)).fetchall()]

    def get_minutes_version(self, meeting_id: int, version_id: int):
        row = self._conn.execute(
            "SELECT * FROM minutes_versions WHERE meeting_id = ? AND id = ?",
            (meeting_id, version_id)).fetchone()
        return dict(row) if row else None

    def published_minutes(self, meeting_id: int):
        row = self._conn.execute(
            """SELECT v.content FROM meetings m JOIN minutes_versions v
               ON v.id = m.published_version_id WHERE m.id = ? AND m.published_at IS NOT NULL""",
            (meeting_id,)).fetchone()
        return row["content"] if row else None

    def add_meeting_segment(self, meeting_id: int, kind: str, text: str,
                            start_ms=None, end_ms=None, sequence_no=None):
        if kind not in ("source", "translation") or not text:
            return
        with self._lock, self._conn:
            self._conn.execute(
                """INSERT INTO meeting_segments
                   (meeting_id, kind, text, occurred_at, start_ms, end_ms, sequence_no)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (meeting_id, kind, text, datetime.now().isoformat(timespec="milliseconds"),
                 start_ms, end_ms, sequence_no))

    def meeting_segments(self, meeting_id: int):
        return [dict(row) for row in self._conn.execute(
            "SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY id", (meeting_id,)).fetchall()]

    def end_meeting(self, meeting_id: int) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute(
                """UPDATE meetings SET ended_at = ?, status = 'pending'
                   WHERE id = ? AND ended_at IS NULL""", (now_iso(), meeting_id))
            return cur.rowcount > 0

    def end_orphan_meetings(self) -> list[int]:
        """单进程重启后补齐未正常收尾的会议。"""
        with self._lock, self._conn:
            rows = self._conn.execute("SELECT id FROM meetings WHERE ended_at IS NULL").fetchall()
            ids = [row["id"] for row in rows]
            self._conn.execute(
                "UPDATE meetings SET ended_at = ?, status = 'pending' WHERE ended_at IS NULL",
                (now_iso(),))
            return ids

    def pending_minutes(self) -> list[int]:
        with self._lock, self._conn:
            self._conn.execute("UPDATE meetings SET status = 'pending' WHERE status = 'generating'")
            rows = self._conn.execute(
                """SELECT id FROM meetings WHERE ended_at IS NOT NULL
                   AND status = 'pending'""").fetchall()
            return [row["id"] for row in rows]

    def due_minutes(self) -> list[int]:
        return [row["id"] for row in self._conn.execute(
            """SELECT id FROM meetings WHERE ended_at IS NOT NULL
               AND (status = 'pending' OR (status = 'retry_wait' AND next_retry_at <= ?))
               ORDER BY id LIMIT 50""", (now_iso(),)).fetchall()]

    def minutes_needing_config(self) -> list[int]:
        return [row["id"] for row in self._conn.execute(
            """SELECT id FROM meetings WHERE ended_at IS NOT NULL
               AND status = 'needs_config' ORDER BY id LIMIT 100""").fetchall()]

    def queue_minutes(self, meeting_id: int, reset_retry: bool = True):
        with self._lock, self._conn:
            self._conn.execute(
                """UPDATE meetings SET status = 'pending', error = '', next_retry_at = NULL,
                   retry_count = CASE WHEN ? THEN 0 ELSE retry_count END WHERE id = ?""",
                (1 if reset_retry else 0, meeting_id))

    def begin_minutes_attempt(self, meeting_id: int) -> int:
        with self._lock, self._conn:
            self._conn.execute(
                """UPDATE meetings SET status = 'generating', retry_count = retry_count + 1,
                   next_retry_at = NULL WHERE id = ?""", (meeting_id,))
            return self._conn.execute("SELECT retry_count FROM meetings WHERE id = ?",
                                      (meeting_id,)).fetchone()[0]

    def defer_minutes(self, meeting_id: int, error: str, delay_sec: int):
        retry_at = (datetime.now() + timedelta(seconds=delay_sec)).isoformat(timespec="seconds")
        with self._lock, self._conn:
            self._conn.execute(
                """UPDATE meetings SET status = 'retry_wait', error = ?, next_retry_at = ?
                   WHERE id = ?""", (error[:500], retry_at, meeting_id))

    def record_minutes_model_call(self, meeting_id: int, attempt_no: int, stage: str,
                                  model: str, input_tokens, output_tokens, cost,
                                  currency: str = "CNY"):
        with self._lock, self._conn:
            self._conn.execute(
                """INSERT INTO minutes_model_calls
                   (meeting_id, attempt_no, stage, model, input_tokens, output_tokens, cost, currency, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (meeting_id, attempt_no, stage, model, input_tokens, output_tokens, cost,
                 currency, now_iso()))

    def minutes_model_calls(self, meeting_id: int):
        return [dict(row) for row in self._conn.execute(
            "SELECT * FROM minutes_model_calls WHERE meeting_id = ? ORDER BY id",
            (meeting_id,)).fetchall()]

    def minutes_model_totals(self, meeting_id: int):
        row = self._conn.execute(
            """SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
               SUM(cost) AS cost, COUNT(*) AS calls FROM minutes_model_calls WHERE meeting_id = ?""",
            (meeting_id,)).fetchone()
        totals = dict(row)
        totals["costs"] = [dict(item) for item in self._conn.execute(
            """SELECT COALESCE(currency, 'CNY') AS currency, SUM(cost) AS cost
               FROM minutes_model_calls WHERE meeting_id = ? AND cost IS NOT NULL
               GROUP BY COALESCE(currency, 'CNY') ORDER BY currency""",
            (meeting_id,)).fetchall()]
        return totals

    def get_minutes_settings(self) -> dict:
        row = self._conn.execute("SELECT payload FROM minutes_settings WHERE id = 1").fetchone()
        return json.loads(row["payload"]) if row else {}

    def save_minutes_settings(self, settings: dict):
        with self._lock, self._conn:
            self._conn.execute(
                """INSERT INTO minutes_settings (id, payload) VALUES (1, ?)
                   ON CONFLICT(id) DO UPDATE SET payload = excluded.payload""",
                (json.dumps(settings, ensure_ascii=False),))

    def set_meeting_status(self, meeting_id: int, status: str, error: str = ""):
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE meetings SET status = ?, error = ? WHERE id = ?",
                (status, error[:500], meeting_id))

    def save_minutes(self, meeting_id: int, text: str, actor: str = "admin",
                     source: str = "manual"):
        with self._lock, self._conn:
            version_no = self._conn.execute(
                "SELECT COALESCE(MAX(version_no), 0) + 1 FROM minutes_versions WHERE meeting_id = ?",
                (meeting_id,)).fetchone()[0]
            self._conn.execute(
                """INSERT INTO minutes_versions
                   (meeting_id, version_no, content, actor, source, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (meeting_id, version_no, text, actor, source, now_iso()))
            self._conn.execute(
                """UPDATE meetings SET minutes_text = ?, status = 'draft', error = '',
                   published_at = NULL, published_version_id = NULL WHERE id = ?""", (text, meeting_id))

    def publish_minutes(self, meeting_id: int, publish: bool):
        with self._lock, self._conn:
            if publish:
                version = self._conn.execute(
                    """SELECT id FROM minutes_versions WHERE meeting_id = ?
                       ORDER BY version_no DESC LIMIT 1""", (meeting_id,)).fetchone()
                if not version:
                    raise ValueError("纪要没有可发布版本")
                ts = now_iso()
                self._conn.execute(
                    "UPDATE meetings SET published_at = ?, published_version_id = ? WHERE id = ?",
                    (ts, version["id"], meeting_id))
                self._conn.execute("UPDATE minutes_versions SET published_at = ? WHERE id = ?",
                                   (ts, version["id"]))
            else:
                self._conn.execute(
                    "UPDATE meetings SET published_at = NULL, published_version_id = NULL WHERE id = ?",
                    (meeting_id,))

    def revoke_meeting_share(self, meeting_id: int):
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE meetings SET share_revoked_at = ? WHERE id = ?",
                (now_iso(), meeting_id))

    def delete_meeting(self, meeting_id: int):
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM meeting_segments WHERE meeting_id = ?", (meeting_id,))
            self._conn.execute("DELETE FROM minutes_versions WHERE meeting_id = ?", (meeting_id,))
            self._conn.execute("DELETE FROM minutes_model_calls WHERE meeting_id = ?", (meeting_id,))
            self._conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))

    def audit(self, actor: str, action: str, detail: str = ""):
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)",
                (now_iso(), actor, action, detail))

    # ---------- 申请 ----------

    def create_request(self, applicant: str, email: str, department: str, topic: str,
                       planned_start: str, planned_duration_min: int) -> int:
        with self._lock, self._conn:
            cur = self._conn.execute(
                """INSERT INTO requests (applicant, email, department, topic,
                   planned_start, planned_duration_min, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)""",
                (applicant, email, department, topic,
                 planned_start, planned_duration_min, now_iso()))
            return cur.lastrowid

    def get_request(self, request_id: int) -> Optional[sqlite3.Row]:
        return self._conn.execute(
            "SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()

    def list_requests(self, status: Optional[str] = None,
                       q: Optional[str] = None,
                       limit: Optional[int] = None,
                       offset: int = 0) -> list:
        where, params = [], []
        if status:
            where.append("status = ?"); params.append(status)
        if q:
            where.append("(applicant LIKE ? OR email LIKE ? OR topic LIKE ?)")
            like = f"%{q}%"; params.extend([like, like, like])
        sql = "SELECT * FROM requests"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC"
        if limit is not None and limit > 0:
            sql += " LIMIT ? OFFSET ?"; params.extend([limit, offset])
        return self._conn.execute(sql, params).fetchall()

    def count_requests(self, status: Optional[str] = None,
                       q: Optional[str] = None) -> int:
        where, params = [], []
        if status == "done":
            where.append("status != 'pending'")
        elif status:
            where.append("status = ?"); params.append(status)
        if q:
            where.append("(applicant LIKE ? OR email LIKE ? OR topic LIKE ?)")
            like = f"%{q}%"; params.extend([like, like, like])
        sql = "SELECT COUNT(*) AS c FROM requests"
        if where:
            sql += " WHERE " + " AND ".join(where)
        return self._conn.execute(sql, params).fetchone()["c"]

    def has_pending_request_from(self, email: str) -> bool:
        row = self._conn.execute(
            "SELECT COUNT(*) AS c FROM requests WHERE email = ? AND status = 'pending'",
            (email,)).fetchone()
        return row["c"] > 0

    # ---------- 访问码 ----------

    def _generate_code(self) -> str:
        while True:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
            if not self._conn.execute(
                    "SELECT 1 FROM codes WHERE code = ?", (code,)).fetchone():
                return code

    def approve_request(self, request_id: int, reviewed_by: str,
                        valid_before_start_min: int = 120) -> Optional[sqlite3.Row]:
        """审批通过：生成访问码。有效时间窗 = 计划开始时间提前 N 分钟生效，结束不限制。"""
        with self._lock, self._conn:
            req = self._conn.execute(
                "SELECT * FROM requests WHERE id = ?", (request_id,)).fetchone()
            if not req or req["status"] != "pending":
                return None
            valid_from = (datetime.fromisoformat(req["planned_start"])
                          - timedelta(minutes=valid_before_start_min)).isoformat(timespec="seconds")
            code = self._generate_code()
            cur = self._conn.execute(
                """INSERT INTO codes (code, request_id, applicant, email, department, topic,
                   valid_from, valid_until, quota_min, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'active', ?)""",
                (code, request_id, req["applicant"], req["email"], req["department"],
                 req["topic"], valid_from, req["planned_duration_min"], now_iso()))
            code_id = cur.lastrowid
            self._conn.execute(
                "UPDATE requests SET status = 'approved', reviewed_at = ?, reviewed_by = ?, code_id = ? WHERE id = ?",
                (now_iso(), reviewed_by, code_id, request_id))
            return self._conn.execute(
                "SELECT * FROM codes WHERE id = ?", (code_id,)).fetchone()

    def reject_request(self, request_id: int, reviewed_by: str, reason: str = ""):
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE requests SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, reject_reason = ? WHERE id = ? AND status = 'pending'",
                (now_iso(), reviewed_by, reason, request_id))

    def get_code_by_value(self, code: str) -> Optional[sqlite3.Row]:
        return self._conn.execute(
            "SELECT * FROM codes WHERE code = ?", (code,)).fetchone()

    def get_code(self, code_id: int) -> Optional[sqlite3.Row]:
        return self._conn.execute(
            "SELECT * FROM codes WHERE id = ?", (code_id,)).fetchone()

    def check_code_validity(self, code_row) -> tuple:
        """返回 (是否有效, 原因)。规则：active 且当前时间 >= valid_from（结束不限制）。
        预计时长仅作为用量参考，不做额度限制。"""
        if code_row["status"] == "revoked":
            return False, "访问码已被撤销"
        now = datetime.now()
        valid_from = datetime.fromisoformat(code_row["valid_from"])
        if now < valid_from:
            return False, f"访问码尚未生效（{valid_from.strftime('%m-%d %H:%M')} 起可用）"
        if code_row["valid_until"]:
            if now > datetime.fromisoformat(code_row["valid_until"]):
                return False, "访问码已过期"
        return True, ""

    def set_code_status(self, code_id: int, status: str):
        with self._lock, self._conn:
            self._conn.execute("UPDATE codes SET status = ? WHERE id = ?", (status, code_id))

    def set_code_email_status(self, code_id: int, status: str):
        with self._lock, self._conn:
            self._conn.execute("UPDATE codes SET email_status = ? WHERE id = ?", (status, code_id))

    def list_codes(self, status: Optional[str] = None,
                    q: Optional[str] = None,
                    limit: Optional[int] = None,
                    offset: int = 0) -> list:
        where, params = [], []
        if status:
            where.append("status = ?"); params.append(status)
        if q:
            where.append("(code LIKE ? OR applicant LIKE ? OR email LIKE ? OR topic LIKE ?)")
            like = f"%{q}%"; params.extend([like, like, like, like])
        sql = "SELECT * FROM codes"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC"
        if limit is not None and limit > 0:
            sql += " LIMIT ? OFFSET ?"; params.extend([limit, offset])
        return self._conn.execute(sql, params).fetchall()

    def count_codes(self, status: Optional[str] = None,
                    q: Optional[str] = None) -> int:
        where, params = [], []
        if status:
            where.append("status = ?"); params.append(status)
        if q:
            where.append("(code LIKE ? OR applicant LIKE ? OR email LIKE ? OR topic LIKE ?)")
            like = f"%{q}%"; params.extend([like, like, like, like])
        sql = "SELECT COUNT(*) AS c FROM codes"
        if where:
            sql += " WHERE " + " AND ".join(where)
        return self._conn.execute(sql, params).fetchone()["c"]

    # ---------- 会话与用量 ----------

    def start_session(self, code_id: int) -> int:
        with self._lock, self._conn:
            cur = self._conn.execute(
                "INSERT INTO sessions (code_id, started_at) VALUES (?, ?)",
                (code_id, now_iso()))
            return cur.lastrowid

    def end_session(self, session_id: int):
        with self._lock, self._conn:
            self.tick_session(session_id, _locked=True)
            self._conn.execute(
                "UPDATE sessions SET ended_at = ? WHERE id = ?", (now_iso(), session_id))

    def tick_session(self, session_id: int, _locked: bool = False):
        """按墙钟更新会话时长，并同步刷新访问码累计用量（= 该码所有会话时长之和）

        时长统一用 Python 本地时间计算（started_at 与当前时间均为本地 ISO 字符串），
        不再混用 SQLite 的 julianday('now','localtime') 解析 Python 时间戳，
        避免时区/夏令时切换或字符串解析差异导致时长算错。
        """
        def _do():
            row = self._conn.execute(
                "SELECT started_at FROM sessions WHERE id = ? AND ended_at IS NULL",
                (session_id,)).fetchone()
            if not row:
                return
            try:
                elapsed = (datetime.now() - datetime.fromisoformat(row["started_at"])).total_seconds()
            except ValueError:
                logger.warning(f"会话 #{session_id} 的 started_at 格式异常，跳过时长刷新: {row['started_at']!r}")
                return
            self._conn.execute(
                "UPDATE sessions SET wall_sec = ? WHERE id = ?",
                (max(0.0, elapsed), session_id))
            self._conn.execute(
                """UPDATE codes SET used_sec = (
                       SELECT COALESCE(SUM(wall_sec), 0) FROM sessions WHERE code_id = codes.id
                   ) WHERE id = (SELECT code_id FROM sessions WHERE id = ?)""", (session_id,))
        if _locked:
            _do()
        else:
            with self._lock, self._conn:
                _do()

    def get_code_usage(self, code_id: int) -> dict:
        row = self._conn.execute(
            "SELECT quota_min, used_sec, status FROM codes WHERE id = ?", (code_id,)).fetchone()
        if not row:
            return {"quota_min": 0, "used_sec": 0, "status": "unknown"}
        return {"quota_min": row["quota_min"], "used_sec": row["used_sec"], "status": row["status"]}

    def record_usage(self, session_id: int, code_id: int, duration_msec: int,
                     input_audio_tokens: float, output_audio_tokens: float,
                     output_text_tokens: float):
        """记录一条 UsageResponse 计量，并累计到会话聚合"""
        with self._lock, self._conn:
            self._conn.execute(
                """INSERT INTO usage_events (session_id, code_id, ts, duration_msec,
                   input_audio_tokens, output_audio_tokens, output_text_tokens)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (session_id, code_id, now_iso(), duration_msec,
                 input_audio_tokens, output_audio_tokens, output_text_tokens))
            self._conn.execute(
                """UPDATE sessions SET duration_msec = duration_msec + ?,
                   input_audio_tokens = input_audio_tokens + ?,
                   output_audio_tokens = output_audio_tokens + ?,
                   output_text_tokens = output_text_tokens + ?
                   WHERE id = ?""",
                (duration_msec, input_audio_tokens, output_audio_tokens,
                 output_text_tokens, session_id))

    # ---------- 报表 ----------

    def usage_summary(self, days: int = 30,
                        limit: Optional[int] = None,
                        offset: int = 0) -> list:
        """按访问码聚合用量（仅聚合近 N 天内有会话活动的码）"""
        sql = """SELECT c.id, c.code, c.applicant, c.department, c.topic, c.status,
                      c.quota_min, c.used_sec,
                      COALESCE(SUM(s.duration_msec), 0) AS duration_msec,
                      COALESCE(SUM(s.input_audio_tokens), 0) AS input_audio_tokens,
                      COALESCE(SUM(s.output_audio_tokens), 0) AS output_audio_tokens,
                      COALESCE(SUM(s.output_text_tokens), 0) AS output_text_tokens,
                      COUNT(s.id) AS session_count
               FROM codes c JOIN sessions s ON s.code_id = c.id
               WHERE s.started_at >= datetime('now', 'localtime', ?)
               GROUP BY c.id ORDER BY c.id DESC"""
        params = [f'-{days} days']
        if limit is not None and limit > 0:
            sql += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
        return self._conn.execute(sql, params).fetchall()

    def count_usage_codes(self, days: int = 30) -> int:
        """近 N 天内有会话活动的访问码数（用于分页，与 usage_summary 行数对应）"""
        return self._conn.execute(
            """SELECT COUNT(DISTINCT code_id) AS c FROM sessions
               WHERE started_at >= datetime('now', 'localtime', ?)""",
            (f'-{days} days',)).fetchone()["c"]

    def count_daily_usage(self, days: int = 30) -> int:
        """近 N 天内有会话记录的天数（用于分页，与 daily_usage 行数对应）"""
        return self._conn.execute(
            """SELECT COUNT(DISTINCT date(started_at)) AS c FROM sessions
               WHERE started_at >= datetime('now', 'localtime', ?)""",
            (f'-{days} days',)).fetchone()["c"]

    def daily_usage(self, days: int = 30,
                      limit: Optional[int] = None,
                      offset: int = 0) -> list:
        """按天聚合全部用量"""
        sql = """SELECT date(started_at) AS day,
                      COUNT(*) AS session_count,
                      COALESCE(SUM(duration_msec), 0) AS duration_msec,
                      COALESCE(SUM(input_audio_tokens), 0) AS input_audio_tokens,
                      COALESCE(SUM(output_audio_tokens), 0) AS output_audio_tokens,
                      COALESCE(SUM(output_text_tokens), 0) AS output_text_tokens
               FROM sessions
               WHERE started_at >= datetime('now', 'localtime', ?)
               GROUP BY date(started_at) ORDER BY day DESC"""
        params = [f'-{days} days']
        if limit is not None and limit > 0:
            sql += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
        return self._conn.execute(sql, params).fetchall()

    # ---------- 审计日志 ----------

    def list_audit(self, limit: int = 20, offset: int = 0) -> list:
        return self._conn.execute(
            "SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?",
            (limit, offset)).fetchall()

    def count_audit(self) -> int:
        return self._conn.execute("SELECT COUNT(*) AS c FROM audit_log").fetchone()["c"]

    def close(self):
        with self._lock:
            self._conn.close()
