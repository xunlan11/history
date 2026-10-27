"""问渠共享鉴权 SDK（Python 版）。

与 lib/node 等价：读取 ``wenqu_session`` Cookie → 查 sessions/accounts → 返回账号。
只读账号库与会话库，不依赖 SSO 服务在线。依赖 psycopg（>=3）。

供 history / literature 等 FastAPI 站点在 Phase 3 接入时复用。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any, Callable, Optional

import psycopg
from psycopg.rows import dict_row

DEFAULT_COOKIE_NAME = "wenqu_session"
_PREFIX = "wenqu-svc-v1"

_ACCOUNT_SQL = """
SELECT a.* FROM sessions s
  JOIN accounts a ON a.id = s.account_id
 WHERE s.token_hash = %s
   AND s.revoked_at IS NULL
   AND s.expires_at > now()
   AND a.deleted_at IS NULL
   AND a.disabled_at IS NULL
"""


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _public_account(row: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if not row:
        return None
    return {
        "id": str(row["id"]),
        "username": row["username"],
        "nickname": row["nickname"],
        "isSsoAdmin": row["is_sso_admin"],
        "disabled": row["disabled_at"] is not None,
        "deleted": row["deleted_at"] is not None,
        "mustChangePassword": row["must_change_password"],
    }


def resolve_account(cookie_value: Optional[str], conn: psycopg.Connection) -> Optional[dict[str, Any]]:
    token = (cookie_value or "").strip()
    if not token:
        return None
    row = conn.execute(_ACCOUNT_SQL, (token_hash(token),)).fetchone()
    return _public_account(row)


def resolve_session(
    cookie_value: Optional[str],
    conn: psycopg.Connection,
    get_local: Optional[Callable[[str], Optional[dict[str, Any]]]] = None,
) -> Optional[dict[str, Any]]:
    """返回 ``{"account": ..., "role": ..., "profile": ...}`` 或 None。

    ``get_local(account_id)`` 由模块提供：读取模块本地角色/资料（含首次访问懒建行）。
    """
    account = resolve_account(cookie_value, conn)
    if account is None:
        return None
    role = profile = None
    if get_local is not None:
        local = get_local(account["id"]) or {}
        role = local.get("role")
        profile = local.get("profile")
    return {"account": account, "role": role, "profile": profile}


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_service_token(
    header_value: Optional[str],
    secret: str,
    now: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    """验证 SSO 签发的服务令牌（模块超管管理接口用）。无效/过期返回 None。"""
    if not secret:
        return None
    now = int(time.time()) if now is None else now
    parts = (header_value or "").strip().split(".")
    if len(parts) != 3 or parts[0] != _PREFIX:
        return None
    _, body, provided_sig = parts
    expected_sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    if not hmac.compare_digest(provided_sig, expected_sig):
        return None
    try:
        payload = json.loads(_b64url_decode(body))
        if not isinstance(payload, dict):
            return None
        iat, exp = payload.get("iat"), payload.get("exp")
        if not isinstance(iat, (int, float)) or not isinstance(exp, (int, float)):
            return None
        if exp < now or iat > now + 60:
            return None
        return payload
    except (ValueError, KeyError):
        return None


class SsoResolver:
    """持有 dsn 的便捷解析器；每次解析开启短连接，适合低频调用。

    高并发站点建议自行维护 psycopg 连接池，复用上面的 ``resolve_account`` /
    ``resolve_session`` 函数。
    """

    def __init__(self, dsn: str, cookie_name: str = DEFAULT_COOKIE_NAME):
        self.dsn = dsn
        self.cookie_name = cookie_name

    def resolve_account(self, cookie_value: Optional[str]) -> Optional[dict[str, Any]]:
        with psycopg.connect(self.dsn, row_factory=dict_row) as conn:
            return resolve_account(cookie_value, conn)

    def resolve_session(
        self,
        cookie_value: Optional[str],
        get_local: Optional[Callable[[str], Optional[dict[str, Any]]]] = None,
    ) -> Optional[dict[str, Any]]:
        with psycopg.connect(self.dsn, row_factory=dict_row) as conn:
            return resolve_session(cookie_value, conn, get_local)
