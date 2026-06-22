from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import FeishuConfig
from ..models import Mention, SourceMessage, utc_now_iso

WORKING_REACTION_EMOJI_TYPE = "OnIt"


@dataclass
class SendResult:
    ok: bool
    raw: Dict[str, Any]
    chat_id: Optional[str] = None
    message_id: Optional[str] = None
    file_token: Optional[str] = None
    url: Optional[str] = None
    error: Optional[str] = None
    warning: Optional[str] = None


class FeishuEventParser:
    def __init__(self, bot_open_id: str, known_names: Dict[str, str] | None = None):
        self.bot_open_id = bot_open_id
        self.known_names = known_names or {}

    def parse(self, payload: Dict[str, Any]) -> Optional[SourceMessage]:
        event = payload.get("event", {})
        message = event.get("message", {})
        sender = event.get("sender", {})
        if not message:
            return None

        message_id = message.get("message_id") or message.get("message_id_v2") or message.get("root_id") or utc_now_iso()
        chat_id = message.get("chat_id", "")
        chat_type = message.get("chat_type", "private")
        message_type = message.get("message_type", "text")
        sender_open_id = sender.get("sender_id", {}).get("open_id", "")
        sender_name = self.known_names.get(sender_open_id, sender_open_id or "unknown")
        text = self._extract_text(message.get("content", ""))
        mentions = [self._parse_mention(item) for item in message.get("mentions", [])]
        mentions = [item for item in mentions if item.open_id]
        return SourceMessage(
            id=message_id,
            chat_id=chat_id,
            chat_type=chat_type,
            sender_open_id=sender_open_id,
            sender_name=sender_name,
            text=text,
            message_type=message_type,
            sent_at=message.get("create_time") or utc_now_iso(),
            raw_payload=payload,
            mentions=mentions,
            parent_id=message.get("parent_id"),
            root_id=message.get("root_id"),
        )

    def _extract_text(self, content: str) -> str:
        if not content:
            return ""
        try:
            parsed = json.loads(content)
        except json.JSONDecodeError:
            return content
        return parsed.get("text") or parsed.get("title") or content

    def _parse_mention(self, raw: Dict[str, Any]) -> Mention:
        mention_id = raw.get("id", {})
        open_id = raw.get("open_id") or mention_id.get("open_id") or raw.get("user_id", "")
        name = raw.get("name") or raw.get("key") or self.known_names.get(open_id, open_id)
        return Mention(open_id=open_id, name=name)


