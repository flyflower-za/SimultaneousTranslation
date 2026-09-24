"""应用上下文与请求侧公共工具"""
import logging
import secrets
import time

from backend.access_db import AccessDB
from backend.auth import CookieSigner
from backend.mailer import Mailer
from backend.minutes import MinutesService

logger = logging.getLogger(__name__)


class AppContext:
    """全局上下文：配置、数据库、签名器、邮件"""

    def __init__(self, config: dict, use_https: bool, db_path: str):
        self.config = config
        self.use_https = use_https

        security = config.get("security", {})
        secret = security.get("secret_key", "")
        if not secret:
            # 未配置则自动生成随机密钥（重启后已发的登录态会失效，建议正式配置固定值）
            secret = secrets.token_hex(32)
            logger.warning("security.secret_key 未配置，已自动生成随机密钥"
                           "（重启后登录态失效，建议在 config.json 中配置固定值）")
        self.signer = CookieSigner(secret)
        self.admin_password = security.get("admin_password", "")
        self.valid_before_start_min = int(security.get("code_valid_before_start_min", 120))
        # 新申请提醒收件人（配置后，有新申请自动发邮件通知管理员）
        self.admin_notify_emails = [e.strip() for e in
                                    security.get("admin_notify_emails", []) if e.strip()]
        self.pricing = config.get("pricing", {})
        self.db = AccessDB(db_path)
        self.minutes = MinutesService(self.db, config)
        self.mailer = Mailer(config.get("smtp", {}))
        # 访问码验证失败限速（防爆破）：ip -> 最近失败时间戳列表
        self._verify_failures = {}

    # ---------- 工具 ----------

    def set_cookie(self, resp, cookie_spec: dict):
        resp.set_cookie(cookie_spec["key"], cookie_spec["value"],
                        max_age=cookie_spec["max_age"], httponly=cookie_spec["httponly"],
                        samesite=cookie_spec["samesite"], secure=self.use_https)
        return resp

    def is_rate_limited(self, ip: str, limit: int = 10, window: int = 60) -> bool:
        now = time.time()
        hits = [t for t in self._verify_failures.get(ip, []) if now - t < window]
        if len(hits) >= limit:
            self._verify_failures[ip] = hits
            return True
        return False

    def record_failure(self, ip: str):
        self._verify_failures.setdefault(ip, []).append(time.time())
