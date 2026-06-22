from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..config import TapdConfig


@dataclass
class TapdResult:
    ok: bool
    raw: Dict[str, Any]
    story_id: Optional[str] = None
    url: Optional[str] = None
    error: Optional[str] = None


class TapdAdapter:
    def __init__(self, config: TapdConfig, dry_run: bool = False):
        self.config = config
        self.dry_run = dry_run

    def create_story(
        self,
        title: str,
        owner: str,
        priority_label: str,
        due_date: str | None,
        description: str,
        parent_id: str | None = None,
    ) -> TapdResult:
        payload: Dict[str, Any] = {
            "workspace_id": self.config.workspace_id,
            "name": title,
            "entity_type": "stories",
            "workitem_type_id": self.config.workitem_type_id,
            "status": "planning",
            "owner": owner,
            "priority_label": priority_label,
            "description": description,
        }
        if due_date:
            payload["due"] = due_date
        if parent_id:
            payload["parent_id"] = parent_id
        if self.dry_run:
            fake_id = f"dry-{abs(hash(json.dumps(payload, ensure_ascii=False))) % 1000000000}"
            return TapdResult(
                ok=True,
                raw={"dry_run": True, "payload": payload, "data": {"Story": {"id": fake_id}}},
                story_id=fake_id,
                url=self.story_url(fake_id),
            )
        result = self._post("/stories?s=mcp", payload)
        story_id = self._extract_story_id(result.raw)
        if result.ok and story_id:
            result.story_id = story_id
            result.url = self.story_url(story_id)
        return result

    def update_story_status(self, story_id: str, status: str) -> TapdResult:
        payload = {
            "workspace_id": self.config.workspace_id,
            "id": story_id,
            "entity_type": "stories",
            "status": status,
        }
        if self.dry_run:
            return TapdResult(ok=True, raw={"dry_run": True, "payload": payload}, story_id=story_id, url=self.story_url(story_id))
        return self._post("/stories?s=mcp", payload)

    def update_story_due_date(self, story_id: str, due_date: str) -> TapdResult:
        payload = {
            "workspace_id": self.config.workspace_id,
            "id": story_id,
            "entity_type": "stories",
            "due": due_date,
        }
        if self.dry_run:
            return TapdResult(ok=True, raw={"dry_run": True, "payload": payload}, story_id=story_id, url=self.story_url(story_id))
        return self._post("/stories?s=mcp", payload)

    def story_url(self, story_id: str) -> str:
        return f"https://www.tapd.cn/{self.config.workspace_id}/prong/stories/view/{story_id}"

    def _post(self, path: str, payload: Dict[str, Any]) -> TapdResult:
        url = self.config.api_base.rstrip("/") + path
        req = Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.config.api_token}",
                "Content-Type": "application/json",
                "Via": "mcp",
            },
            method="POST",
        )
        try:
            resp = urlopen(req, timeout=60)
            raw = json.loads(resp.read().decode("utf-8"))
            return TapdResult(ok=True, raw=raw)
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            return TapdResult(ok=False, raw={"body": body}, error=f"HTTP {exc.code}: {body}")
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            return TapdResult(ok=False, raw={}, error=str(exc))

    def _extract_story_id(self, raw: Dict[str, Any]) -> Optional[str]:
        data = raw.get("data", {})
        if isinstance(data, dict):
            story = data.get("Story") or data.get("story") or data
            if isinstance(story, dict) and story.get("id"):
                return str(story["id"])
        return None
