"""
邮件发送（SMTP）。发送在线程池执行，失败不阻塞审批流程。
"""
import asyncio
import logging
import smtplib
from datetime import datetime
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr

logger = logging.getLogger(__name__)


class Mailer:
    def __init__(self, smtp_config: dict):
        self.enabled = bool(smtp_config.get("enabled"))
        self.host = smtp_config.get("host", "")
        self.port = int(smtp_config.get("port", 25))
        self.username = smtp_config.get("username", "")
        self.password = smtp_config.get("password", "")
        self.use_tls = bool(smtp_config.get("use_tls", False))
        # 发件人：未配置时兜底（匿名内部邮件服务器场景 username 也为空）
        self.from_addr = smtp_config.get("from_addr") or self.username or "ast-noreply@localhost"

    def _send_sync(self, to_addr: str, subject: str, body: str):
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = Header(subject, "utf-8")
        msg["From"] = formataddr(("同声传译系统", self.from_addr))
        msg["To"] = to_addr

        # 连接方式：465 走 SSL，其余端口直连（内部匿名中继常用 25 明文，use_tls=true 时尝试 STARTTLS）
        if self.use_tls and self.port == 465:
            server = smtplib.SMTP_SSL(self.host, self.port, timeout=15)
        else:
            server = smtplib.SMTP(self.host, self.port, timeout=15)
        try:
            if self.use_tls and self.port != 465:
                server.starttls()
            # 匿名模式：username 留空则不做 LOGIN，适配无鉴权的内部邮件中继
            if self.username:
                server.login(self.username, self.password)
            server.sendmail(self.from_addr, [to_addr], msg.as_string())
        finally:
            try:
                server.quit()
            except Exception:
                pass

    async def send(self, to_addr: str, subject: str, body: str) -> bool:
        """异步发送。返回是否成功。未配置 SMTP 时返回 False 并记录日志。"""
        if not self.enabled or not self.host:
            logger.warning(f"SMTP 未配置，无法发送邮件到 {to_addr}（主题: {subject}）")
            return False
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self._send_sync, to_addr, subject, body)
            logger.info(f"邮件已发送: {to_addr}（{subject}）")
            return True
        except Exception as e:
            logger.error(f"发送邮件失败（{to_addr}）: {e}")
            return False

    async def send_access_code(self, to_addr: str, applicant: str, code: str,
                               base_url: str, valid_from: str, quota_min: int) -> bool:
        valid_from_str = ""
        try:
            valid_from_str = datetime.fromisoformat(valid_from).strftime("%m月%d日 %H:%M")
        except Exception:
            valid_from_str = valid_from
        body = f"""{applicant}，你好：

你的同声传译系统使用申请已审批通过。

访问码：{code}
使用入口：{base_url}
生效时间：{valid_from_str} 起（结束时间不限制）
预计时长：{quota_min} 分钟（仅作参考，不做限制）

使用方法：打开使用入口，输入访问码即可进入控制端页面。
查看端（观众大屏）入口：{base_url}/viewer

如有问题请联系系统管理员。"""
        return await self.send(to_addr, "【同声传译系统】访问码审批通过", body)

    async def send_new_request_notify(self, notify_addrs: list, request_id: int,
                                      applicant: str, email: str, department: str,
                                      topic: str, planned_start: str,
                                      duration_min: int, admin_url: str) -> bool:
        """新申请到达时提醒管理员（发给多个收件人，任一失败不影响其他）"""
        subject = f"【同声传译系统】新使用申请 #{request_id}：{applicant}"
        body = f"""收到新的同声传译系统使用申请，请及时审批：

申请编号：#{request_id}
申请人：{applicant}（{email}）
部门：{department or '-'}
使用主题：{topic or '-'}
计划使用时间：{planned_start}
预计时长：{duration_min} 分钟

审批入口：{admin_url}

本邮件由系统自动发送。"""
        sent_all = True
        for addr in notify_addrs:
            if not await self.send(addr, subject, body):
                sent_all = False
        return sent_all
