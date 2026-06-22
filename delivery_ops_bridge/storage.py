from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .models import (
    BotMessageContext,
    DailySummary,
    DashboardArtifact,
    SourceMessage,
    Standup,
    Task,
    TaskUpdate,
    to_dict,
)


class JsonStore:
    """Small file-backed store for v0.1 single-team deployments."""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        for subdir in [
            "messages",
            "tasks",
            "updates",
            "standups",
            "summaries",
            "dashboards",
            "logs",
            "contexts",
        ]:
            (self.data_dir / subdir).mkdir(parents=True, exist_ok=True)
        self._idempotency_path = self.data_dir / "idempotency.json"
        self._chat_ids_path = self.data_dir / "chat_ids.json"
        self._ensure_json(self._idempotency_path, {})
        self._ensure_json(self._chat_ids_path, {})

    def _ensure_json(self, path: Path, default: Any) -> None:
        if not path.exists():
            self._write_json(path, default)

    def _write_json(self, path: Path, value: Any) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as fp:
            json.dump(value, fp, ensure_ascii=False, indent=2)
            fp.write("\n")
        os.replace(tmp, path)

    def _read_json(self, path: Path, default: Any) -> Any:
        if not path.exists():
            return default
        with path.open("r", encoding="utf-8") as fp:
            return json.load(fp)

    def has_idempotency_key(self, key: str) -> bool:
        data = self._read_json(self._idempotency_path, {})
        return key in data

    def set_idempotency_key(self, key: str, value: Dict[str, Any]) -> None:
        data = self._read_json(self._idempotency_path, {})
        data[key] = value
        self._write_json(self._idempotency_path, data)

    def save_source_message(self, message: SourceMessage) -> None:
        self._write_json(self.data_dir / "messages" / f"{message.id}.json", to_dict(message))

    def get_source_message(self, message_id: str | None) -> Optional[Dict[str, Any]]:
        if not message_id:
            return None
        path = self.data_dir / "messages" / f"{message_id}.json"
        if not path.exists():
            return None
        return self._read_json(path, None)

    def list_source_messages(self) -> List[Dict[str, Any]]:
        return self._list_json("messages")

    def save_task(self, task: Task) -> None:
        self._write_json(self.data_dir / "tasks" / f"{task.id}.json", to_dict(task))

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        path = self.data_dir / "tasks" / f"{task_id}.json"
        if not path.exists():
            return None
        return self._read_json(path, None)

    def find_task(self, identifier: str) -> Optional[Dict[str, Any]]:
        cleaned = identifier.strip()
        for task in self.list_tasks():
            if task.get("id") == cleaned or task.get("tapd_story_id") == cleaned:
                return task
        return None

    def list_tasks(self) -> List[Dict[str, Any]]:
        return self._list_json("tasks")

    def save_task_update(self, update: TaskUpdate) -> None:
        self._write_json(self.data_dir / "updates" / f"{update.id}.json", to_dict(update))

    def list_task_updates(self, task_id: str | None = None) -> List[Dict[str, Any]]:
        updates = self._list_json("updates")
        if task_id:
            updates = [item for item in updates if item.get("task_id") == task_id]
        return updates

    def save_standup(self, standup: Standup) -> None:
        path = self.data_dir / "standups" / standup.date / f"{standup.open_id}.json"
        self._write_json(path, to_dict(standup))

    def list_standups(self, date: str) -> List[Dict[str, Any]]:
        path = self.data_dir / "standups" / date
        if not path.exists():
            return []
        return sorted(
            [self._read_json(item, {}) for item in path.glob("*.json")],
            key=lambda item: item.get("user_name", ""),
        )

    def save_daily_summary(self, summary: DailySummary) -> None:
        self._write_json(self.data_dir / "summaries" / f"{summary.date}.json", to_dict(summary))

    def save_dashboard_artifact(self, artifact: DashboardArtifact) -> None:
        self._write_json(self.data_dir / "dashboards" / f"artifact-{artifact.date}.json", to_dict(artifact))

    def save_bot_message_context(self, context: BotMessageContext) -> None:
        self._write_json(self.data_dir / "contexts" / f"{context.message_id}.json", to_dict(context))

    def get_bot_message_context(self, message_id: str | None) -> Optional[Dict[str, Any]]:
        if not message_id:
            return None
        path = self.data_dir / "contexts" / f"{message_id}.json"
        if not path.exists():
            return None
        return self._read_json(path, None)

    def list_bot_message_contexts(self) -> List[Dict[str, Any]]:
        return self._list_json("contexts")

    def update_chat_id(self, open_id: str, chat_id: str) -> None:
        data = self._read_json(self._chat_ids_path, {})
        data[open_id] = chat_id
        self._write_json(self._chat_ids_path, data)

    def open_id_for_chat_id(self, chat_id: str) -> Optional[str]:
        data = self._read_json(self._chat_ids_path, {})
        for open_id, cached_chat_id in data.items():
            if cached_chat_id == chat_id:
                return open_id
        return None

    def append_audit_log(self, event_type: str, payload: Dict[str, Any]) -> None:
        from datetime import datetime
        path = self.data_dir / "logs" / "audit.jsonl"
        with path.open("a", encoding="utf-8") as fp:
            log_entry = {
                "timestamp": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
                "event_type": event_type,
                "payload": payload
            }
            fp.write(json.dumps(log_entry, ensure_ascii=False) + "\n")

    def _list_json(self, subdir: str) -> List[Dict[str, Any]]:
        root = self.data_dir / subdir
        if not root.exists():
            return []
        values: List[Dict[str, Any]] = []
        for path in sorted(root.glob("*.json")):
            values.append(self._read_json(path, {}))
        return values
