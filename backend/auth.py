"""
鉴权工具：HMAC 签名 cookie（用户访问码 / 管理员两种登录态）
"""
import base64
import hashlib
import hmac
import json
import time
from typing import Optional

USER_COOKIE = "st_access"
ADMIN_COOKIE = "st_admin"
USER_COOKIE_MAX_AGE = 7 * 24 * 3600  # 用户登录态 7 天（访问码本身无结束限制）
ADMIN_COOKIE_MAX_AGE = 12 * 3600     # 管理员登录态 12 小时


class CookieSigner:
    """payload = base64(json).hmac_sha256(base64(json))"""

    def __init__(self, secret: str):
        self.secret = secret.encode("utf-8")

    def sign(self, payload: dict) -> str:
        body = base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).decode("ascii")
        sig = hmac.new(self.secret, body.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{body}.{sig}"

    def verify(self, token: str) -> Optional[dict]:
        try:
            body, sig = token.split(".", 1)
            expected = hmac.new(self.secret, body.encode("ascii"), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(sig, expected):
                return None
            payload = json.loads(base64.urlsafe_b64decode(body.encode("ascii")))
            if payload.get("exp") and time.time() > payload["exp"]:
                return None
            return payload
        except Exception:
            return None


def get_code_id_from_request(signer: CookieSigner, request) -> Optional[int]:
    """从请求 cookie 中解析访问码登录态，返回 code_id（不校验码的当前状态）"""
    token = request.cookies.get(USER_COOKIE)
    if not token:
        return None
    payload = signer.verify(token)
    if not payload or "cid" not in payload:
        return None
    return int(payload["cid"])


def is_admin(signer: CookieSigner, request) -> bool:
    token = request.cookies.get(ADMIN_COOKIE)
    if not token:
        return False
    payload = signer.verify(token)
    return bool(payload and payload.get("admin") is True)


def make_user_cookie(signer: CookieSigner, code_id: int, secure: bool = False) -> dict:
    token = signer.sign({"cid": code_id, "exp": int(time.time()) + USER_COOKIE_MAX_AGE})
    return {
        "key": USER_COOKIE,
        "value": token,
        "max_age": USER_COOKIE_MAX_AGE,
        "httponly": True,
        "samesite": "Lax",
        "secure": secure,
    }


def make_admin_cookie(signer: CookieSigner, secure: bool = False) -> dict:
    token = signer.sign({"admin": True, "exp": int(time.time()) + ADMIN_COOKIE_MAX_AGE})
    return {
        "key": ADMIN_COOKIE,
        "value": token,
        "max_age": ADMIN_COOKIE_MAX_AGE,
        "httponly": True,
        "samesite": "Lax",
        "secure": secure,
    }