class FeishuAdapter:
    def __init__(self, config: FeishuConfig, dry_run: bool = False):
        self.config = config
        self.dry_run = dry_run

    def send_group_text(self, text: str, chat_id: str | None = None) -> SendResult:
        target = chat_id or self.config.group_chat_id
        return self._send(["--chat-id", target], text)

    def send_private_text(self, open_id: str, text: str) -> SendResult:
        return self._send(["--user-id", open_id], text)

    def send_reply_text(self, message_id: str, text: str) -> SendResult:
        if not message_id:
            return SendResult(ok=False, raw={}, error="message_id is required for reply")
        return self._send_reply(message_id, text)

    def upload_file(self, file_path: str) -> SendResult:
        if self.dry_run:
            return SendResult(ok=True, raw={"dry_run": True, "file_path": file_path}, url=file_path)
        path = Path(file_path).expanduser().resolve()
        try:
            proc = subprocess.run(
                [self.config.lark_cli_path, "drive", "+upload", "--as", "bot", "--file", f"./{path.name}"],
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
                cwd=str(path.parent),
            )
        except Exception as exc:
            return SendResult(ok=False, raw={}, error=str(exc))
        return self._result_from_process(proc)

    def publish_file(self, file_path: str, share_link_entity: str = "tenant_readable") -> SendResult:
        upload = self.upload_file(file_path)
        if not upload.ok:
            return upload
        if self.dry_run or not upload.file_token:
            return upload

        permission = self._set_public_permission(upload.file_token, share_link_entity)
        if permission.ok:
            return SendResult(
                ok=True,
                raw={"upload": upload.raw, "permission": permission.raw},
                file_token=upload.file_token,
                url=upload.url,
            )

        return SendResult(
            ok=True,
            raw={"upload": upload.raw, "permission": permission.raw},
            file_token=upload.file_token,
            url=upload.url,
            warning=self._permission_warning(permission),
        )

    def _send(self, target_args: List[str], text: str) -> SendResult:
        if self.dry_run:
            raw = {"dry_run": True, "target": target_args, "text": text}
            return SendResult(ok=True, raw=raw, chat_id=None)
        cmd = [
            self.config.lark_cli_path,
            "im",
            "+messages-send",
            "--as",
            "bot",
            *target_args,
            "--msg-type",
            "text",
            "--text",
            text,
        ]
        try:
            proc = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=60)
        except Exception as exc:
            return SendResult(ok=False, raw={}, error=str(exc))
        return self._result_from_process(proc)

    def _send_reply(self, message_id: str, text: str) -> SendResult:
        if self.dry_run:
            raw = {"dry_run": True, "reply_to": message_id, "text": text}
            return SendResult(ok=True, raw=raw, chat_id=None)
        cmd = [
            self.config.lark_cli_path,
            "im",
            "+messages-reply",
            "--as",
            "bot",
            "--message-id",
            message_id,
            "--msg-type",
            "text",
            "--text",
            text,
        ]
        try:
            proc = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=60)
        except Exception as exc:
            return SendResult(ok=False, raw={}, error=str(exc))
        return self._result_from_process(proc)

    def add_reaction(self, message_id: str, emoji_type: str = WORKING_REACTION_EMOJI_TYPE) -> Optional[str]:
        if self.dry_run or not message_id:
            return None
        cmd = [
            self.config.lark_cli_path,
            "im", "reactions", "create",
            "--as", "bot",
            "--message-id", message_id,
            "--data", json.dumps({"reaction_type": {"emoji_type": emoji_type}}),
        ]
        try:
            proc = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=10)
            if proc.returncode == 0:
                raw = self._parse_json_output(proc.stdout)
                return raw.get("data", {}).get("reaction_id") or raw.get("reaction_id")
        except Exception:
            pass
        return None

    def remove_reaction(self, message_id: str, reaction_id: str) -> None:
        if self.dry_run or not message_id or not reaction_id:
            return
        cmd = [
            self.config.lark_cli_path,
            "im", "reactions", "delete",
            "--as", "bot",
            "--message-id", message_id,
            "--reaction-id", reaction_id,
        ]
        try:
            subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=10)
        except Exception:
            pass

    def _set_public_permission(self, file_token: str, share_link_entity: str) -> SendResult:
        if self.dry_run:
            return SendResult(ok=True, raw={"dry_run": True, "file_token": file_token, "share_link_entity": share_link_entity})
        data = json.dumps(
            {
                "link_share_entity": share_link_entity,
                "external_access": False,
                "invite_external": False,
                "share_entity": "same_tenant",
                "security_entity": "anyone_can_view",
            },
            ensure_ascii=False,
        )
        cmd = [
            self.config.lark_cli_path,
            "drive",
            "permission.public",
            "patch",
            "--as",
            "bot",
            "--token",
            file_token,
            "--type",
            "file",
            "--data",
            data,
            "--yes",
        ]
        try:
            proc = subprocess.run(cmd, check=False, capture_output=True, text=True, timeout=60)
        except Exception as exc:
            return SendResult(ok=False, raw={}, error=str(exc))
        return self._result_from_process(proc)

    def _result_from_process(self, proc: subprocess.CompletedProcess[str]) -> SendResult:
        raw: Dict[str, Any] = {}
        if proc.stdout.strip():
            raw = self._parse_json_output(proc.stdout)
        chat_id, message_id, file_token, url = self._extract_result_fields(raw)
        if proc.returncode != 0:
            return SendResult(ok=False, raw=raw, chat_id=chat_id, message_id=message_id, file_token=file_token, url=url, error=proc.stderr.strip() or proc.stdout.strip())
        return SendResult(ok=True, raw=raw, chat_id=chat_id, message_id=message_id, file_token=file_token, url=url)

    def _parse_json_output(self, stdout: str) -> Dict[str, Any]:
        text = stdout.strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass

        start = text.find("{")
        if start >= 0:
            candidate = text[start:]
            try:
                return json.loads(candidate)
            except json.JSONDecodeError:
                pass
        return {"stdout": stdout}

    def _extract_result_fields(self, raw: Dict[str, Any]) -> tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
        scopes: List[Dict[str, Any]] = []
        data = raw.get("data")
        if isinstance(data, dict):
            scopes.append(data)
        scopes.append(raw)

        chat_id = self._first_value(scopes, ["chat_id"])
        message_id = self._first_value(scopes, ["message_id"])
        file_token = self._first_value(scopes, ["file_token", "token"])
        url = self._first_value(scopes, ["url", "file_url", "link"])
        return chat_id, message_id, file_token, url

    def _first_value(self, scopes: List[Dict[str, Any]], keys: List[str]) -> Optional[str]:
        for scope in scopes:
            for key in keys:
                value = scope.get(key)
                if isinstance(value, str) and value:
                    return value
            for nested_key in ("file", "item", "document"):
                nested = scope.get(nested_key)
                if isinstance(nested, dict):
                    nested_value = self._first_value([nested], keys)
                    if nested_value:
                        return nested_value
        return None

    def _permission_warning(self, result: SendResult) -> str:
        error = result.raw.get("error", {}) if isinstance(result.raw, dict) else {}
        missing_scopes = error.get("missing_scopes") or []
        if missing_scopes:
            scopes = "、".join(missing_scopes)
            return f"已上传看板文件，但未能设置共享权限。请在飞书开放平台为应用开通：{scopes}"
        return "已上传看板文件，但未能设置共享权限。"

    def explain_error(self, result: SendResult) -> str:
        error = result.raw.get("error", {}) if isinstance(result.raw, dict) else {}
        missing_scopes = error.get("missing_scopes") or []
        if missing_scopes:
            scopes = "、".join(missing_scopes)
            return f"请在飞书开放平台为应用开通以下权限：{scopes}"
        message = error.get("message")
        if message:
            return str(message)
        if result.error:
            return result.error.splitlines()[-1]
        return "未知错误"
