from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any, Dict, List
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..config import AIConfig


@dataclass
class LLMResult:
    ok: bool
    content: str = ""
    raw: Dict[str, Any] | None = None
    error: str | None = None


class LLMAdapter:
    def __init__(self, config: AIConfig, dry_run: bool = False):
        self.config = config
        self.dry_run = dry_run

    def chat(self, system_prompt: str, user_message: str) -> LLMResult:
        if self.dry_run or not self.config.api_key:
            return LLMResult(ok=True, content="", raw={"dry_run": True})
        payload = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
        }
        req = Request(
            self.config.api_base.rstrip("/") + "/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.config.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        attempts = max(1, int(getattr(self.config, "retry_count", 1)) + 1)
        last_error = ""
        for attempt in range(attempts):
            try:
                resp = urlopen(req, timeout=120)
                raw = json.loads(resp.read().decode("utf-8"))
                content = raw["choices"][0]["message"]["content"]
                return LLMResult(ok=True, content=content, raw=raw)
            except HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                last_error = f"HTTP {exc.code}: {body}"
                if exc.code < 500 or attempt == attempts - 1:
                    return LLMResult(ok=False, error=last_error)
            except (URLError, TimeoutError, KeyError, json.JSONDecodeError) as exc:
                last_error = str(exc)
                if attempt == attempts - 1:
                    return LLMResult(ok=False, error=last_error)
            time.sleep(min(2 ** attempt, 5))
        return LLMResult(ok=False, error=last_error or "llm_error")

    def summarize(self, items: List[Dict[str, Any]], task: str) -> LLMResult:
        system = "你是研发交付中台的摘要助手。只输出可直接发送到飞书群的中文纯文本。"
        user = json.dumps({"task": task, "items": items}, ensure_ascii=False)
        return self.chat(system, user)
